/**
 * 微信订阅消息模板 schema 注册表（N0-D — 唯一 SSOT）。
 *
 * 来源：当前微信公众平台「我的模板」核验结果（N0-D Provider Template Validity Gate：11/11 生效中）。
 * 这 11 个映射与 0035 中 message_templates 的 wx_template_id 保持一致，是本 adapter 签发 payload 的权威依据。
 *
 * 纪律：
 *   - provider field key（thing4 / date2 / ...）只来自微信官方模板字段定义，绝不猜测。
 *   - 业务标签（businessLabel）用于未来 N0-E 业务层 → provider key 的映射，本层不强制业务语义。
 *   - 该 registry 是唯一 schema 来源；adapter 发送前必须逐项校验。
 */

export type WeChatFieldType =
  | 'thing'
  | 'date'
  | 'time'
  | 'phrase'
  | 'number'
  | 'character_string';

/** provider 字段前缀白名单（用于 field key 形态校验）。 */
export const WECHAT_FIELD_PREFIXES: readonly WeChatFieldType[] = [
  'thing',
  'date',
  'time',
  'phrase',
  'number',
  'character_string',
];

export interface WeChatTemplateField {
  /** 业务语义标签（仅用于 mapping / 文档，不参与 provider 校验）。 */
  businessLabel: string;
  /** 微信 provider 字段 key（如 thing4）；发送 payload 的键。 */
  providerKey: string;
  type: WeChatFieldType;
}

export interface WeChatTemplateSchema {
  templateKey: string;
  title: string;
  templateNo: string;
  wxTemplateId: string;
  /** 部分模板限定场景（志愿者积分兑换 / 审核通过 / 签到 / 预约 / 新活动通知）。 */
  scene?: string;
  fields: WeChatTemplateField[];
}

export const WECHAT_TEMPLATE_SCHEMAS: Record<string, WeChatTemplateSchema> = {
  signup: {
    templateKey: 'signup',
    title: '报名结果提醒',
    templateNo: '620',
    wxTemplateId: '_x9D2d6Ae7wuiewEp4XTPVsSd061O4lPaLreJdZQwM4',
    fields: [
      { businessLabel: '活动名称', providerKey: 'thing4', type: 'thing' },
      { businessLabel: '活动地点', providerKey: 'thing6', type: 'thing' },
      { businessLabel: '报名结果', providerKey: 'thing10', type: 'thing' },
      { businessLabel: '签到地点', providerKey: 'thing11', type: 'thing' },
      { businessLabel: '联系人', providerKey: 'thing18', type: 'thing' },
    ],
  },
  certify: {
    templateKey: 'certify',
    title: '实名认证通知',
    templateNo: '4240',
    wxTemplateId: 'eu4viO-Ex0YqXnVfXsRAAPOIFsZc_AC7LsVVW4ug8Yw',
    fields: [
      { businessLabel: '认证状态', providerKey: 'thing1', type: 'thing' },
      { businessLabel: '认证时间', providerKey: 'date2', type: 'date' },
      { businessLabel: '备注', providerKey: 'thing3', type: 'thing' },
    ],
  },
  change: {
    templateKey: 'change',
    title: '活动变更通知',
    templateNo: '1685',
    wxTemplateId: 'wQtwe8L7l-u6YFzMtHRbXNrXvZVRacbPGEZMgVTHMZ8',
    fields: [
      { businessLabel: '活动名称', providerKey: 'thing2', type: 'thing' },
      { businessLabel: '活动时间变更', providerKey: 'date4', type: 'date' },
      { businessLabel: '修改详情', providerKey: 'thing6', type: 'thing' },
      { businessLabel: '场地名称', providerKey: 'thing12', type: 'thing' },
    ],
  },
  training: {
    templateKey: 'training',
    title: '活动培训提醒',
    templateNo: '1486',
    wxTemplateId: 'JRKyGhoWQ9XNxt7_bAQxMgj8IoJTgs4qiQKo2vqhBa8',
    fields: [
      { businessLabel: '活动名称', providerKey: 'thing1', type: 'thing' },
      { businessLabel: '活动时间', providerKey: 'time2', type: 'time' },
      { businessLabel: '活动地点', providerKey: 'thing3', type: 'thing' },
      { businessLabel: '备注', providerKey: 'thing4', type: 'thing' },
    ],
  },
  points: {
    templateKey: 'points',
    title: '积分变动提醒',
    templateNo: '1101',
    wxTemplateId: 'sGepFsMsjkIGL-ph7mjCNHb9aKG11sh89J55qB3bEok',
    fields: [
      { businessLabel: '变动积分', providerKey: 'thing4', type: 'thing' },
      { businessLabel: '变动原因', providerKey: 'thing5', type: 'thing' },
      { businessLabel: '温馨提示', providerKey: 'thing6', type: 'thing' },
      { businessLabel: '剩余积分', providerKey: 'number8', type: 'number' },
      { businessLabel: '总积分', providerKey: 'number10', type: 'number' },
    ],
  },
  verify: {
    templateKey: 'verify',
    title: '核销成功通知',
    templateNo: '1016',
    scene: '志愿者积分兑换',
    wxTemplateId: 'PcOdV5nYPj89BY-b_C5n1FNjmq7G9mqQQBlQU1pEE9A',
    fields: [
      { businessLabel: '卡券名称', providerKey: 'thing2', type: 'thing' },
      { businessLabel: '核销数量', providerKey: 'number3', type: 'number' },
      { businessLabel: '核销时间', providerKey: 'date5', type: 'date' },
      { businessLabel: '温馨提示', providerKey: 'thing9', type: 'thing' },
      { businessLabel: '核销商品', providerKey: 'thing14', type: 'thing' },
    ],
  },
  audit: {
    templateKey: 'audit',
    title: '审核通过提醒',
    templateNo: '603',
    scene: '志愿服务活动审核通过',
    wxTemplateId: 'k6azwIXNr-D-u322U91vZXQet_MUtaLpqxtqDL6NG-A',
    fields: [
      { businessLabel: '审核结果', providerKey: 'phrase1', type: 'phrase' },
      { businessLabel: '活动名称', providerKey: 'thing2', type: 'thing' },
      { businessLabel: '活动时间', providerKey: 'time3', type: 'time' },
      { businessLabel: '温馨提示', providerKey: 'thing5', type: 'thing' },
      { businessLabel: '活动地点', providerKey: 'thing16', type: 'thing' },
    ],
  },
  start: {
    templateKey: 'start',
    title: '活动开始通知',
    templateNo: '515',
    wxTemplateId: 'SrFXViQy2FVmi34qEtJmcbMPOR_cqNHn74zo0eA4eSA',
    fields: [
      { businessLabel: '活动名称', providerKey: 'thing4', type: 'thing' },
      { businessLabel: '活动时间', providerKey: 'date5', type: 'date' },
      { businessLabel: '活动地点', providerKey: 'thing6', type: 'thing' },
      { businessLabel: '温馨提示', providerKey: 'thing7', type: 'thing' },
      { businessLabel: '距离开始时间', providerKey: 'character_string17', type: 'character_string' },
    ],
  },
  checkin: {
    templateKey: 'checkin',
    title: '签到提醒',
    templateNo: '513',
    scene: '志愿者活动签到签退提醒',
    wxTemplateId: 'QVakhEJ7nDaB6seNZWBzPcn2HD4oL3Gdp8-VUw7UZTY',
    fields: [
      { businessLabel: '活动名称', providerKey: 'thing1', type: 'thing' },
      { businessLabel: '签到方式', providerKey: 'thing2', type: 'thing' },
      { businessLabel: '截止时间', providerKey: 'time5', type: 'time' },
      { businessLabel: '温馨提醒', providerKey: 'thing9', type: 'thing' },
      { businessLabel: '签到地点', providerKey: 'thing21', type: 'thing' },
    ],
  },
  book: {
    templateKey: 'book',
    title: '预约通知',
    templateNo: '461',
    scene: '志愿者活动报名',
    wxTemplateId: 'Lx4Vpm2T7TTdzXjy2XJS8-Uc6jnxan7vNlewfJSmTqk',
    fields: [
      { businessLabel: '预约时间', providerKey: 'date3', type: 'date' },
      { businessLabel: '预约主题', providerKey: 'thing5', type: 'thing' },
      { businessLabel: '温馨提示', providerKey: 'thing8', type: 'thing' },
      { businessLabel: '预约状态', providerKey: 'phrase14', type: 'phrase' },
    ],
  },
  newActivity: {
    templateKey: 'newActivity',
    title: '新活动发布提醒',
    templateNo: '432',
    scene: '志愿者活动通知',
    wxTemplateId: 'Pq6jAdefsEM5kRG6tFryCmA-ddWBwC8Gybe33DOpHFw',
    fields: [
      { businessLabel: '活动地点', providerKey: 'thing4', type: 'thing' },
      { businessLabel: '开始时间', providerKey: 'date2', type: 'date' },
      { businessLabel: '活动名称', providerKey: 'thing6', type: 'thing' },
      { businessLabel: '活动时间', providerKey: 'character_string10', type: 'character_string' },
      { businessLabel: '招募人数', providerKey: 'number20', type: 'number' },
    ],
  },
};

export const WECHAT_TEMPLATE_KEYS: string[] = Object.keys(WECHAT_TEMPLATE_SCHEMAS);

/** provider field key 形态校验：<prefix><digits>，prefix 必须属于白名单。 */
export function isWeChatFieldKey(key: string): boolean {
  const m = /^([a-z_]+)(\d+)$/.exec(key);
  if (m == null) return false;
  return (WECHAT_FIELD_PREFIXES as readonly string[]).includes(m[1]);
}

export interface WeChatPayloadValidationOk {
  ok: true;
  wrapped: Record<string, { value: string }>;
}
export interface WeChatPayloadValidationFail {
  ok: false;
  reason: string;
}
export type WeChatPayloadValidation = WeChatPayloadValidationOk | WeChatPayloadValidationFail;

/**
 * 校验入参 payload（按 providerKey 键入）是否符合模板 schema。
 * - 未知字段 / 非白名单 field key → 失败。
 * - 缺失任一必需字段 → 失败（微信要求模板全部关键词齐备）。
 * - 非字符串值 → 失败；number* 必须为有限数值（明显非数值文本不得当作有效 number）。
 * 成功返回已按 provider 期望格式（{ value }）包裹的 data。
 */
export function validateWeChatPayload(
  schema: WeChatTemplateSchema,
  data: Record<string, unknown>,
): WeChatPayloadValidation {
  const allowed = new Set(schema.fields.map((f) => f.providerKey));
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) return { ok: false, reason: `unknown_field:${key}` };
    if (!isWeChatFieldKey(key)) return { ok: false, reason: `bad_field_key:${key}` };
  }
  for (const f of schema.fields) {
    const v = data[f.providerKey];
    if (typeof v !== 'string') return { ok: false, reason: `non_string:${f.providerKey}` };
    if (v.length === 0) return { ok: false, reason: `empty:${f.providerKey}` };
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) return { ok: false, reason: `not_number:${f.providerKey}` };
    }
  }
  const wrapped: Record<string, { value: string }> = {};
  for (const f of schema.fields) wrapped[f.providerKey] = { value: String(data[f.providerKey]) };
  return { ok: true, wrapped };
}
