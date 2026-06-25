// 请求工具
const request = {
  post: function(url: string, data: any = {}) {
    return new Promise((resolve, reject) => {
      let token = '';
      try {
        token = wx.getStorageSync('access_token') || '';
      } catch (e) {
        console.warn('获取token失败:', e);
      }

      console.log('POST请求:', url, data);

      wx.request({
        url: 'https://api.jhzyfw.com/api/' + url,
        method: 'POST',
        header: {
          'Authorization': token ? 'Bearer ' + token : '',
          'Content-Type': 'application/json'
        },
        data: data,
        success: (res: any) => {
          console.log('POST响应:', res.data);
          resolve(res.data);
        },
        fail: (err: any) => {
          console.error('POST请求失败:', err);
          reject(err);
        }
      });
    });
  },

  get: function(url: string, data: any = {}) {
    return new Promise((resolve, reject) => {
      let token = '';
      try {
        token = wx.getStorageSync('access_token') || '';
      } catch (e) {
        console.warn('获取token失败:', e);
      }

      let fullUrl = 'https://api.jhzyfw.com/api/' + url;
      const params = [];
      for (const key in data) {
        if (data[key] !== undefined && data[key] !== null) {
          params.push(key + '=' + encodeURIComponent(data[key]));
        }
      }
      if (params.length > 0) {
        fullUrl += '?' + params.join('&');
      }

      console.log('GET请求:', fullUrl);

      wx.request({
        url: fullUrl,
        method: 'GET',
        header: {
          'Authorization': token ? 'Bearer ' + token : '',
          'Content-Type': 'application/json'
        },
        success: (res: any) => {
          console.log('GET响应:', res.data);
          resolve(res.data);
        },
        fail: (err: any) => {
          console.error('GET请求失败:', err);
          reject(err);
        }
      });
    });
  }
};

Page({
  data: {
    activityId: 0,
    signinId: 0,
    activityTitle: '',

    hours: 0,
    minutes: 0,
    seconds: 0,
    totalSeconds: 0,
    displayText: '00:00:00',
    serviceDisplay: '0分钟',

    isActive: false,
    isLoading: true,
    minimumReached: false,
    minutesLeft: 30,
    progressPercent: 0,

    frontendTimer: null as any,
    syncTimer: null as any,

    syncInterval: 30000,

    errorMessage: ''
  },

  onLoad(options: any) {
    console.log('计时页面参数:', options);

    const activityId = parseInt(options.activity_id || 0);
    const signinId = parseInt(options.signin_id || 0);

    if (!activityId && !signinId) {
      wx.showToast({
        title: '参数错误',
        icon: 'none',
        complete: () => {
          setTimeout(() => wx.navigateBack(), 1500);
        }
      });
      return;
    }

    this.setData({
      activityId: activityId,
      signinId: signinId
    });

    this.initTimer();
  },

  onUnload() {
    this.stopAllTimers();
    wx.removeStorageSync('current_timer');
  },

  onHide() {
    if (this.data.syncTimer) {
      clearInterval(this.data.syncTimer);
      this.setData({ syncTimer: null });
    }
  },

  onShow() {
    if (this.data.isActive && !this.data.syncTimer) {
      this.startSyncTimer();
    }
  },

  async initTimer() {
    this.setData({ isLoading: true });

    try {
      const initData = await this.getInitialTime();
      if (!initData) {
        throw new Error('获取计时信息失败');
      }

      this.setData({
        activityTitle: initData.activity_title,
        totalSeconds: initData.service_seconds,
        hours: initData.hours,
        minutes: initData.minutes,
        seconds: initData.seconds,
        displayText: initData.display_text,
        serviceDisplay: initData.service_display,
        minimumReached: initData.minimum_reached,
        minutesLeft: initData.minimum_minutes_left,
        progressPercent: initData.progress_percent,
        isActive: true,
        isLoading: false
      });

      this.updateDisplay();
      this.startFrontendTimer();
      this.startSyncTimer();
      this.saveToStorage();

    } catch (error: any) {
      console.error('初始化计时器失败:', error);
      this.setData({
        isLoading: false,
        errorMessage: error.message || '初始化失败'
      });

      wx.showToast({
        title: '加载计时信息失败',
        icon: 'none',
        duration: 2000
      });
    }
  },

  async getInitialTime() {
    const params: any = {};
    if (this.data.signinId) {
      params.signin_id = this.data.signinId;
    } else if (this.data.activityId) {
      params.activity_id = this.data.activityId;
    }

    const res: any = await request.get('get_current_timing.php', params);

    if (res && res.code === 0) {
      return res.data;
    } else {
      throw new Error(res?.message || '获取时间失败');
    }
  },

  startFrontendTimer() {
    if (this.data.frontendTimer) {
      clearInterval(this.data.frontendTimer);
    }

    const timer = setInterval(() => {
      const newSeconds = this.data.totalSeconds + 1;

      this.setData({
        totalSeconds: newSeconds,
        hours: Math.floor(newSeconds / 3600),
        minutes: Math.floor((newSeconds % 3600) / 60),
        seconds: newSeconds % 60
      });

      this.updateDisplay();

      if (newSeconds % 30 === 0) {
        this.checkMinimumDuration();
      }

    }, 1000);

    this.setData({ frontendTimer: timer });
  },

  startSyncTimer() {
    if (this.data.syncTimer) {
      clearInterval(this.data.syncTimer);
    }

    const syncTimer = setInterval(async () => {
      await this.syncWithBackend();
    }, this.data.syncInterval);

    this.setData({ syncTimer });
  },

  async syncWithBackend() {
    try {
      const syncData: any = {
        frontend_seconds: this.data.totalSeconds
      };

      if (this.data.signinId) {
        syncData.signin_id = this.data.signinId;
      } else if (this.data.activityId) {
        syncData.activity_id = this.data.activityId;
      }

      const res: any = await request.post('calculate_service_duration.php', syncData);

      if (res && res.code === 0) {
        const backendSeconds = res.data.backend_seconds;
        const timeDiff = Math.abs(backendSeconds - this.data.totalSeconds);

        if (timeDiff > 10) {
          console.log(`时间同步：前端${this.data.totalSeconds}秒，后端${backendSeconds}秒，差值${timeDiff}秒，进行修正`);

          this.setData({
            totalSeconds: backendSeconds,
            hours: res.data.hours,
            minutes: res.data.minutes,
            seconds: res.data.seconds
          });

          this.updateDisplay();
        }

        if (res.data.minimum_reached !== this.data.minimumReached) {
          this.setData({ minimumReached: res.data.minimum_reached });
        }
      }

    } catch (error) {
      console.warn('同步时间失败:', error);
    }
  },

  updateDisplay() {
    const h = this.data.hours;
    const m = this.data.minutes;
    const s = this.data.seconds;
    const total = this.data.totalSeconds;

    const displayText = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

    let serviceDisplay = '';
    if (h > 0) {
      serviceDisplay = `${h}小时${m}分钟`;
    } else if (m > 0) {
      serviceDisplay = `${m}分钟${s}秒`;
    } else {
      serviceDisplay = `${s}秒`;
    }

    const progressPercent = Math.min(100, (total / 1800) * 100);

    this.setData({
      displayText,
      serviceDisplay,
      progressPercent
    });
  },

  checkMinimumDuration() {
    const total = this.data.totalSeconds;
    const minimumReached = total >= 1800;

    if (minimumReached !== this.data.minimumReached) {
      this.setData({ minimumReached });

      if (minimumReached) {
        wx.showToast({
          title: '✓ 已达到最低服务时长',
          icon: 'success',
          duration: 2000
        });
      }
    }

    if (!minimumReached) {
      const minutesLeft = Math.ceil((1800 - total) / 60);
      if (minutesLeft !== this.data.minutesLeft) {
        this.setData({ minutesLeft });
      }
    }
  },

  saveToStorage() {
    wx.setStorageSync('current_timer', {
      activityId: this.data.activityId,
      signinId: this.data.signinId,
      startTime: Date.now() - (this.data.totalSeconds * 1000),
      totalSeconds: this.data.totalSeconds
    });
  },

  stopAllTimers() {
    if (this.data.frontendTimer) {
      clearInterval(this.data.frontendTimer);
      this.setData({ frontendTimer: null });
    }

    if (this.data.syncTimer) {
      clearInterval(this.data.syncTimer);
      this.setData({ syncTimer: null });
    }

    this.setData({ isActive: false });
  },

  navigateBack() {
    wx.navigateBack();
  },

  checkoutNow() {
    wx.showModal({
      title: '立即签退',
      content: '确定要结束服务并签退吗？',
      confirmText: '确认签退',
      cancelText: '继续服务',
      success: (res) => {
        if (res.confirm) {
          this.performCheckout();
        }
      }
    });
  },

  async performCheckout() {
    wx.showLoading({ title: '签退中...' });

    try {
      const params: any = {};
      if (this.data.signinId) {
        params.record_id = this.data.signinId;
      } else if (this.data.activityId) {
        params.activity_id = this.data.activityId;
      }

      const res: any = await request.post('attendance_checkout.php', params);

      wx.hideLoading();

      if (res && res.success) {
        // 停止所有定时器
        this.stopAllTimers();

        // 显示签退成功信息
        this.showCheckoutSuccess(res.data);

      } else {
        wx.showToast({
          title: res?.message || '签退失败',
          icon: 'none',
          duration: 2000
        });
      }

    } catch (error) {
      wx.hideLoading();
      console.error('签退失败:', error);
      wx.showToast({
        title: '签退失败，请重试',
        icon: 'none',
        duration: 2000
      });
    }
  },

  showCheckoutSuccess(data: any) {
    const serviceMinutes = data.duration_minutes || Math.floor(this.data.totalSeconds / 60);
    const points = data.points || 0;

    let content = '';
    if (serviceMinutes >= 30) {
      const hours = Math.floor(serviceMinutes / 60);
      const minutes = serviceMinutes % 60;
      content = `服务时长: ${hours > 0 ? hours + '小时' : ''}${minutes}分钟`;

      if (points > 0) {
        content += `\n获得积分: ${points}分`;
      }
    } else {
      content = `服务时长: ${serviceMinutes}分钟（不足30分钟，不计积分）`;
    }

    wx.showModal({
      title: '签退成功',
      content: content,
      showCancel: false,
      confirmText: '完成',
      success: () => {
        wx.reLaunch({
          url: '/pages/index/index'
        });
      }
    });
  },

  copyActivityId() {
    wx.setClipboardData({
      data: this.data.activityId.toString(),
      success: () => {
        wx.showToast({
          title: '已复制活动ID',
          icon: 'success'
        });
      }
    });
  },

  reload() {
    this.initTimer();
  }
});