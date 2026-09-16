// pages/sign/sign.ts —— 全局考勤中心（GLOBAL ATTENDANCE HUB / TABBAR CENTER）
//
// P0-A 冻结裁决：
//   本页是 tabBar 中心页，只承担 Hub 职责，不再承接具体活动的带参签到执行流。
//   原因：微信限制「navigateTo 不可跳转 tabBar 页」且「switchTab 不支持 query 参数」，
//        activityId / participationId 无法再经由 tabBar 页传递。
//   具体活动的 checkin / checkout / refresh status 位于 NON-TAB 执行页：
//        pages/sign/activity/index
//
// G1（本轮）：接入权威接口 GET /api/v2/attendance-sessions/me。
//   - 唯一真值 = 后端响应。绝不使用 storage / 页面参数 / 当前 team / 客户端推断判定 active。
//   - 每次 onShow 重新取权威态（不长期缓存真值）。
//   - GUEST / ERROR 一律中性态「签到 / 签退」，绝不把「未知」说成「当前没有进行中的服务」。
//   - ACTIVE 是最高优先级状态：primary action 恒为「签退」，绝不呈现另一活动签到入口。
//
// 本轮刻意不实现（等授权）：QR / 数字码 / G2 guest public activity / 首页状态机 / 异常管理。
import { TAB_INDEX, syncTabSelected, refreshServiceActive, type ServiceActiveState } from '../../utils/tabbar';
import activityApi from '../../utils/activityApi';

/** checkin_at 为 Unix【秒】（后端语义）；转成本地可读时间，仅用于展示。 */
function formatCheckinAt(ts: number | null): string {
  if (ts == null) return '';
  const d = new Date(Number(ts) * 1000);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

Page({
  data: {
    // Hub 状态机：LOADING / GUEST / NO_ACTIVE / ACTIVE / ERROR
    hubState: 'LOADING' as 'LOADING' | 'GUEST' | 'NO_ACTIVE' | 'ACTIVE' | 'ERROR',
    // 中心按钮状态位（与 custom-tab-bar 同步；仅作展示镜像，真值恒来自 API）
    serviceActive: false,
    activeActivityPublicId: '',
    checkinAtText: '',
    activityTitle: '',
    refreshing: false,
  },

  onShow() {
    // P0-A：同步自定义 tabBar 选中态（2=签到/签退）；不存在 custom tabBar 时静默跳过
    syncTabSelected(this, TAB_INDEX.ATTENDANCE);
    // G1：每次进入 Hub 都重新取得权威状态
    this.refreshActiveSession();
  },

  /** 拉取权威 G1 状态并渲染 Hub。一次 onShow 最多触发一次请求（refreshServiceActive 内合并）。 */
  async refreshActiveSession() {
    if (this.data.refreshing) return;
    this.setData({ refreshing: true, hubState: 'LOADING' as any });

    const state: ServiceActiveState = await refreshServiceActive(this);

    if (state.kind === 'ACTIVE') {
      this.setData({
        refreshing: false,
        hubState: 'ACTIVE' as any,
        serviceActive: true,
        activeActivityPublicId: state.activityPublicId,
        checkinAtText: formatCheckinAt(state.checkinAt),
        activityTitle: '',
      });
      this.enrichActivityTitle(state.activityPublicId);
      return;
    }

    this.setData({
      refreshing: false,
      // GUEST / NO_ACTIVE / ERROR 都不是 active：绝不在错误时伪装成「签退」
      hubState: state.kind as any,
      serviceActive: false,
      activeActivityPublicId: '',
      checkinAtText: '',
      activityTitle: '',
    });
  },

  /**
   * 可选增强：按 activity_public_id 取活动名称（复用既有 GET /activities/:id）。
   * 硬约束：详情失败 / 为空【绝不】覆盖或降级 ACTIVE 状态，只补标题。
   */
  enrichActivityTitle(activityPublicId: string) {
    if (!activityPublicId) return;
    activityApi
      .getActivity(activityPublicId)
      .then((res: any) => {
        if (this.data.hubState !== 'ACTIVE') return;
        const a = res && res.activity ? res.activity : null;
        if (!a) return;
        this.setData({ activityTitle: a.title || '' });
      })
      .catch(() => {
        // 详情不可得不影响 active 判定：active session 才是权威
      });
  },

  // NO_ACTIVE / GUEST / ERROR：中性引导。activities 是 tabBar 页，故必须用 switchTab。
  // 不做任何自动选活动 / 自动签到 / session 猜测。
  goToActivities() {
    wx.switchTab({ url: '/pages/activities/activities' });
  },

  /**
   * ACTIVE：唯一主动作 = 签退。
   * 执行页仍旧是 pages/sign/activity/index（绝不绕过执行页直接发签退请求）。
   * 传入 mode=active：本次进入的「已签到」事实来自刚取得的权威 G1 active=true，
   * 不是客户端猜测；执行页的 buttonDisabled 不再要求 participationId（签退 API 不需要它）。
   */
  goToCheckout() {
    const activityPublicId = this.data.activeActivityPublicId;
    if (!activityPublicId) {
      wx.showToast({ title: '暂无进行中的服务', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/sign/activity/index?activityId=${activityPublicId}&mode=active`,
      fail: () => wx.showToast({ title: '页面打开失败', icon: 'none' }),
    });
  },

  // 手动刷新：用于 ERROR / 用户主动复核。不轮询、不 setInterval。
  onRefreshTap() {
    this.refreshActiveSession();
  },

  // 由 utils/tabbar.ts::applyServiceActive 回写（page 自身无 getTabBar 时）。
  setServiceActive(active: boolean) {
    this.setData({ serviceActive: !!active });
  },
});
