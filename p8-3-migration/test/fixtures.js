import { FixtureSource } from '../src/adapters.js';

export const users = [
  { id: 1, nickname: 'Alice', cert_level: 1, status: 1, last_login_at: '2026-01-01 10:00:00', created_at: '2026-01-01 09:00:00' },
  { id: 2, nickname: 'Bob', cert_level: 2, status: 1, created_at: '2026-01-02 09:00:00' },
];

export const volunteers = [
  { id: 1, user_id: 1, real_name_enc: 'enc', id_card: '110101199001011234', id_card_hash: 'h', phone_enc: 'p', cert_status: 1, total_times: 5 },
];

export const activities = [
  { id: 10, team_id: 1, category_id: 2, title: 'Cleanup', start_time: '2026-03-01 08:00:00', end_time: '2026-03-01 12:00:00', status: 1, created_by: 1, created_at: '2026-02-01 00:00:00' },
];

export const activity_signups = [
  { id: 100, activity_id: 10, user_id: 1, status: 1, created_at: '2026-02-15 00:00:00' },
];

export const checkins = [
  { id: 5, activity_id: 10, user_id: 1, checkin_at: '2026-03-01 08:05:00' },
];

export const points = [
  { id: 7, user_id: 1, direction: 1, amount: 10, balance_after: 10, type: 'signup', request_id: 'r1', created_at: '2026-03-01 09:00:00' },
];

export const certificates = [
  { id: 3, user_id: 1, cert_type: 'activity', holder_name_raw: '张三', verify_code: 'V3', issued_at: '2026-04-01 00:00:00', status: 1 },
];

// EXCLUDED object — must never be migrated / dropped / auto-archived.
export const user_favorites = [
  { id: 9, user_id: 1, target_type: 'activity', target_id: 10 },
];

// ARCHIVE object.
export const quick_actions = [
  { id: 1, action_type: 'pickup', title: '随手捡', created_at: '2026-05-01 00:00:00' },
];

// DROP object.
export const qr_codes = [
  { id: 1, code: 'abc' },
];

export function buildSource() {
  return new FixtureSource({
    'api.users': users,
    'api.volunteers': volunteers,
    'api.activities': activities,
    'api.jhzy_activity_signups': activity_signups,
    'api.jhzy_activity_checkins': checkins,
    'api.points_transactions': points,
    'api.certificates': certificates,
    'api.user_favorites': user_favorites,
    'api.quick_actions': quick_actions,
    'api.qr_codes': qr_codes,
  });
}
