// pages/sign/activity/index.ts —— 具体活动考勤执行页（NON-TAB）
//
// 背景（P0-A 冻结裁决）：
//   pages/sign/sign 升为 tabBar 中心页后，微信限制「navigateTo 不可跳转 tabBar 页」、
//   「switchTab 不支持 query 参数」，带 activityId / participationId 的签到执行流无法继续落在 tab 页。
//   故拆出本 NON-TAB 执行页承接具体活动的 checkin / checkout / refresh status / 活动上下文。
//
// 纪律：
//   - 本页逻辑从 pages/sign/sign.ts 原样迁移，未新增/未修改任何业务规则。
//   - 所有数据请求走 activityApi（/api/v2），绝不回退 legacy PHP。
//   - 本轮刻意不实现：QR / 数字码 / G1 active-session API / 新 attendance backend /
//     location 新逻辑 / 异常管理 / service completion / 任何新业务规则。
import activityApi from '../../../utils/activityApi';

function decode(s?: string): string {
  if (!s) return '';
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

Page({
  data: {
    activityId: '',
    participationId: '',
    // 0=待签到 1=已签到 2=已完成
    checkinStatus: 0,
    activityInfo: null as any,
    isChecking: false,
    buttonDisabled: false,
    countdown: '',
    loading: true,
  },

  onLoad(options: any) {
    const activityId = (options && options.activityId) || '';
    const participationId = (options && options.participationId) || '';
    // G1：由签到 Hub 进入（mode=active）。
    // 「已签到」这一事实来自 Hub 刚刚取得的权威 GET /attendance-sessions/me active=true，
    // 不是客户端猜测 / 不是 storage 旧值。签退 API（POST /activities/:id/attendance/checkout）
    // 只要求 activity public id，因此此处不要求 participationId。
    const activeEntry = (options && options.mode) === 'active';
    const hasActivityName = !!(options && options.activityName);
    const activityInfo: any = {
      activity_name: hasActivityName ? decode(options.activityName) : '志愿活动',
      start_time: (options && options.startTime) || '',
      end_time: (options && options.endTime) || '',
      radius: Number(options && options.radius) || 300,
      checkin_points: Number(options && options.points) || 10,
      location_lat: options && options.location_lat ? Number(options.location_lat) : undefined,
      location_lng: options && options.location_lng ? Number(options.location_lng) : undefined,
      status: (options && options.status) || 'ongoing',
    };

    this.setData({
      activityId,
      participationId,
      activityInfo,
      // activeEntry → 已进入「已签到」态，主按钮为签退；否则沿用原「等待签到」态。
      checkinStatus: activeEntry ? 1 : 0,
      // 签退不需要 participationId；签到仍旧要求（缺参数时原样禁用，不猜测）。
      buttonDisabled: activeEntry ? !activityId : !activityId || !participationId,
      loading: false,
    });

    // 由 Hub 进入时没有 activityName 等上下文，用既有详情接口补齐活动信息（失败静默）。
    if (!hasActivityName && activityId) this.loadActivityDetail();
  },

  onShow() {
    // 本地状态为事实来源；如需刷新可点「刷新状态」。无独立 SELF 签到状态 GET。
  },

  // 最佳努力获取定位（签到点 GPS 校验）
  getLocation(): Promise<{ latitude: number; longitude: number; accuracy: number | null } | null> {
    return new Promise((resolve) => {
      wx.getLocation({
        type: 'gcj02',
        success: (res: any) =>
          resolve({ latitude: res.latitude, longitude: res.longitude, accuracy: res.accuracy || null }),
        fail: () => resolve(null),
      });
    });
  },

  // 签到（v2：POST /activities/:activityId/attendance/checkin）
  async onSigninTap() {
    const { activityId, participationId, isChecking } = this.data;
    if (isChecking) return;
    if (!activityId || !participationId) {
      wx.showToast({ title: '缺少签到参数，请重新进入', icon: 'none' });
      return;
    }

    this.setData({ isChecking: true });
    let location: any = null;
    try {
      location = await this.getLocation();
    } catch (e) {
      location = null;
    }

    activityApi
      .checkin(activityId, participationId, location)
      .then(() => {
        this.setData({ isChecking: false, checkinStatus: 1 });
        wx.showToast({ title: '签到成功', icon: 'success' });
      })
      .catch((err: any) => {
        this.setData({ isChecking: false });
        const code = err && err.code ? String(err.code).toUpperCase() : '';
        if (code === 'ATTENDANCE_ALREADY_CHECKED_IN') {
          this.setData({ checkinStatus: 1 });
          wx.showToast({ title: '您已签到', icon: 'none' });
          return;
        }
        if (code === 'ATTENDANCE_NOT_SIGNED_UP') {
          wx.showToast({ title: '请先完成报名', icon: 'none' });
          return;
        }
        if (code === 'TEAM_SCOPE_REQUIRED') {
          wx.showToast({ title: '请先在「我的团队」选择团队', icon: 'none' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '签到失败', icon: 'none' });
      });
  },

  // 签退（v2：POST /activities/:activityId/attendance/checkout，触发服务记录结算 + 积分）
  onSignoutTap() {
    const { activityId, isChecking } = this.data;
    if (isChecking) return;
    if (!activityId) {
      wx.showToast({ title: '缺少签退参数', icon: 'none' });
      return;
    }

    this.setData({ isChecking: true });
    activityApi
      .checkout(activityId)
      .then(() => {
        this.setData({ isChecking: false, checkinStatus: 2 });
        wx.showToast({ title: '签退成功，积分已计入', icon: 'success' });
        // 返回活动详情页，触发其 onShow 真实刷新「已参与」态（不本地伪造）
        setTimeout(() => {
          const pages = getCurrentPages();
          if (pages && pages.length > 1) wx.navigateBack();
        }, 1200);
      })
      .catch((err: any) => {
        this.setData({ isChecking: false });
        const code = err && err.code ? String(err.code).toUpperCase() : '';
        if (code === 'ATTENDANCE_ALREADY_CHECKED_OUT') {
          this.setData({ checkinStatus: 2 });
          wx.showToast({ title: '您已签退', icon: 'none' });
          return;
        }
        if (code === 'ATTENDANCE_CHECKIN_REQUIRED') {
          this.setData({ checkinStatus: 0 });
          wx.showToast({ title: '请先签到', icon: 'none' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '签退失败', icon: 'none' });
      });
  },

  // 刷新活动信息（v2：GET /activities/:id）
  loadActivityDetail() {
    const { activityId } = this.data;
    if (!activityId) return;
    activityApi.getActivity(activityId).then((res) => {
      const a = (res && res.activity) || ({} as any);
      const info = this.data.activityInfo || ({} as any);
      this.setData({
        activityInfo: {
          ...info,
          activity_name: a.title || info.activity_name || '志愿活动',
          start_time: a.start_time || info.start_time || '',
          end_time: a.end_time || info.end_time || '',
          radius: a.signin_radius || info.radius || 300,
          checkin_points: a.points_reward || info.checkin_points || 10,
          location_lat: a.location_lat !== undefined ? a.location_lat : info.location_lat,
          location_lng: a.location_lng !== undefined ? a.location_lng : info.location_lng,
          status: a.status === 1 || a.status === 2 ? 'ongoing' : info.status || 'ended',
        },
      });
    }).catch(() => {});
  },

  // 刷新状态：v2 无独立 SELF 签到状态 GET，本地状态为事实来源，刷新活动信息即可。
  loadCheckinStatus() {
    this.loadActivityDetail();
  },

  // 查看地图（若有经纬度）
  viewLocation() {
    const info = this.data.activityInfo;
    if (info && info.location_lat && info.location_lng) {
      wx.openLocation({
        latitude: Number(info.location_lat),
        longitude: Number(info.location_lng),
        name: info.activity_name || '活动地点',
        fail: () => wx.showToast({ title: '无法打开地图', icon: 'none' }),
      });
    } else {
      wx.showToast({ title: '暂无位置信息', icon: 'none' });
    }
  },
});
