import checkinService from '../../../services/checkinService';
import deviceFingerprint from '../../../utils/device';
import locationService from '../../../services/location';

// 1. 保留你原有的原生请求封装工具（一字未删）
const request = {
  get: function(url, data = {}) {
    return new Promise((resolve, reject) => {
      let token = '';
      try { token = wx.getStorageSync('access_token') || ''; } catch (e) {}
      let fullUrl = 'https://api.jhzyfw.com/api/' + url;
      const params = [];
      for (const key in data) {
        if (data[key] !== undefined && data[key] !== null) {
          params.push(key + '=' + encodeURIComponent(data[key]));
        }
      }
      if (params.length > 0) fullUrl += '?' + params.join('&');
      wx.request({
        url: fullUrl,
        method: 'GET',
        header: { 'Authorization': token ? 'Bearer ' + token : '', 'Content-Type': 'application/json' },
        success: (res) => resolve(res.data),
        fail: (err) => reject(err)
      });
    });
  },
  post: function(url, data = {}) {
    return new Promise((resolve, reject) => {
      let token = '';
      try { token = wx.getStorageSync('access_token') || ''; } catch (e) {}
      wx.request({
        url: 'https://api.jhzyfw.com/api/' + url,
        method: 'POST',
        header: { 'Authorization': token ? 'Bearer ' + token : '', 'Content-Type': 'application/json' },
        data: data,
        success: (res) => resolve(res.data),
        fail: (err) => reject(err)
      });
    });
  }
};

Page({
  data: {
    activityId: null,
    pageType: 'signin',
    userLat: null,
    userLng: null,
    activity: null,
    locationStatus: 'checking',
    distance: 0,
    isWithinRange: false,
    checkinTime: null,
    duration: 0,
    timer: null,
    isLoading: true,
    isSubmitting: false,
    canProceed: false,
    currentTime: '',
    locationMonitorTimer: null,
    monitoringActivityId: null
  },

  onLoad(options) {
    this.updateCurrentTime();
    const timeInterval = setInterval(() => this.updateCurrentTime(), 1000);
    this.setData({ timeInterval: timeInterval });

    const { activity_id, page_type } = options;
    let finalActivityId = activity_id || 1; 
    
    if (finalActivityId) {
      this.setData({
        activityId: parseInt(finalActivityId),
        pageType: page_type || 'signin'
      });
      this.loadActivityData();
    } else {
      wx.showToast({ title: '参数错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
    }
  },

  onUnload() {
    this.stopTimer();
    this.stopLocationMonitoring();
    if (this.data.timeInterval) clearInterval(this.data.timeInterval);
  },

  onHide() { this.stopLocationMonitoring(); },
  onShow() {
    if (this.data.monitoringActivityId) this.startLocationMonitoring(this.data.monitoringActivityId);
  },

  updateCurrentTime() {
    this.setData({ currentTime: new Date().toLocaleTimeString() });
  },

  // 2. 加载活动数据
  async loadActivityData() {
    try {
      const res = await request.get('activity_detail_for_sign_fixed.php', { activity_id: this.data.activityId });
      if (res && (res.code === 0 || res.code === 200)) {
        const activity = res.data || {};
        if (activity.latitude) activity.latitude = parseFloat(activity.latitude);
        if (activity.longitude) activity.longitude = parseFloat(activity.longitude);
        if (activity.location_radius) activity.location_radius = parseInt(activity.location_radius);

        this.setData({ activity: activity, isLoading: false });
        this.checkLocation();

        if (this.data.pageType === 'signout') this.getCheckinTime();
      } else {
        throw new Error('获取失败');
      }
    } catch (error) {
      this.setData({ isLoading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  // 3. 严格强制的高精度定位（删除了作弊后门）
  getUserLocation() {
    return new Promise((resolve, reject) => {
      wx.getLocation({
        type: 'gcj02', // 腾讯地图高精度坐标系
        isHighAccuracy: true,
        success: resolve,
        fail: (err) => {
          wx.showModal({
            title: '定位失败',
            content: '请确保手机GPS已开启并授权微信定位，否则无法签到/签退。',
            showCancel: false
          });
          reject(err);
        }
      });
    });
  },

  // 4. 检查位置状态
  async checkLocation() {
    this.setData({ locationStatus: 'checking' });
    try {
      const location = await this.getUserLocation();
      const userLat = location.latitude;
      const userLng = location.longitude;
      this.setData({ userLat, userLng });

      if (!this.data.activity || !this.data.activity.latitude) {
        // 如果活动本身没设地点，默认放行
        this.setData({ locationStatus: 'success', isWithinRange: true, canProceed: true, distance: 0 });
        return;
      }

      const activityLat = this.data.activity.latitude;
      const activityLng = this.data.activity.longitude;
      const radius = this.data.activity.location_radius || 500;

      const distance = this.calculateDistance(userLat, userLng, activityLat, activityLng);
      const isWithinRange = distance <= radius;

      this.setData({
        distance: distance,
        isWithinRange: isWithinRange,
        locationStatus: isWithinRange ? 'success' : 'failed',
        canProceed: isWithinRange
      });

      if (!isWithinRange && distance < 10000) {
        wx.showToast({ title: `距离活动地点${distance}米，超出范围`, icon: 'none', duration: 3000 });
      }
    } catch (error) {
      this.setData({ locationStatus: 'failed', canProceed: false });
    }
  },

  calculateDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
    const R = 6371000; 
    const toRad = (v) => (v * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  },

  // --- 定时与时长功能保留 ---
  async getCheckinTime() {
    try {
      const res = await request.get('get_checkin_time.php', { activity_id: this.data.activityId });
      if (res && res.code === 0 && res.data && res.data.checkin_time) {
        this.setData({ checkinTime: new Date(res.data.checkin_time).getTime() });
        this.startTimer();
      }
    } catch (error) {}
  },

  startTimer() {
    this.stopTimer();
    const updateTimer = () => {
      if (this.data.checkinTime) {
        this.setData({ duration: Math.floor((Date.now() - this.data.checkinTime) / 1000) });
      }
    };
    updateTimer();
    this.setData({ timer: setInterval(updateTimer, 1000) });
  },

  stopTimer() {
    if (this.data.timer) { clearInterval(this.data.timer); this.setData({ timer: null }); }
  },

  formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}小时${m}分${s}秒`;
    return m > 0 ? `${m}分${s}秒` : `${s}秒`;
  },

  // --- 防作弊：打卡核心操作 ---
  async confirmSignin() {
    // 强制再次刷新定位，防止人跑了才点按钮
    wx.showLoading({ title: '校验位置...', mask: true });
    await this.checkLocation();
    wx.hideLoading();

    if (!this.data.canProceed) return wx.showToast({ title: '请进入活动范围内再签到', icon: 'none' });
    if (this.data.isSubmitting) return;
    this.setData({ isSubmitting: true });

    try {
      const deviceInfo = await deviceFingerprint.getBasicDeviceInfo();
      const signinData = {
        activity_id: this.data.activityId,
        latitude: this.data.userLat,
        longitude: this.data.userLng,
        device_info: deviceInfo,
        timestamp: Date.now()
      };

      const result = await checkinService.checkIn(signinData);

      if (result.success) {
        await this.startLocationMonitoring(this.data.activityId);
        wx.redirectTo({ url: `/pages/activities/timer/timer?activity_id=${this.data.activityId}&signin_id=${result.data.record_id}` });
      } else {
        wx.showModal({ title: '签到失败', content: result.message || '签到失败', showCancel: false });
      }
    } finally {
      this.setData({ isSubmitting: false });
    }
  },

  async confirmSignout() {
    // 强制再次刷新定位，防止云签退
    wx.showLoading({ title: '校验位置...', mask: true });
    await this.checkLocation();
    wx.hideLoading();

    if (!this.data.canProceed) return wx.showToast({ title: '请进入活动范围内再签退', icon: 'none' });

    const durationMinutes = Math.ceil(this.data.duration / 60);
    if (durationMinutes < 30) {
      wx.showModal({
        title: '签退提醒',
        content: `服务时长仅${durationMinutes}分钟，不足30分钟将无法获得积分\n确定要签退吗？`,
        confirmText: '仍要签退',
        cancelText: '继续服务',
        success: (res) => { if (res.confirm) this.processSignout(); }
      });
    } else {
      this.processSignout();
    }
  },

  async processSignout() {
    if (this.data.isSubmitting) return;
    this.setData({ isSubmitting: true });
    wx.showLoading({ title: '正在签退...', mask: true });

    try {
      const deviceInfo = await deviceFingerprint.getBasicDeviceInfo();
      const signoutData = {
        activity_id: this.data.activityId,
        latitude: this.data.userLat,
        longitude: this.data.userLng,
        device_info: deviceInfo,
        duration: this.data.duration,
        timestamp: Date.now()
      };

      const result = await checkinService.checkOut(signoutData);
      wx.hideLoading();

      if (result.success) {
        this.stopLocationMonitoring();

        // --- 核心修复：对接证书信号 ---
        let content = `服务时长：${this.formatDuration(this.data.duration)}`;
        if (result.data && result.data.points > 0) {
          content += `\n获得积分：${result.data.points}分`;
        } else {
          content += `\n不足30分钟，不计积分`;
        }

        if (result.data && result.data.cert_triggered) {
          content += `\n\n🎉 恭喜！您已达到2小时，系统已为您颁发了电子证书！`;
        }

        wx.showModal({
          title: '签退成功',
          content: content,
          showCancel: false,
          success: () => this.navigateBackWithRefresh()
        });
      } else {
        wx.showModal({ title: '签退失败', content: result.message, showCancel: false });
      }
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ isSubmitting: false });
    }
  },

  // 监控与辅助功能保留
  async startLocationMonitoring(activityId) {
    this.stopLocationMonitoring();
    try {
      await locationService.startMonitoring(activityId, this.data.userLat, this.data.userLng);
      this.setData({ monitoringActivityId: activityId });
    } catch (e) {}
  },
  stopLocationMonitoring() {
    if (this.data.monitoringActivityId) {
      locationService.stopMonitoring(this.data.monitoringActivityId);
      this.setData({ monitoringActivityId: null });
    }
  },

  navigateBackWithRefresh() {
    const pages = getCurrentPages();
    if (pages.length >= 2 && pages[pages.length - 2].refreshData) {
      pages[pages.length - 2].refreshData();
    }
    wx.navigateBack();
  },
  async refreshLocation() { await this.checkLocation(); },
  cancel() { wx.navigateBack(); }
});