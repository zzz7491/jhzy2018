// pages/sign/activity/index.ts —— 具体活动考勤执行页（NON-TAB）
//
// 背景（P0-A 冻结裁决）：
//   pages/sign/sign 升为 tabBar 中心页后，微信限制「navigateTo 不可跳转 tabBar 页」、
//   「switchTab 不支持 query 参数」，带 activityId / participationId 的签到执行流无法继续落在 tab 页。
//   故拆出本 NON-TAB 执行页承接具体活动的 checkin / checkout / refresh status / 活动上下文。
//
// P1-D（本轮）：统一签到 / 签退【体验】（Backend Authority First；仅前端 UX 收敛，不新增 / 不修改任何业务规则）。
//   - 所有数据请求走 activityApi（/api/v2），绝不回退 legacy PHP。
//   - 状态真值只来自后端 API 响应：checkin / checkout 成功后才本地置位 checkinStatus（绝不伪造）。
//   - 定位为最佳努力：GPS 不可用（权限拒绝 / GPS 关闭 / 网络定位失败）均不阻断签到，
//     后端将 location 视为可选；前端仅做非阻塞提示（P1-D ⑤⑥⑦）。
//   - 统一 loading / error / retry / transition：新增 phase + errorText 状态机（P1-D ⑭ + Phase D）。
//   - 重复签到 / 签退幂等：后端 409 → 本地直接置位，按钮立即变化（P1-D ③④⑫⑬）。
//   - 统一异常：所有错误经 reportCheckinError / reportCheckoutError 集中映射为单一 Toast 风格，
//     必要时给出错误横幅 + 重试 / 去认证（P1-D ⑧⑭）。
//   - 二维码扫码签到：当前志愿者侧无扫码入口（后端无志愿者扫码签到端点，且 QR 生成为组织方职责，
//     超出 P1-D 范围）；本页保持 checkin 仅经 activityApi（后端权威），不引入第二签到路径（P1-D ⑨⑩⑪ 记为已递延缺口）。
import activityApi from '../../../utils/activityApi';

function decode(s?: string): string {
  if (!s) return '';
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

type Phase = 'idle' | 'submitting' | 'success' | 'error';
type ErrorAction = '' | 'retry-checkin' | 'retry-checkout' | 'qualification';

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
    // P1-D：统一状态机 + 错误横幅（与 isChecking / checkinStatus 并行，仅作 UX 镜像，不影响后端真值）
    phase: 'idle' as Phase,
    errorText: '',
    errorAction: '' as ErrorAction,
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
      phase: 'idle',
      errorText: '',
      errorAction: '',
    });

    // 由 Hub 进入时没有 activityName 等上下文，用既有详情接口补齐活动信息（失败静默）。
    if (!hasActivityName && activityId) this.loadActivityDetail();
  },

  onShow() {
    // 本地状态为事实来源；如需刷新可点「刷新状态」。无独立 SELF 签到状态 GET。
  },

  // 最佳努力获取定位（签到点 GPS 校验）。
  // 返回 { location, denied, gpsOff }：任何失败均不阻断签到（后端将 location 视为可选），
  // 仅通过 denied / gpsOff 标记以便前端做非阻塞提示（P1-D ⑤⑥⑦）。
  getLocation(): Promise<{ location: { latitude: number; longitude: number; accuracy: number | null } | null; denied: boolean; gpsOff: boolean }> {
    return new Promise((resolve) => {
      wx.getLocation({
        type: 'gcj02',
        success: (res: any) =>
          resolve({
            location: { latitude: res.latitude, longitude: res.longitude, accuracy: res.accuracy || null },
            denied: false,
            gpsOff: false,
          }),
        fail: (err: any) => {
          const msg: string = (err && err.errMsg) || '';
          const denied = /auth|deny|authorize|permission/i.test(msg);
          const gpsOff = !denied && /gps|location service|enable|off/i.test(msg);
          // 定位失败：location 置 null（后端可选），仅回传原因标记，绝不伪造坐标。
          resolve({ location: null, denied, gpsOff });
        },
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

    this.setData({ isChecking: true, phase: 'submitting' as Phase, errorText: '' });
    const { location, denied, gpsOff } = await this.getLocation();
    // 非阻塞定位提示（不阻断后端签到；location 仍按后端可选语义传递 null）
    if (denied) {
      wx.showToast({ title: '未授权定位，将不影响签到', icon: 'none' });
    } else if (gpsOff) {
      wx.showToast({ title: '请开启手机定位(GPS)', icon: 'none' });
    }

    activityApi
      .checkin(activityId, participationId, location)
      .then(() => {
        // 成功后本地置位（不伪造）；保持与既有契约一致的精确 setData 形态
        this.setData({ isChecking: false, checkinStatus: 1 });
        this.setData({ phase: 'success' as Phase, errorText: '' });
        wx.showToast({ title: '签到成功', icon: 'success' });
      })
      .catch((err: any) => this.reportCheckinError(err));
  },

  // 签退（v2：POST /activities/:activityId/attendance/checkout，触发服务记录结算 + 积分）
  onSignoutTap() {
    const { activityId, isChecking } = this.data;
    if (isChecking) return;
    if (!activityId) {
      wx.showToast({ title: '缺少签退参数', icon: 'none' });
      return;
    }

    this.setData({ isChecking: true, phase: 'submitting' as Phase, errorText: '' });
    activityApi
      .checkout(activityId)
      .then(() => {
        // 成功后本地置位（不伪造）；保持与既有契约一致的精确 setData 形态
        this.setData({ isChecking: false, checkinStatus: 2 });
        this.setData({ phase: 'success' as Phase, errorText: '' });
        wx.showToast({ title: '签退成功，积分已计入', icon: 'success' });
        // 返回活动详情页，触发其 onShow 真实刷新「已参与」态（不本地伪造）
        setTimeout(() => {
          const pages = getCurrentPages();
          if (pages && pages.length > 1) wx.navigateBack();
        }, 1200);
      })
      .catch((err: any) => this.reportCheckoutError(err));
  },

  // 统一签到异常（P1-D ⑭ + ⑧）：集中映射后端错误码 → 单一 Toast 风格 + 可选错误横幅 / 重试 / 去认证。
  // 所有分支均先复位 isChecking（统一 loading 收尾），再按 code 置位或提示，绝不伪造签到态。
  reportCheckinError(err: any) {
    this.setData({ isChecking: false, phase: 'error' as Phase });
    const code = err && err.code ? String(err.code).toUpperCase() : '';

    // 幂等：已签到 → 直接置位「已签到」，按钮立即变化（P1-D ③④⑫）
    if (code === 'ATTENDANCE_ALREADY_CHECKED_IN') {
      this.setData({ checkinStatus: 1, errorText: '' });
      wx.showToast({ title: '您已签到', icon: 'none' });
      return;
    }
    if (code === 'ATTENDANCE_NOT_SIGNED_UP') {
      this.setData({ errorText: '请先完成报名', errorAction: '' });
      wx.showToast({ title: '请先完成报名', icon: 'none' });
      return;
    }
    if (code === 'ATTENDANCE_PARTICIPATION_NOT_ACTIVE') {
      this.setData({ errorText: '当前参与状态不可签到，请确认排班', errorAction: '' });
      wx.showToast({ title: '当前参与状态不可签到', icon: 'none' });
      return;
    }
    if (code === 'PARENT_MISMATCH') {
      this.setData({ errorText: '活动或场次当前不可用', errorAction: '' });
      wx.showToast({ title: '活动或场次当前不可用', icon: 'none' });
      return;
    }
    if (code === 'QUALIFICATION_REQUIRED') {
      // 资格门由后端统一 enforcement（P1-D 不复制资格规则）；给出「去认证」入口
      this.setData({ errorText: '尚不具备报名资格，请先完成志愿者认证', errorAction: 'qualification' as ErrorAction });
      wx.showToast({ title: '尚不具备报名资格', icon: 'none' });
      return;
    }
    if (code === 'TEAM_SCOPE_REQUIRED') {
      this.setData({ errorText: '请先在「我的团队」选择团队', errorAction: '' });
      wx.showToast({ title: '请先在「我的团队」选择团队', icon: 'none' });
      return;
    }

    // 网络失败（err.isNetwork）或其余未知错误：统一提示 + 重试横幅（P1-D ⑧）
    const msg =
      (err && err.message) ||
      (err && err.isNetwork ? '网络异常，请稍后重试' : '签到失败');
    this.setData({ errorText: msg, errorAction: 'retry-checkin' as ErrorAction });
    wx.showToast({ title: msg, icon: 'none' });
  },

  // 统一签退异常（同 reportCheckinError 约定）
  reportCheckoutError(err: any) {
    this.setData({ isChecking: false, phase: 'error' as Phase });
    const code = err && err.code ? String(err.code).toUpperCase() : '';

    // 幂等：已签退 → 直接置位「已完成」，按钮立即变化（P1-D ③④⑬）
    if (code === 'ATTENDANCE_ALREADY_CHECKED_OUT') {
      this.setData({ checkinStatus: 2, errorText: '' });
      wx.showToast({ title: '您已签退', icon: 'none' });
      return;
    }
    if (code === 'ATTENDANCE_CHECKIN_REQUIRED') {
      this.setData({ checkinStatus: 0, errorText: '' });
      wx.showToast({ title: '请先签到', icon: 'none' });
      return;
    }

    // 网络失败或其余未知错误：统一提示 + 重试横幅（P1-D ⑧）
    const msg =
      (err && err.message) ||
      (err && err.isNetwork ? '网络异常，请稍后重试' : '签退失败');
    this.setData({ errorText: msg, errorAction: 'retry-checkout' as ErrorAction });
    wx.showToast({ title: msg, icon: 'none' });
  },

  // 错误横幅「重试 / 去认证」入口（P1-D 统一 retry / transition）
  onRetryTap() {
    const action = this.data.errorAction;
    this.setData({ errorText: '', phase: 'idle' as Phase, errorAction: '' });
    if (action === 'retry-checkin') {
      this.onSigninTap();
    } else if (action === 'retry-checkout') {
      this.onSignoutTap();
    } else if (action === 'qualification') {
      // 后端权威资格门；跳转官方「我的」页（承载志愿者资格卡），不伪造页面
      wx.switchTab({ url: '/pages/mine/mine' });
    }
  },

  // 错误横幅「关闭」：仅清除提示，保留当前 checkinStatus（不重试、不伪造）
  onErrorDismiss() {
    this.setData({ errorText: '', phase: 'idle' as Phase, errorAction: '' });
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
