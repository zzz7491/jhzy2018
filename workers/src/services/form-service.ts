/**
 * FormService（S2-NEW-ARCH-P20）—— 通用动态表单引擎 use-case。
 *
 * 分层（用户 §十八）：route（HTTP/校验）→ authorization（middleware 权限裁决）
 *   → service（业务不变式 + 权威解析 + SELF/TEAM ownership）→ repository（SQL + 租户范围）。
 *
 * P20 REV2 冻结要点：
 * - 权威提交链 = consumer → active binding → definition → published_version_id；
 *   客户端不得决定 definition；version_public_id 仅 stale-check → 409 form_version_stale。
 * - allow_repeat = definition 当前策略（metadata，非 version snapshot）；grain = definition+submitter+consumer_key。
 * - non-repeat 守卫 = 原子 INSERT…SELECT…WHERE NOT EXISTS(active submitted)；0 行后重读分类。
 * - draft 禁止自动升级 version：PATCH/final 若 version != 当前 published → 409 form_version_stale。
 * - 视图只出 public_id，绝不输出内部 id。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import {
  FormEngineRepository,
  type FormDefinitionRow,
  type FormVersionRow,
  type FormSubmissionRow,
  type FormBindingRow,
  FORM_DEF_STATUS,
  FORM_SUBMISSION_STATUS,
  FORM_CONSUME_POLICY,
} from '../repository/form-engine';
import {
  authRequired,
  conflict,
  notFound,
  internalError,
  invalidParam,
  notFoundReason,
  ConflictReason,
} from '../utils/errors';
import { isUlid } from '../utils/validation';
import { generateUlid } from '../utils/crypto';

// ===== 对外视图（public_id only）=====

export interface FormFieldDef {
  key: string;
  label: string;
  type: string;
  required: boolean;
  order: number;
  help_text?: string;
  placeholder?: string;
  read_only?: boolean;
  options?: { value: string; label: string }[];
  validation?: { min?: number; max?: number; pattern?: string; min_select?: number; max_select?: number };
}

export interface FormVersionView {
  public_id: string;
  version_no: number;
  status: number;
  published_at: number | null;
  fields: FormFieldDef[];
}

export interface FormDefinitionView {
  public_id: string;
  name: string;
  description: string | null;
  status: number;
  allow_repeat: boolean;
  published_version_id: string | null;
  draft_version_id: string | null;
  created_at: number;
  updated_at: number | null;
}

export interface FormBindingView {
  public_id: string;
  definition_public_id: string;
  consumer_type: string;
  consumer_public_id: string | null;
  is_default: boolean;
  consume_policy: number; // 0 none / 1 optional / 2 required（P21）
  status: number;
}

export interface FormSubmissionView {
  public_id: string;
  definition_public_id: string;
  version_public_id: string;
  status: number;
  consumer_type: string;
  consumer_public_id: string | null;
  answers: Record<string, unknown>;
  created_at: number;
  updated_at: number | null;
  submitted_at: number | null;
}

export interface ConsumerFormView {
  definition_public_id: string;
  version_public_id: string;
  fields: FormFieldDef[];
}

export interface DefinitionDraftResult {
  version: FormVersionView;
  created: boolean;
}

export interface BindingCreateResult {
  binding: FormBindingView;
  created: boolean;
}

export interface SubmissionResult {
  submission: FormSubmissionView;
  created: boolean;
}

const ALLOWED_FIELD_TYPES = new Set([
  'text', 'textarea', 'number', 'single_select', 'multi_select', 'boolean',
  'date', 'date_time', 'phone', 'email', 'id_text',
]);
const KEY_RE = /^[a-z0-9_]{1,64}$/;
const PHONE_RE = /^1[3-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ANSWERS_BYTES = 64 * 1024;
const CONSUMER_TYPES = new Set(['activity.signup']);

export interface FormServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
}

export class FormService {
  private readonly db: D1Database;
  private readonly auth: AuthContext;
  private readonly tenant: TenantContext;

  constructor(deps: FormServiceDeps) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.tenant = deps.tenant;
  }

  private requireActor(): { userId: number; teamId: number } {
    const auth = this.auth;
    const teamId = this.tenant.teamId;
    if (!auth.authenticated || auth.userId == null) throw authRequired();
    if (teamId == null) throw authRequired();
    return { userId: auth.userId, teamId };
  }

  private repos() {
    const ctx = { auth: this.auth, tenant: this.tenant };
    return { forms: new FormEngineRepository({ db: this.db, ctx }) };
  }

  // ================= schema 校验 =================

  /** 校验并规范化字段定义（拒绝 file/image、拒绝未知字段键）。 */
  validateFields(fields: unknown): FormFieldDef[] {
    if (!Array.isArray(fields) || fields.length > 200) {
      throw invalidParam('fields', 'must be an array of at most 200 fields');
    }
    const seen = new Set<string>();
    return fields.map((raw, i) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw invalidParam('fields', `fields[${i}] must be an object`);
      }
      const f = raw as Record<string, unknown>;
      const key = f.key;
      if (typeof key !== 'string' || !KEY_RE.test(key)) {
        throw invalidParam('fields', `fields[${i}].key invalid (lowercase [a-z0-9_] 1-64)`);
      }
      if (seen.has(key)) throw invalidParam('fields', `fields[${i}].key duplicated: ${key}`);
      seen.add(key);
      const label = f.label;
      if (typeof label !== 'string' || label.length === 0 || label.length > 120) {
        throw invalidParam('fields', `fields[${i}].label invalid`);
      }
      const type = f.type;
      if (typeof type !== 'string' || !ALLOWED_FIELD_TYPES.has(type)) {
        throw invalidParam('fields', `fields[${i}].type unsupported: ${String(type)}`);
      }
      for (const k of Object.keys(f)) {
        if (!['key', 'label', 'type', 'required', 'order', 'help_text', 'placeholder', 'read_only', 'options', 'validation'].includes(k)) {
          throw invalidParam('fields', `fields[${i}].${k} not allowed`);
        }
      }
      const field: FormFieldDef = {
        key,
        label,
        type,
        required: f.required === true,
        order: typeof f.order === 'number' && Number.isFinite(f.order) ? f.order : i,
      };
      if (typeof f.help_text === 'string') field.help_text = f.help_text;
      if (typeof f.placeholder === 'string') field.placeholder = f.placeholder;
      if (f.read_only === true) field.read_only = true;

      if (type === 'single_select' || type === 'multi_select') {
        const opts = f.options;
        if (!Array.isArray(opts) || opts.length === 0) {
          throw invalidParam('fields', `fields[${i}].options required for ${type}`);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const values = opts.map((o: any, j: number) => {
          if (o === null || typeof o !== 'object' || typeof o.value !== 'string' || typeof o.label !== 'string') {
            throw invalidParam('fields', `fields[${i}].options[${j}] invalid`);
          }
          return { value: o.value, label: o.label };
        });
        const dup = values.map((v) => v.value).some((v, idx, arr) => arr.indexOf(v) !== idx);
        if (dup) throw invalidParam('fields', `fields[${i}].options values must be unique`);
        field.options = values;
        const v = f.validation;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const mv = v as Record<string, unknown>;
          if (mv.min_select !== undefined) field.validation = { ...(field.validation ?? {}), min_select: Number(mv.min_select) };
          if (mv.max_select !== undefined) field.validation = { ...(field.validation ?? {}), max_select: Number(mv.max_select) };
        }
      } else {
        const v = f.validation;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const mv = v as Record<string, unknown>;
          const merged: FormFieldDef['validation'] = {};
          if (mv.min !== undefined) merged.min = Number(mv.min);
          if (mv.max !== undefined) merged.max = Number(mv.max);
          if (typeof mv.pattern === 'string') {
            try {
              new RegExp(mv.pattern);
            } catch {
              throw invalidParam('fields', `fields[${i}].validation.pattern not a valid regex`);
            }
            merged.pattern = mv.pattern;
          }
          if (Object.keys(merged).length) field.validation = merged;
        }
      }
      return field;
    });
  }

  /** 校验answers（draft 允许部分必填；final 严格必填）。未知 key 一律拒绝。 */
  validateAnswers(schema: FormFieldDef[], answers: unknown, { strictRequired }: { strictRequired: boolean }): Record<string, unknown> {
    if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
      throw invalidParam('answers', 'must be an object');
    }
    const size = JSON.stringify(answers).length;
    if (size > MAX_ANSWERS_BYTES) throw invalidParam('answers', 'payload too large (max 64KB)');

    const out: Record<string, unknown> = {};
    const byKey = new Map(schema.map((f) => [f.key, f]));
    for (const [k, v] of Object.entries(answers as Record<string, unknown>)) {
      const f = byKey.get(k);
      if (!f) throw invalidParam('answers', `unknown field: ${k}`);
      out[k] = this.validateValue(f, v);
    }
    for (const f of schema) {
      if (f.required && strictRequired) {
        const present = Object.prototype.hasOwnProperty.call(out, f.key);
        const v = out[f.key];
        const emptyMulti = Array.isArray(v) && v.length === 0;
        const emptyScalar = (typeof v === 'string' && v.length === 0) || v === null || v === undefined;
        if (!present || emptyMulti || emptyScalar) {
          throw invalidParam('answers', `required field missing: ${f.key}`);
        }
      }
    }
    return out;
  }

  private validateValue(f: FormFieldDef, v: unknown): unknown {
    const empty = v === undefined || v === null || (typeof v === 'string' && v.length === 0);
    if (empty) return undefined;
    switch (f.type) {
      case 'text':
      case 'textarea':
      case 'id_text': {
        if (typeof v !== 'string') throw invalidParam('answers', `field ${f.key} must be a string`);
        const cap = f.type === 'textarea' ? 20000 : f.type === 'text' ? 4000 : 64;
        if (v.length > cap) throw invalidParam('answers', `field ${f.key} too long`);
        if (f.validation?.pattern) {
          try {
            if (!new RegExp(f.validation.pattern).test(v)) throw invalidParam('answers', `field ${f.key} pattern mismatch`);
          } catch {
            throw invalidParam('answers', `field ${f.key} pattern invalid`);
          }
        }
        return v;
      }
      case 'number': {
        if (typeof v !== 'number' || !Number.isFinite(v)) throw invalidParam('answers', `field ${f.key} must be a number`);
        if (f.validation?.min !== undefined && v < f.validation.min) throw invalidParam('answers', `field ${f.key} below min`);
        if (f.validation?.max !== undefined && v > f.validation.max) throw invalidParam('answers', `field ${f.key} above max`);
        return v;
      }
      case 'boolean':
        if (typeof v !== 'boolean') throw invalidParam('answers', `field ${f.key} must be boolean`);
        return v;
      case 'single_select': {
        if (typeof v !== 'string') throw invalidParam('answers', `field ${f.key} must be a string`);
        const ok = (f.options ?? []).some((o) => o.value === v);
        if (!ok) throw invalidParam('answers', `field ${f.key} invalid option`);
        return v;
      }
      case 'multi_select': {
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
          throw invalidParam('answers', `field ${f.key} must be an array of strings`);
        }
        const all = new Set(f.options?.map((o) => o.value) ?? []);
        for (const x of v) if (!all.has(x)) throw invalidParam('answers', `field ${f.key} invalid option`);
        if (f.validation?.min_select !== undefined && v.length < f.validation.min_select) {
          throw invalidParam('answers', `field ${f.key} below min_select`);
        }
        if (f.validation?.max_select !== undefined && v.length > f.validation.max_select) {
          throw invalidParam('answers', `field ${f.key} above max_select`);
        }
        return v;
      }
      case 'date':
        if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
          throw invalidParam('answers', `field ${f.key} must be YYYY-MM-DD`);
        }
        return v;
      case 'date_time':
        if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
          throw invalidParam('answers', `field ${f.key} must be a parseable datetime`);
        }
        return v;
      case 'phone':
        if (typeof v !== 'string' || !PHONE_RE.test(v)) throw invalidParam('answers', `field ${f.key} invalid phone`);
        return v;
      case 'email':
        if (typeof v !== 'string' || !EMAIL_RE.test(v)) throw invalidParam('answers', `field ${f.key} invalid email`);
        return v;
      default:
        throw invalidParam('answers', `field ${f.key} unsupported type`);
    }
  }

  // ================= helpers =================

  private parseFields(row: FormVersionRow): FormFieldDef[] {
    try {
      const parsed = JSON.parse(row.schema_json);
      const fields = parsed?.fields;
      return Array.isArray(fields) ? (fields as FormFieldDef[]) : [];
    } catch {
      return [];
    }
  }

  private async definitionView(def: FormDefinitionRow, teamId: number): Promise<FormDefinitionView> {
    const { forms } = this.repos();
    const pub = def.published_version_id != null
      ? await forms.resolveVersionByInternalId(def.published_version_id, teamId)
      : null;
    const draft = await forms.findDraftVersion(def.id, teamId);
    return {
      public_id: def.public_id,
      name: def.name,
      description: def.description,
      status: def.status,
      allow_repeat: def.allow_repeat === 1,
      published_version_id: pub?.public_id ?? null,
      draft_version_id: draft?.public_id ?? null,
      created_at: def.created_at,
      updated_at: def.updated_at,
    };
  }

  private versionView(v: FormVersionRow): FormVersionView {
    return { public_id: v.public_id, version_no: v.version_no, status: v.status, published_at: v.published_at, fields: this.parseFields(v) };
  }

  private async submissionView(s: FormSubmissionRow, teamId: number): Promise<FormSubmissionView> {
    const { forms } = this.repos();
    const def = await forms.resolveDefinitionById(s.definition_id, teamId);
    const ver = await forms.resolveVersionByInternalId(s.version_id, teamId);
    if (!def || !ver) throw internalError();
    let answers: Record<string, unknown> = {};
    try {
      answers = JSON.parse(s.answers_json) as Record<string, unknown>;
    } catch {
      answers = {};
    }
    return {
      public_id: s.public_id,
      definition_public_id: def.public_id,
      version_public_id: ver.public_id,
      status: s.status,
      consumer_type: s.consumer_type,
      consumer_public_id: s.consumer_public_id,
      answers,
      created_at: s.created_at,
      updated_at: s.updated_at,
      submitted_at: s.submitted_at,
    };
  }

  // ================= Definition / version =================

  async createDefinition(input: {
    name: string;
    description?: string | null;
    fields: unknown;
    allow_repeat?: boolean;
  }): Promise<FormDefinitionView> {
    const { userId, teamId } = this.requireActor();
    const { forms } = this.repos();
    const fields = this.validateFields(input.fields);
    const now = Math.floor(Date.now() / 1000);
    const defId = await forms.createDefinitionWithV1DraftAtomically({
      publicId: generateUlid(),
      versionPublicId: generateUlid(),
      teamId,
      actorUserId: userId,
      name: input.name,
      description: input.description ?? null,
      fieldsSchema: JSON.stringify({ fields }),
      allowRepeat: input.allow_repeat === true ? 1 : 0,
      now,
    });
    if (defId <= 0) throw internalError();
    const def = await forms.resolveDefinitionById(defId, teamId);
    if (!def) throw internalError();
    return this.definitionView(def, teamId);
  }

  async getDefinition(definitionPublicId: string): Promise<FormDefinitionView> {
    const { teamId } = this.requireActor();
    const { forms } = this.repos();
    const def = await forms.resolveDefinitionByPublicId(definitionPublicId, teamId);
    if (!def) throw notFound('Form definition');
    return this.definitionView(def, teamId);
  }

  async updateDefinitionMetadata(
    definitionPublicId: string,
    metadata: { name?: string; description?: string | null; allow_repeat?: boolean },
  ): Promise<FormDefinitionView> {
    const { teamId } = this.requireActor();
    const { forms } = this.repos();
    const def = await forms.resolveDefinitionByPublicId(definitionPublicId, teamId);
    if (!def) throw notFound('Form definition');
    if (def.status === FORM_DEF_STATUS.ARCHIVED) throw conflict(ConflictReason.PARENT_MISMATCH);
    if (metadata.name !== undefined && (typeof metadata.name !== 'string' || metadata.name.length === 0)) {
      throw invalidParam('name', 'required');
    }
    const now = Math.floor(Date.now() / 1000);
    const ok = await forms.updateDefinitionMetadata(
      def.id,
      teamId,
      {
        name: metadata.name,
        description: metadata.description !== undefined ? metadata.description : undefined,
        allowRepeat: metadata.allow_repeat !== undefined ? (metadata.allow_repeat ? 1 : 0) : undefined,
      },
      now,
    );
    if (!ok) throw notFound('Form definition');
    const updated = await forms.resolveDefinitionByPublicId(definitionPublicId, teamId);
    if (!updated) throw internalError();
    return this.definitionView(updated, teamId);
  }

  /** POST /definitions/:id/draft —— 幂等取/建当前 draft（published → version_no=MAX+1）。 */
  async createNextDefinitionDraft(definitionPublicId: string): Promise<DefinitionDraftResult> {
    const { userId, teamId } = this.requireActor();
    const { forms } = this.repos();
    const def = await forms.resolveDefinitionByPublicId(definitionPublicId, teamId);
    if (!def) throw notFound('Form definition');
    if (def.status === FORM_DEF_STATUS.ARCHIVED) throw conflict(ConflictReason.PARENT_MISMATCH);

    const existing = await forms.findDraftVersion(def.id, teamId);
    if (existing) return { version: this.versionView(existing), created: false };

    const published = await forms.resolvePublishedVersion(def.id, teamId);
    const schemaJson = published ? published.schema_json : '{"fields":[]}';
    const now = Math.floor(Date.now() / 1000);
    const created = await forms.createNextDraftAtomically({
      publicId: generateUlid(),
      definitionId: def.id,
      teamId,
      actorUserId: userId,
      schemaJson,
      now,
    });
    if (created === 1) {
      const row = await forms.findDraftVersion(def.id, teamId);
      if (!row) throw internalError();
      return { version: this.versionView(row), created: true };
    }
    // 并发：已存在 draft → 200 existing
    const re = await forms.findDraftVersion(def.id, teamId);
    if (re) return { version: this.versionView(re), created: false };
    throw internalError();
  }

  async patchDefinitionDraft(definitionPublicId: string, fields: unknown): Promise<FormVersionView> {
    const { teamId } = this.requireActor();
    const { forms } = this.repos();
    const def = await forms.resolveDefinitionByPublicId(definitionPublicId, teamId);
    if (!def) throw notFound('Form definition');
    if (def.status === FORM_DEF_STATUS.ARCHIVED) throw conflict(ConflictReason.PARENT_MISMATCH);
    const draft = await forms.findDraftVersion(def.id, teamId);
    if (!draft) throw notFound('Draft version');
    const validated = this.validateFields(fields);
    const now = Math.floor(Date.now() / 1000);
    const ok = await forms.updateDraftSchema(def.id, teamId, JSON.stringify({ fields: validated }), now);
    if (!ok) throw notFound('Draft version');
    const updated = await forms.findDraftVersion(def.id, teamId);
    if (!updated) throw internalError();
    return this.versionView(updated);
  }

  async publishDefinition(definitionPublicId: string): Promise<FormDefinitionView> {
    const { teamId } = this.requireActor();
    const { forms } = this.repos();
    const def = await forms.resolveDefinitionByPublicId(definitionPublicId, teamId);
    if (!def) throw notFound('Form definition');
    if (def.status === FORM_DEF_STATUS.ARCHIVED) throw conflict(ConflictReason.PARENT_MISMATCH);
    const draft = await forms.findDraftVersion(def.id, teamId);
    if (!draft) throw conflict(ConflictReason.PARENT_MISMATCH); // 无 draft 可发布

    const now = Math.floor(Date.now() / 1000);
    const { definitionOk } = await forms.publishAtomically(def.id, draft.id, teamId, now);
    if (!definitionOk) {
      // 并发发布：draft 已被发布 → 幂等
      const re = await forms.resolvePublishedVersion(def.id, teamId);
      const reDef = await forms.resolveDefinitionById(def.id, teamId);
      if (re && reDef && re.public_id === draft.public_id) return this.definitionView(reDef, teamId);
      throw internalError();
    }
    const updated = await forms.resolveDefinitionByPublicId(definitionPublicId, teamId);
    if (!updated) throw internalError();
    return this.definitionView(updated, teamId);
  }

  async archiveDefinition(definitionPublicId: string): Promise<FormDefinitionView> {
    const { teamId } = this.requireActor();
    const { forms } = this.repos();
    const def = await forms.resolveDefinitionByPublicId(definitionPublicId, teamId);
    if (!def) throw notFound('Form definition');
    if (def.status === FORM_DEF_STATUS.ARCHIVED) return this.definitionView(def, teamId); // 幂等
    const now = Math.floor(Date.now() / 1000);
    const ok = await forms.archiveAtomically(def.id, teamId, now);
    if (!ok) throw internalError();
    const updated = await forms.resolveDefinitionByPublicId(definitionPublicId, teamId);
    if (!updated) throw internalError();
    return this.definitionView(updated, teamId);
  }

  // ================= Binding =================

  async createBinding(input: {
    definition_public_id: string;
    consumer_type: string;
    consumer_public_id?: string;
    is_default?: boolean;
    consume_policy?: number;
  }): Promise<BindingCreateResult> {
    const { teamId } = this.requireActor();
    const { forms } = this.repos();
    if (!CONSUMER_TYPES.has(input.consumer_type)) {
      throw invalidParam('consumer_type', `unsupported (registered: ${[...CONSUMER_TYPES].join(',')})`);
    }
    const isDefault = input.is_default === true;
    const consumerPublicId = input.consumer_public_id ?? null;
    if (isDefault && consumerPublicId != null) {
      throw invalidParam('consumer_public_id', 'must be empty for is_default binding');
    }
    if (consumerPublicId != null && !isUlid(consumerPublicId)) {
      throw invalidParam('consumer_public_id', 'must be a 26-char ULID');
    }
    const consumePolicy = input.consume_policy ?? FORM_CONSUME_POLICY.OPTIONAL;
    if (!Number.isInteger(consumePolicy) || consumePolicy < 0 || consumePolicy > 2) {
      throw invalidParam('consume_policy', 'must be 0 (none) / 1 (optional) / 2 (required)');
    }

    const def = await forms.resolveDefinitionByPublicId(input.definition_public_id, teamId);
    if (!def) throw notFound('Form definition');
    if (def.status !== FORM_DEF_STATUS.PUBLISHED) throw conflict(ConflictReason.PARENT_MISMATCH);

    if (consumerPublicId != null && !(await forms.consumerActivityOwned(input.consumer_type, consumerPublicId, teamId))) {
      throw notFound('Consumer');
    }

    const now = Math.floor(Date.now() / 1000);
    const created = await forms.createBindingAtomically({
      publicId: generateUlid(),
      teamId,
      definitionId: def.id,
      consumerType: input.consumer_type,
      consumerPublicId: consumerPublicId,
      isDefault: isDefault ? 1 : 0,
      consumePolicy,
      now,
    });
    if (created === 1) {
      const binding = await forms.resolveBindingForConsumer(teamId, input.consumer_type, consumerPublicId);
      if (!binding) throw internalError();
      return { binding: await this.bindingView(binding, teamId), created: true };
    }
    // 已存在同 (team, consumer, definition) 活跃绑定 → 幂等 200
    const re = await forms.resolveBindingForConsumer(teamId, input.consumer_type, consumerPublicId);
    if (re && re.definition_id === def.id && (re.consumer_public_id ?? null) === consumerPublicId) {
      return { binding: await this.bindingView(re, teamId), created: false };
    }
    throw conflict(ConflictReason.PARENT_MISMATCH);
  }

  private async bindingView(b: FormBindingRow, teamId: number): Promise<FormBindingView> {
    const { forms } = this.repos();
    const def = await forms.resolveDefinitionById(b.definition_id, teamId);
    if (!def) throw internalError();
    return {
      public_id: b.public_id,
      definition_public_id: def.public_id,
      consumer_type: b.consumer_type,
      consumer_public_id: b.consumer_public_id,
      is_default: b.is_default === 1,
      consume_policy: b.consume_policy,
      status: b.status,
    };
  }

  // ================= Consumer render =================

  async getConsumerForm(consumerType: string, consumerPublicId: string): Promise<ConsumerFormView> {
    const { teamId } = this.requireActor();
    const { forms } = this.repos();
    if (!CONSUMER_TYPES.has(consumerType)) throw invalidParam('consumer_type', 'unsupported');
    if (!isUlid(consumerPublicId)) throw invalidParam('consumer_public_id', 'must be a 26-char ULID');
    const binding = await forms.resolveBindingForConsumer(teamId, consumerType, consumerPublicId);
    if (!binding) throw notFound('Form'); // 跨团队 / 无绑定 → 普通 404
    if (binding.consume_policy === FORM_CONSUME_POLICY.NONE) {
      throw notFoundReason(ConflictReason.FORM_NOT_AVAILABLE); // policy=0：不可填写
    }
    const published = await forms.resolvePublishedVersion(binding.definition_id, teamId);
    if (!published) throw notFoundReason(ConflictReason.FORM_NOT_AVAILABLE);
    const def = await forms.resolveDefinitionById(binding.definition_id, teamId);
    if (!def) throw internalError();
    return { definition_public_id: def.public_id, version_public_id: published.public_id, fields: this.parseFields(published) };
  }

  // ================= Submission =================

  async submit(input: {
    consumer_type: string;
    consumer_public_id?: string;
    version_public_id?: string;
    new_public_id: string;
    answers: unknown;
    status?: 'draft' | 'submitted';
  }): Promise<SubmissionResult> {
    const { userId, teamId } = this.requireActor();
    const { forms } = this.repos();
    if (!CONSUMER_TYPES.has(input.consumer_type)) throw invalidParam('consumer_type', 'unsupported');
    const consumerPublicId = input.consumer_public_id ?? null;
    if (consumerPublicId != null && !isUlid(consumerPublicId)) throw invalidParam('consumer_public_id', 'must be a 26-char ULID');
    if (!isUlid(input.new_public_id)) throw invalidParam('new_public_id', 'must be a 26-char Crockford ULID');
    const status = input.status === 'draft' ? FORM_SUBMISSION_STATUS.DRAFT : FORM_SUBMISSION_STATUS.SUBMITTED;
    const strictRequired = status === FORM_SUBMISSION_STATUS.SUBMITTED;

    // 权威解析链
    const binding = await forms.resolveBindingForConsumer(teamId, input.consumer_type, consumerPublicId);
    if (!binding) throw notFound('Form');
    const def = await forms.resolveDefinitionById(binding.definition_id, teamId);
    if (!def) throw notFound('Form');
    const published = await forms.resolvePublishedVersion(def.id, teamId);
    if (!published) throw notFoundReason(ConflictReason.FORM_NOT_AVAILABLE);

    // 客户端 version 仅 stale-check
    if (input.version_public_id != null) {
      if (!isUlid(input.version_public_id)) throw invalidParam('version_public_id', 'must be a 26-char ULID');
      const version = await forms.resolveVersionByPublicId(input.version_public_id, teamId);
      if (!version || version.id !== published.id || version.definition_id !== def.id) {
        throw conflict(ConflictReason.FORM_VERSION_STALE);
      }
    }

    const fields = this.parseFields(published);
    const validAnswers = this.validateAnswers(fields, input.answers, { strictRequired });
    const consumerKey = `${input.consumer_type}:${consumerPublicId ?? ''}`;
    const now = Math.floor(Date.now() / 1000);

    const created = await forms.createSubmissionAtomically({
      publicId: input.new_public_id,
      definitionId: def.id,
      versionId: published.id,
      submitterUserId: userId,
      teamId,
      consumerType: input.consumer_type,
      consumerPublicId,
      consumerKey,
      answersJson: JSON.stringify(validAnswers),
      status,
      now,
      submittedAt: status === FORM_SUBMISSION_STATUS.SUBMITTED ? now : null,
    });
    if (created === 1) {
      const row = await forms.findOwnSubmissionByPublicId(input.new_public_id, userId, teamId);
      if (!row) throw internalError();
      return { submission: await this.submissionView(row, teamId), created: true };
    }

    // 0 行 → 重读分类
    const dup = await forms.findOwnSubmissionByPublicId(input.new_public_id, userId, teamId);
    if (dup) {
      if (dup.definition_id === def.id && dup.version_id === published.id && dup.consumer_key === consumerKey) {
        return { submission: await this.submissionView(dup, teamId), created: false }; // replay
      }
      throw conflict(ConflictReason.FORM_SUBMISSION_DUPLICATE);
    }
    const active = await forms.findActiveSubmitted(def.id, userId, consumerKey);
    if (active) throw conflict(ConflictReason.FORM_SUBMISSION_DUPLICATE);
    const pub2 = await forms.resolvePublishedVersion(def.id, teamId);
    if (!pub2 || pub2.id !== published.id) throw conflict(ConflictReason.FORM_VERSION_STALE);
    const b2 = await forms.resolveBindingForConsumer(teamId, input.consumer_type, consumerPublicId);
    if (b2 == null || b2.definition_id !== def.id) throw notFoundReason(ConflictReason.FORM_NOT_AVAILABLE);
    throw internalError();
  }

  async patchDraftSubmission(submissionPublicId: string, answers: unknown): Promise<FormSubmissionView> {
    const { userId, teamId } = this.requireActor();
    const { forms } = this.repos();
    const row = await forms.findOwnSubmissionByPublicId(submissionPublicId, userId, teamId);
    if (!row) throw notFound('Submission');
    if (row.status !== FORM_SUBMISSION_STATUS.DRAFT) throw conflict(ConflictReason.PARENT_MISMATCH);

    const published = await forms.resolvePublishedVersion(row.definition_id, teamId);
    if (!published) throw notFoundReason(ConflictReason.FORM_NOT_AVAILABLE);
    if (row.version_id !== published.id) throw conflict(ConflictReason.FORM_VERSION_STALE); // 禁止自动升级

    const fields = this.parseFields(published);
    const valid = this.validateAnswers(fields, answers, { strictRequired: false });
    const now = Math.floor(Date.now() / 1000);
    const ok = await forms.updateDraftAnswersAtomically(
      submissionPublicId,
      userId,
      teamId,
      published.id,
      JSON.stringify(valid),
      now,
    );
    if (!ok) throw notFound('Submission');
    const updated = await forms.findOwnSubmissionByPublicId(submissionPublicId, userId, teamId);
    if (!updated) throw internalError();
    return this.submissionView(updated, teamId);
  }

  async listOwnSubmissions(): Promise<FormSubmissionView[]> {
    const { userId, teamId } = this.requireActor();
    const { forms } = this.repos();
    const rows = await forms.listOwnSubmissions(userId, teamId);
    const out: FormSubmissionView[] = [];
    for (const r of rows) out.push(await this.submissionView(r, teamId));
    return out;
  }

  async withdrawSubmission(submissionPublicId: string): Promise<FormSubmissionView> {
    const { userId, teamId } = this.requireActor();
    const { forms } = this.repos();
    if (!isUlid(submissionPublicId)) throw invalidParam('public_id', 'must be a 26-char ULID');
    const row = await forms.findOwnSubmissionByPublicId(submissionPublicId, userId, teamId);
    if (!row) throw notFound('Submission');
    if (row.status === FORM_SUBMISSION_STATUS.WITHDRAWN) return this.submissionView(row, teamId); // 幂等
    if (row.status === FORM_SUBMISSION_STATUS.INVALIDATED) throw conflict(ConflictReason.PARENT_MISMATCH); // 终态
    const now = Math.floor(Date.now() / 1000);
    const changed = await forms.withdrawAtomically(submissionPublicId, userId, teamId, now);
    if (changed === 0) {
      const re = await forms.findOwnSubmissionByPublicId(submissionPublicId, userId, teamId);
      if (re && re.status === FORM_SUBMISSION_STATUS.WITHDRAWN) return this.submissionView(re, teamId);
      throw notFound('Submission');
    }
    const final = await forms.findSubmissionByPublicIdTeamScope(submissionPublicId, teamId);
    if (!final) throw internalError();
    return this.submissionView(final, teamId);
  }

  async listTeamSubmissions(consumerType: string, consumerPublicId?: string): Promise<FormSubmissionView[]> {
    const { teamId } = this.requireActor();
    const { forms } = this.repos();
    const rows = await forms.listTeamSubmissions(teamId, consumerType, consumerPublicId ?? null);
    const out: FormSubmissionView[] = [];
    for (const r of rows) out.push(await this.submissionView(r, teamId));
    return out;
  }

  async invalidateSubmission(submissionPublicId: string): Promise<FormSubmissionView> {
    const { teamId } = this.requireActor();
    const { forms } = this.repos();
    if (!isUlid(submissionPublicId)) throw invalidParam('public_id', 'must be a 26-char ULID');
    const row = await forms.findSubmissionByPublicIdTeamScope(submissionPublicId, teamId);
    if (!row) throw notFound('Submission');
    if (row.status === FORM_SUBMISSION_STATUS.INVALIDATED) return this.submissionView(row, teamId); // 幂等
    if (row.status !== FORM_SUBMISSION_STATUS.SUBMITTED) throw conflict(ConflictReason.PARENT_MISMATCH);
    const now = Math.floor(Date.now() / 1000);
    const changed = await forms.invalidateAtomically(submissionPublicId, teamId, now);
    if (changed === 0) throw notFound('Submission');
    const final = await forms.findSubmissionByPublicIdTeamScope(submissionPublicId, teamId);
    if (!final) throw internalError();
    return this.submissionView(final, teamId);
  }
}