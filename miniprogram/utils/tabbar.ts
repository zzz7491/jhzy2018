// P0-A 全局一级导航常量（冻结）。
//
// 纪律：
// - 索引顺序必须与 miniprogram/app.json 的 tabBar.list 严格一致。
// - custom-tab-bar 与各 tab 页面的 selected 同步共用本文件，杜绝魔法数字（历史 index:3 之类）。
// - 本文件只描述导航骨架；G1 状态只保留「取权威态 → 推给 tabBar」的最小 helper，
//   不建立 global store，不持有跨页面的业务真值。
//
// 冻结顺序：
//   0 首页 / 1 活动 / 2 签到·签退 / 3 消息 / 4 我的

import activityApi, { hasV2Session } from './activityApi';

export const TAB_INDEX = {
  HOME: 0,
  ACTIVITIES: 1,
  ATTENDANCE: 2,
  MESSAGE: 3,
  MINE: 4,
} as const;

export interface TabItem {
  index: number;
  pagePath: string;
  text: string;
  center: boolean;
}

export const TAB_LIST: TabItem[] = [
  { index: TAB_INDEX.HOME, pagePath: 'pages/index/index', text: '首页', center: false },
  { index: TAB_INDEX.ACTIVITIES, pagePath: 'pages/activities/activities', text: '活动', center: false },
  { index: TAB_INDEX.ATTENDANCE, pagePath: 'pages/sign/sign', text: '签到/签退', center: true },
  { index: TAB_INDEX.MESSAGE, pagePath: 'pages/message/message', text: '消息', center: false },
  { index: TAB_INDEX.MINE, pagePath: 'pages/mine/mine', text: '我的', center: false },
];

// 同步 tab 选中态。getTabBar() 不存在（非 tab 页 / 未启用 custom tabBar）时静默跳过，
// 绝不以「选中态同步失败」打断页面原有 onShow 逻辑。
export function syncTabSelected(page: any, index: number): void {
  if (!page || typeof page.getTabBar !== 'function') return;
  const tabBar = page.getTabBar();
  if (tabBar && typeof tabBar.setData === 'function') {
    tabBar.setData({ selected: index });
  }
}

// 消息未读徽标。
// 优先写入 custom-tab-bar 自身状态（custom tabBar 下原生 wx.setTabBarBadge 不随组件渲染）；
// 仅在取不到 custom tabBar 实例时回退原生 API，避免徽标丢失。
export function setMessageUnread(page: any, count: number): void {
  const raw = Number(count);
  const n = isNaN(raw) || raw <= 0 ? 0 : Math.floor(raw);

  const tabBar = page && typeof page.getTabBar === 'function' ? page.getTabBar() : null;
  if (tabBar && typeof tabBar.setUnread === 'function') {
    tabBar.setUnread(n);
    return;
  }

  if (n > 0) {
    wx.setTabBarBadge({ index: TAB_INDEX.MESSAGE, text: n > 99 ? '99+' : String(n) });
  } else {
    wx.removeTabBarBadge({ index: TAB_INDEX.MESSAGE });
  }
}

// =========================================================================
// G1：中心按钮 / 签到 Hub 的「服务进行中」状态（唯一真值 = GET /attendance-sessions/me）
//
// 纪律：
// - 真值只来自后端 authoritative API；绝不使用 storage / 页面参数 / 当前 team / 客户端推断。
// - Guest（无有效 V2 会话）【不发起任何请求】，直接取中性态，不触发登录。
// - ERROR / GUEST / NO_ACTIVE 一律推 false → 中心按钮保持中性「签到/签退」；
//   只有刚取得的 authoritative active=true 才推 true（错误时绝不显示「签退」）。
// - 每个 tab 页有独立的 custom-tab-bar 实例，故由 custom-tab-bar 与签到 Hub 各自在 show 时刷新，
//   本 helper 负责合并同一批次请求，保证一次页面切换最多一次 G1 网络请求。
// =========================================================================

export type ServiceActiveState =
  | { kind: 'GUEST' }
  | { kind: 'NO_ACTIVE' }
  | { kind: 'ACTIVE'; activityPublicId: string; checkinAt: number | null }
  | { kind: 'ERROR' };

/** 同一次页面切换内合并请求（单次飞行 + 极短窗口）。这不是状态缓存：窗口仅用于避免重复请求。 */
const COALESCE_WINDOW_MS = 1000;
let inflight: Promise<ServiceActiveState> | null = null;
let lastSettled: ServiceActiveState | null = null;
let lastSettledAt = 0;

/** 把「服务进行中」推给 custom-tab-bar（page 为 tab 页面时）或组件自身（page 为 tabBar 时）。 */
export function applyServiceActive(page: any, active: boolean): void {
  if (!page) return;
  const tabBar = typeof page.getTabBar === 'function' ? page.getTabBar() : null;
  if (tabBar && typeof tabBar.setServiceActive === 'function') {
    tabBar.setServiceActive(!!active);
    return;
  }
  if (typeof page.setServiceActive === 'function') page.setServiceActive(!!active);
}

/** 拉取权威 G1 状态并同步中心按钮；返回结果供调用方（签到 Hub）渲染自身 UI。 */
export async function refreshServiceActive(page?: any): Promise<ServiceActiveState> {
  // Guest：不发请求、不触发登录。
  if (!hasV2Session()) {
    applyServiceActive(page, false);
    return { kind: 'GUEST' };
  }

  let state: ServiceActiveState;
  if (inflight) {
    state = await inflight;
  } else if (lastSettled && Date.now() - lastSettledAt < COALESCE_WINDOW_MS) {
    state = lastSettled;
  } else {
    const task = activityApi
      .getMyActiveAttendanceSession()
      .then((res): ServiceActiveState => {
        if (res && res.active === true && res.session && res.session.activity_public_id) {
          return {
            kind: 'ACTIVE',
            activityPublicId: res.session.activity_public_id,
            checkinAt: res.session.checkin_at == null ? null : Number(res.session.checkin_at),
          };
        }
        return { kind: 'NO_ACTIVE' };
      })
      .catch((): ServiceActiveState => ({ kind: 'ERROR' }))
      .then((s) => {
        lastSettled = s;
        lastSettledAt = Date.now();
        inflight = null;
        return s;
      });
    inflight = task;
    state = await task;
  }

  applyServiceActive(page, state.kind === 'ACTIVE');
  return state;
}
