// Transform engine: maps 1.0 source rows -> 2.0 target rows (frozen D1 model).
// INTEGER PK auto-assigned by target; public_id = ULID(26); DATETIME -> INTEGER epoch.
import { makeUlid } from './ulid.js';

// Target tables that carry a public_id (ULID) per D1-DATABASE-DESIGN.
export const HAS_PUBLIC_ID = new Set(['users', 'teams', 'activities', 'content_articles', 'files']);

// DATETIME-like column names that must be converted to INTEGER epoch.
function isDateCol(name) {
  return /(_at|time|date|deadline|_since|_until)$/i.test(name);
}

// MySQL DATETIME 'YYYY-MM-DD HH:MM:SS' -> epoch seconds. Numbers pass through.
export function toEpoch(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2})?/.test(s)) {
    const iso = s.includes('T') ? s : s.replace(' ', 'T');
    const padded = iso.length <= 11 ? iso + 'T00:00:00' : iso;
    const ms = Date.parse(padded);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function maskIdCard(v) {
  if (!v) return null;
  const s = String(v).replace(/\s/g, '');
  if (s.length <= 8) return s.slice(0, 2) + '****' + s.slice(-2);
  return s.slice(0, 4) + '**********' + s.slice(-4);
}

// Build a target row from a declarative column map.
// columnMap: { dstCol: srcCol | (src, ctx) => value }
function buildRow(src, columnMap, ctx) {
  const out = {};
  for (const [dstCol, ref] of Object.entries(columnMap)) {
    out[dstCol] = typeof ref === 'function' ? ref(src, ctx) : src[ref];
    if (isDateCol(dstCol) && typeof out[dstCol] === 'string') out[dstCol] = toEpoch(out[dstCol]);
  }
  if (ctx.publicId && !out.public_id) out.public_id = ctx.makeUlid({ time: ctx.now });
  return out;
}

// Generic copy: pass through all source columns, convert dates, add public_id if needed.
function genericCopy(src, ctx) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = isDateCol(k) && typeof v === 'string' ? toEpoch(v) : v;
  }
  if (ctx.publicId && !out.public_id) out.public_id = ctx.makeUlid({ time: ctx.now });
  return out;
}

// ---------- Named transforms (non-trivial value logic) ----------
const TRANSFORMS = {
  // users: identity主体; generate public_id; last_login_at epoch; drop raw IP (VARBINARY转存另步)
  users(src, ctx) {
    const row = {
      nickname: src.nickname ?? null,
      avatar_file_id: src.avatar_file_id ?? null,
      cert_level: src.cert_level ?? 1,
      status: src.status ?? 1,
      last_login_at: toEpoch(src.last_login_at) ?? null,
      created_at: toEpoch(src.created_at) ?? Math.floor(ctx.now / 1000),
    };
    if (HAS_PUBLIC_ID.has('users')) row.public_id = ctx.makeUlid({ time: ctx.now });
    return { table: 'users', row };
  },

  // signup_db.users: same as users but flagged for dedup (legacy_id_maps drives dedup)
  signup_users(src, ctx) {
    return TRANSFORMS.users(src, ctx);
  },

  // users_dedup (users_old / jhzy_users_old): treat as users; dedup keyed by legacy_id
  users_dedup(src, ctx) {
    return TRANSFORMS.users(src, ctx);
  },

  // volunteers -> volunteer_profiles (high-sensitivity; AES would be applied at rest; here map fields, mask id_card)
  volunteers(src, ctx) {
    const row = {
      real_name_enc: src.real_name_enc ?? null,
      id_card_hash: src.id_card_hash ?? null,
      id_card_mask: maskIdCard(src.id_card ?? src.id_card_raw),
      phone_enc: src.phone_enc ?? null,
      phone_mask: src.phone_mask ?? null,
      cert_status: src.cert_status ?? 0,
      total_minutes: 0, // recomputed from service_records (initial 0 per WP2)
      total_times: src.total_times ?? 0,
      growth_value: src.growth_value ?? 0,
      level_id: src.level_id ?? null,
      created_at: toEpoch(src.created_at) ?? Math.floor(ctx.now / 1000),
    };
    return { table: 'volunteer_profiles', row };
  },
  volunteers_dedup(src, ctx) {
    return TRANSFORMS.volunteers(src, ctx);
  },

  // teams -> teams
  teams(src, ctx) {
    const row = {
      name: src.name,
      owner_user_id: src.owner_user_id ?? 0,
      cert_status: src.cert_status ?? 0,
      status: src.status ?? 1,
      settings: typeof src.settings === 'string' ? src.settings : JSON.stringify(src.settings ?? {}),
      created_at: toEpoch(src.created_at) ?? Math.floor(ctx.now / 1000),
    };
    if (HAS_PUBLIC_ID.has('teams')) row.public_id = ctx.makeUlid({ time: ctx.now });
    return { table: 'teams', row };
  },
  volunteer_groups(src, ctx) {
    return TRANSFORMS.teams(src, ctx);
  },

  // activities -> activities (configs -> JSON columns)
  activities(src, ctx) {
    const row = {
      team_id: src.team_id ?? 0,
      category_id: src.category_id ?? null,
      title: src.title,
      summary: src.summary ?? null,
      detail: src.detail ?? null,
      start_time: toEpoch(src.start_time) ?? 0,
      end_time: toEpoch(src.end_time) ?? 0,
      signup_deadline: toEpoch(src.signup_deadline),
      latitude: src.latitude ?? null,
      longitude: src.longitude ?? null,
      geo_radius: src.geo_radius ?? 200,
      quota: src.quota ?? 0,
      need_audit: src.need_audit ?? 0,
      checkin_config: JSON.stringify(src.checkin_config ?? {}),
      risk_config: JSON.stringify(src.risk_config ?? {}),
      points_config: JSON.stringify(src.points_config ?? {}),
      cert_config: JSON.stringify(src.cert_config ?? {}),
      status: src.status ?? 0,
      created_by: src.created_by ?? 0,
      created_at: toEpoch(src.created_at) ?? Math.floor(ctx.now / 1000),
    };
    if (HAS_PUBLIC_ID.has('activities')) row.public_id = ctx.makeUlid({ time: ctx.now });
    return { table: 'activities', row };
  },
  activities_merge(src, ctx) {
    return TRANSFORMS.activities(src, ctx);
  },

  // activity_signups / participants -> activity_signups
  signups(src, ctx) {
    const row = {
      activity_id: src.activity_id ?? src.event_id ?? 0,
      user_id: src.user_id ?? 0,
      team_id: src.team_id ?? 0,
      form_data: typeof src.form_data === 'string' ? src.form_data : JSON.stringify(src.form_data ?? {}),
      review_status: src.review_status ?? 0,
      status: src.status ?? 1,
      created_at: toEpoch(src.created_at) ?? Math.floor(ctx.now / 1000),
    };
    return { table: 'activity_signups', row };
  },
  participants(src, ctx) {
    return TRANSFORMS.signups(src, ctx);
  },

  // checkins -> attendance_sessions + attendance_events (checkin event)
  checkins(src, ctx) {
    const session = {
      activity_id: src.activity_id ?? 0,
      user_id: src.user_id ?? 0,
      team_id: src.team_id ?? 0,
      started_at: toEpoch(src.checkin_at ?? src.created_at) ?? Math.floor(ctx.now / 1000),
    };
    const evt = {
      activity_id: src.activity_id ?? 0,
      user_id: src.user_id ?? 0,
      team_id: src.team_id ?? 0,
      event_type: 'checkin',
      latitude: src.latitude ?? null,
      longitude: src.longitude ?? null,
      occurred_at: toEpoch(src.checkin_at ?? src.created_at) ?? Math.floor(ctx.now / 1000),
    };
    return [
      { table: 'attendance_sessions', row: session },
      { table: 'attendance_events', row: evt },
    ];
  },

  // points_ledger: recompute balance_after; request_id idempotent key
  points_ledger(src, ctx) {
    const row = {
      user_id: src.user_id ?? 0,
      team_id: src.team_id ?? 0,
      direction: src.direction ?? 1,
      amount: src.amount ?? 0,
      balance_after: src.balance_after ?? src.amount ?? 0,
      type: src.type ?? 'unknown',
      source_type: src.source_type ?? null,
      source_id: src.source_id ?? null,
      request_id: String(src.request_id ?? src.id ?? `${src.user_id}-${src.id}`),
      created_at: toEpoch(src.created_at) ?? Math.floor(ctx.now / 1000),
    };
    return { table: 'points_ledger', row };
  },

  // certificates: cert_no from id_pools; mask plaintext id_card; snapshot JSON
  certificates(src, ctx) {
    const row = {
      cert_no: src.cert_no ?? `C${src.id}`,
      verify_code: src.verify_code ?? `V${src.id}`,
      template_id: src.template_id ?? 0,
      user_id: src.user_id ?? 0,
      team_id: src.team_id ?? 0,
      cert_type: src.cert_type ?? 'activity',
      holder_name: null, // plaintext holder_name never carried to 2.0; masked identity handled via id_card_mask
      issuer_name: src.issuer_name ?? null,
      snapshot: typeof src.snapshot === 'string' ? src.snapshot : JSON.stringify(src.snapshot ?? {}),
      file_id: src.file_id ?? null,
      issued_at: toEpoch(src.issued_at) ?? Math.floor(ctx.now / 1000),
      status: src.status ?? 1,
    };
    return { table: 'certificates', row };
  },

  // admins -> users (cert_level mark) + user_roles (platform_operator)
  admins(src, ctx) {
    const userRow = {
      nickname: src.username ?? src.nickname ?? null,
      cert_level: 2,
      status: 1,
      created_at: toEpoch(src.created_at) ?? Math.floor(ctx.now / 1000),
    };
    if (HAS_PUBLIC_ID.has('users')) userRow.public_id = ctx.makeUlid({ time: ctx.now });
    const roleRow = {
      role_code: 'platform_operator',
      scope_team_id: null,
      granted_at: Math.floor(ctx.now / 1000),
    };
    return [
      { table: 'users', row: userRow },
      { table: 'user_roles', row: roleRow },
    ];
  },

  // user_tokens / admin_tokens -> sessions
  user_tokens_to_sessions(src, ctx) {
    const row = {
      user_id: src.user_id ?? 0,
      token_hash: src.token_hash ?? src.token ?? null,
      device: src.device ?? null,
      platform: src.platform ?? null,
      ip_hash: src.ip ?? src.ip_hash ?? null,
      user_agent: src.user_agent ?? null,
      expires_at: toEpoch(src.expire ?? src.expires_at) ?? null,
    };
    return { table: 'sessions', row };
  },
  admin_tokens_to_sessions(src, ctx) {
    return TRANSFORMS.user_tokens_to_sessions(src, ctx);
  },

  // level_records -> growth_records (+ volunteer_levels mapping; here growth_records)
  growth_level_records(src, ctx) {
    const row = {
      user_id: src.user_id ?? 0,
      team_id: src.team_id ?? 0,
      action_type: 'level_change',
      value: src.value ?? src.level ?? 0,
      balance_after: src.balance_after ?? src.value ?? 0,
      request_id: String(src.request_id ?? src.id),
      created_at: toEpoch(src.created_at) ?? Math.floor(ctx.now / 1000),
    };
    return { table: 'growth_records', row };
  },

  // welfare_options -> mall_products
  mall_products(src, ctx) {
    const row = {
      name: src.name,
      points_price: src.points_cost ?? src.price ?? 0,
      stock: src.stock ?? 0,
      description: src.description ?? null,
      status: 1,
    };
    return { table: 'mall_products', row };
  },

  // achievements -> badges
  badges(src, ctx) {
    const row = {
      name: src.title ?? src.name,
      description: src.description ?? null,
      issued_at: toEpoch(src.issued_at ?? src.created_at) ?? Math.floor(ctx.now / 1000),
    };
    return { table: 'badges', row };
  },
};

// Dispatch a TABLE_MAP spec against a source row.
export function applyTransform(spec, src, ctx) {
  if (spec.transform && TRANSFORMS[spec.transform]) {
    return TRANSFORMS[spec.transform](src, ctx);
  }
  if (spec.targets && Array.isArray(spec.targets)) {
    const out = [];
    for (const t of spec.targets) {
      const childCtx = { ...ctx, publicId: !!t.publicId };
      const built = t.columns ? buildRow(src, t.columns, childCtx) : genericCopy(src, childCtx);
      const finalRow = t.transform && TRANSFORMS[t.transform] ? TRANSFORMS[t.transform](built, ctx) : built;
      out.push({ table: t.table, row: finalRow });
    }
    return out;
  }
  if (spec.target) {
    const childCtx = { ...ctx, publicId: !!spec.publicId };
    const built = spec.columns ? buildRow(src, spec.columns, childCtx) : genericCopy(src, childCtx);
    return { table: spec.target, row: built };
  }
  return null;
}

export { TRANSFORMS, buildRow, genericCopy };
