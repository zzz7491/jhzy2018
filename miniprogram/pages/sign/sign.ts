// pages/sign/sign.ts —— 志愿者核心闭环：签到 / 签退（P30-P1B，v2）
// 对应 sign.wxml 的 checkin/checkout 交互：onSigninTap / onSignoutTap / loadActivityDetail / viewLocation / loadCheckinStatus。
// 所有数据请求走 activityApi（/api/v2），绝不回退 legacy PHP。
import activityApi from '../../utils/activityApi';

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
    const activityInfo: any = {
      activity_name: decode(options && options.activityName) || '志愿活动',
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
      buttonDisabled: !activityId || !participationId,
      loading: false,
    });
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
