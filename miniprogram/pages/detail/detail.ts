// pages/activity/detail/detail.js - 简化版适配当前系统，保留保险功能

// 引入订阅消息工具
const subscribe = require('../../utils/subscribe')
import activityApi from '../../utils/activityApi';

Page({
  data: {
    activity: null,
    buttonText: "立即报名",
    buttonBgColor: "#07c160",
    isLoggedIn: false,
    hasJoined: false,
    signupStatus: 0, // 0:未报名, 1:已报名待审核, 2:已通过, 3:已参与
    userInfo: null,
    token: null,
    activityId: null,
    contactPerson: '',
    contactPhone: '',
    loading: true,
    errorMsg: '',
    activityStatus: {
      isFull: false,
      remainingSlots: 0,
      totalParticipants: 0
    },
    // 保险相关
    showInsuranceModal: false,
    insuranceQRCode: 'https://api.jhzyfw.com/static/insurance-qr.jpg',
    // 签到相关
    isCheckinActive: false,
    // 重复活动相关
    recurrenceInfo: null
  },

  onLoad(options) {
    console.log('页面加载，接收到的参数:', options);

    if (options && options.id) {
      const activityId = options.id;
      this.setData({ activityId });
      
      this.checkLoginStatus();
      this.loadActivityDetail();
    } else {
      wx.showToast({
        title: '活动不存在',
        icon: 'none'
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
    }
  },

  onShow() {
    this.checkLoginStatus();
    if (this.data.activityId) {
      this.checkSignupStatus();
      this.checkActiveCheckin();
    }
  },

  // 检查登录状态
  checkLoginStatus() {
    const token = wx.getStorageSync('access_token');
    const userInfo = wx.getStorageSync('userInfo');

    if (token && userInfo) {
      this.setData({
        isLoggedIn: true,
        userInfo,
        token
      });
      return true;
    } else {
      this.setData({
        isLoggedIn: false,
        userInfo: null,
        token: null
      });
      return false;
    }
  },

  // 是否有进行中的签到：由报名审核状态推导（v2 无独立 SELF 签到状态 GET）。
  checkActiveCheckin() {
    const { signupStatus } = this.data;
    this.setData({ isCheckinActive: signupStatus === 2 });
    this.updateButtonByStatus();
  },

  // 根据状态更新按钮
  updateButtonByStatus() {
    const { signupStatus, isCheckinActive } = this.data;
    
    let buttonText = "立即报名";
    let buttonBgColor = "#07c160";
    
    if (signupStatus === 1) {
      buttonText = "待审核";
      buttonBgColor = "#ff9800";
    } else if (signupStatus === 2) {
      if (isCheckinActive) {
        buttonText = "立即签退";
        buttonBgColor = "#ff4444";
      } else {
        buttonText = "立即签到";
        buttonBgColor = "#07c160";
      }
    } else if (signupStatus === 3) {
      buttonText = "已参与";
      buttonBgColor = "#9e9e9e";
    }
    
    this.setData({ buttonText, buttonBgColor });
  },

  // 加载活动详情（v2：GET /activities/:id）
  loadActivityDetail() {
    const activityId = this.data.activityId;
    if (!activityId) return;

    this.setData({ loading: true, errorMsg: '' });

    activityApi
      .getActivity(activityId)
      .then((res) => {
        const a: any = (res && res.activity) || {};
        const activity: any = {
          ...a,
          public_id: a.public_id,
          title: a.title || '',
          start_time: a.start_time || '',
          end_time: a.end_time || '',
          summary: a.summary || '',
          quota: a.quota || 0,
          signed_count: a.signed_count || 0,
          status: a.status,
          current_participants: a.signed_count || 0,
          max_participants: a.quota || 0,
          points_reward: 0,
          description: a.summary || '',
          cover_image: '',
          // N0-E5A：读取 V2 正式「活动主地址」（activities.address，经 GET /activities/:id 下发）。
          // 为空时 '待定' 仅为展示 fallback，不代表真实数据。
          address: typeof a.address === 'string' && a.address.trim() ? a.address.trim() : '待定',
          signin_radius: 300,
        };
        activity.display_time = this.formatDisplayTime(activity.start_time, activity.end_time);

        const maxParticipants = activity.max_participants || 0;
        const currentParticipants = activity.current_participants || 0;
        const remainingSlots = Math.max(0, maxParticipants - currentParticipants);

        this.setData({
          activity,
          contactPerson: '',
          contactPhone: '',
          activityStatus: {
            isFull: maxParticipants > 0 && remainingSlots <= 0,
            remainingSlots,
            totalParticipants: currentParticipants,
          },
          loading: false,
        });

        if (this.data.isLoggedIn) {
          this.checkSignupStatus();
        }
      })
      .catch((err: any) => {
        console.error('加载活动详情失败:', err);
        let msg = '网络错误';
        if (err && err.code === 'TEAM_SCOPE_REQUIRED') msg = '请先在「我的团队」中选择团队';
        else if (err && err.status === 404) msg = '活动不存在';
        else if (err && err.message) msg = err.message;
        this.setData({ errorMsg: msg, loading: false });
      });
  },

  // 处理活动数据
  processActivityData(activity) {
    if (!activity) return;

    if (activity.start_time) {
      activity.display_time = this.formatDisplayTime(activity.start_time, activity.end_time);
    }

    // N0-E5A：活动主地址为 activity.address（V2 已不存在 legacy activity.location）。
    activity.address = activity.address || '待定';
    activity.current_participants = activity.current_participants || 0;
    activity.max_participants = activity.max_participants || 0;
    activity.points_reward = activity.points_reward || 0;
  },

  // 处理重复活动信息
  processRecurrenceInfo(activity) {
    if (!activity) return;
    
    if (activity.recurrence_pattern && activity.recurrence_pattern !== 'once' && activity.recurrence_pattern !== '') {
      let recurrenceText = '';
      let recurrenceDetail = '';
      
      switch(activity.recurrence_pattern) {
        case 'daily': 
          recurrenceText = '每天'; 
          recurrenceDetail = '每日重复';
          break;
        case 'weekly': 
          recurrenceText = '每周'; 
          recurrenceDetail = '每周重复';
          break;
        case 'monthly': 
          recurrenceText = '每月'; 
          recurrenceDetail = '每月重复';
          break;
        default: 
          recurrenceText = activity.recurrence_pattern;
          recurrenceDetail = activity.recurrence_pattern;
      }
      
      if (activity.recurrence_days) {
        let days = [];
        if (typeof activity.recurrence_days === 'string') {
          days = activity.recurrence_days.split(',').filter(d => d.trim() !== '');
        } else if (Array.isArray(activity.recurrence_days)) {
          days = activity.recurrence_days;
        }
        
        if (days.length > 0) {
          recurrenceText += ' (';
          
          if (activity.recurrence_pattern === 'weekly') {
            const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            recurrenceText += days.map(d => {
              const dayNum = parseInt(d);
              return weekdays[dayNum] || d;
            }).join('、');
          } else {
            recurrenceText += days.join('、') + '日';
          }
          
          recurrenceText += ')';
        }
      }
      
      if (activity.recurrence_start_date && activity.recurrence_end_date) {
        const startDate = this.formatDate(activity.recurrence_start_date);
        const endDate = this.formatDate(activity.recurrence_end_date);
        recurrenceDetail = `${recurrenceText} · ${startDate} 至 ${endDate}`;
      } else {
        recurrenceDetail = recurrenceText;
      }
      
      this.setData({
        recurrenceInfo: {
          text: recurrenceText,
          detail: recurrenceDetail,
          pattern: activity.recurrence_pattern,
          days: activity.recurrence_days,
          startDate: activity.recurrence_start_date,
          endDate: activity.recurrence_end_date
        }
      });
      
      console.log('重复活动信息:', this.data.recurrenceInfo);
    } else {
      this.setData({ recurrenceInfo: null });
    }
  },

  // 格式化日期显示
  formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr.replace(/-/g, '/'));
      if (isNaN(date.getTime())) return dateStr;
      
      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      return `${year}.${month}.${day}`;
    } catch (error) {
      return dateStr;
    }
  },

  // 格式化显示时间
  formatDisplayTime(startTime, endTime) {
    if (!startTime) return '';
    
    try {
      const start = new Date(startTime.replace(/-/g, '/'));
      const end = endTime ? new Date(endTime.replace(/-/g, '/')) : null;
      
      const month = start.getMonth() + 1;
      const day = start.getDate();
      const startHours = start.getHours().toString().padStart(2, '0');
      const startMinutes = start.getMinutes().toString().padStart(2, '0');
      
      if (end) {
        const endHours = end.getHours().toString().padStart(2, '0');
        const endMinutes = end.getMinutes().toString().padStart(2, '0');
        return `${month}月${day}日 ${startHours}:${startMinutes}-${endHours}:${endMinutes}`;
      }
      
      return `${month}月${day}日 ${startHours}:${startMinutes}`;
    } catch (error) {
      return startTime;
    }
  },

  // 检查报名状态（v2：GET /activities/:id/signups/me）
  checkSignupStatus() {
    const activityId = this.data.activityId;
    if (!activityId || !this.data.isLoggedIn) return;

    activityApi
      .getSignupMe(activityId)
      .then((res) => {
        const outer = (res && res.signup) || null;
        // SignupReadView: { activity_public_id, user_public_id, signup:{ review_status, status, ... } }
        const inner = outer && outer.signup ? outer.signup : outer;
        let status = 0;
        if (inner && inner.status === 1) {
          // status=1(REGISTERED)；review_status=1(APPROVED) 才可签到
          status = inner.review_status === 1 ? 2 : 1;
        }
        this.setData({ hasJoined: status > 0, signupStatus: status });
        this.updateButtonByStatus();
      })
      .catch(() => {
        // 未报名或无权限查看：保持未报名态，绝不回退 legacy PHP
        this.setData({ hasJoined: false, signupStatus: 0 });
      });
  },

  // 获取报名状态文本
  getSignupStatusText(status) {
    switch (status) {
      case 1: return '您的报名正在审核中';
      case 2: return '您已通过审核，可以签到';
      case 3: return '您已参与此活动';
      default: return '您已报名此活动';
    }
  },

  // 主按钮点击处理
  handleMainButtonClick() {
    const { signupStatus } = this.data;

    if (signupStatus === 2) {
      // 已通过审核：进入「参与准备 → 签到」闭环
      this.proceedToCheckin();
    } else if (signupStatus === 1) {
      wx.showToast({ title: '您的报名正在审核中', icon: 'none' });
    } else if (signupStatus === 3) {
      wx.showToast({ title: '您已参与此活动', icon: 'none' });
    } else {
      this.handleJoinClick();
    }
  },

  // 点击报名按钮
  handleJoinClick() {
    if (this.data.hasJoined) {
      wx.showToast({
        title: this.getSignupStatusText(this.data.signupStatus),
        icon: 'none'
      });
      return;
    }

    if (!this.data.isLoggedIn) {
      wx.navigateTo({
        url: '/pages/profile/login/login'
      });
      return;
    }

    if (this.data.activityStatus.isFull) {
      wx.showToast({
        title: '活动名额已满',
        icon: 'none'
      });
      return;
    }

    this.showConfirmDialog();
  },

  // 显示确认报名弹窗
  showConfirmDialog() {
    const activityName = this.data.activity ? this.data.activity.title : '活动';
    const activity = this.data.activity;
    
    wx.showModal({
      title: '确认报名',
      content: `确认报名「${activityName}」吗？\n\n活动前建议购买保险保障安全`,
      confirmText: '确认报名',
      cancelText: '购买保险',
      success: (res) => {
        if (res.confirm) {
          this.processJoin()
        } else if (res.cancel) {
          this.onBuyInsurance();
        }
      }
    });
  },

  // 处理报名（v2：POST /activities/:id/signups）
  processJoin() {
    if (this.data.hasJoined) {
      wx.showToast({ title: this.getSignupStatusText(this.data.signupStatus), icon: 'none' });
      return;
    }
    if (!this.data.isLoggedIn) {
      wx.navigateTo({ url: '/pages/profile/login/login' });
      return;
    }
    if (this.data.activityStatus.isFull) {
      wx.showToast({ title: '活动名额已满', icon: 'none' });
      return;
    }

    const activityId = this.data.activityId;
    wx.showLoading({ title: '报名中...', mask: true });

    activityApi
      .signup(activityId)
      .then(() => {
        wx.hideLoading();
        this.setData({ hasJoined: true, signupStatus: 2 });
        this.updateButtonByStatus();

        subscribe.subscribeAfterSignup().catch(() => {});
        wx.showToast({ title: '报名成功', icon: 'success', duration: 1500 });

        // 报名成功后进入「参与准备 → 签到」闭环
        this.proceedToCheckin();
      })
      .catch((err: any) => {
        wx.hideLoading();
        const code = err && err.code ? String(err.code).toUpperCase() : '';
        if (code === 'SIGNUP_ALREADY_EXISTS' || code === 'CONFLICT') {
          this.setData({ hasJoined: true, signupStatus: 2 });
          this.updateButtonByStatus();
          this.proceedToCheckin();
          return;
        }
        if (code === 'ACTIVITY_SIGNUP_CLOSED') {
          wx.showToast({ title: '活动报名已关闭', icon: 'none' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '报名失败', icon: 'none' });
      });
  },

  /**
   * 参与准备（v2）：GET setup → 找到可确定性物化的 occurrence → POST ensure 拿到 participation_public_id，
   * 然后跳转签到页（/pages/sign/sign）完成签到 / 签退闭环。
   * 若活动尚未通过审核 / 需人工排班（无 can_ensure 的 occurrence），则仅提示，不强制跳转。
   */
  proceedToCheckin() {
    const activityId = this.data.activityId;
    const activity = this.data.activity || ({} as any);

    activityApi
      .getParticipationSetup(activityId)
      .then((setup) => {
        const occurrences = (setup && setup.occurrences) || [];
        const occ = occurrences.find((o: any) => o.can_ensure === true);
        if (!occ) {
          wx.showToast({
            title: '报名已提交，审核/排班后可在「签到」页签到',
            icon: 'none',
            duration: 2000,
          });
          return Promise.resolve(null);
        }
        return activityApi
          .ensureParticipation(activityId, occ.public_id)
          .then((res) => {
            const ppid = res && res.participation && res.participation.public_id;
            if (!ppid) {
              wx.showToast({ title: '报名已提交，可在「签到」页签到', icon: 'none', duration: 2000 });
              return null;
            }
            const title = encodeURIComponent(activity.title || '志愿活动');
            const points = activity.points_reward || 10;
            const radius = activity.signin_radius || 300;
            const status = activity.status === 1 || activity.status === 2 ? 'ongoing' : 'ended';
            wx.navigateTo({
              url: `/pages/sign/sign?activityId=${activityId}&participationId=${ppid}&activityName=${title}&points=${points}&radius=${radius}&status=${status}`,
            });
            return ppid;
          });
      })
      .catch((err: any) => {
        console.error('参与准备失败', err);
        wx.showToast({ title: '报名已提交，稍后可在「签到」页签到', icon: 'none', duration: 2000 });
      });
  },

  // ========== 保险购买功能 ==========
  onBuyInsurance() {
    this.setData({
      showInsuranceModal: true
    });
  },

  closeInsuranceModal() {
    this.setData({
      showInsuranceModal: false
    });
  },

  saveInsuranceQRCode() {
    const qrcodeUrl = this.data.insuranceQRCode;

    wx.showLoading({
      title: '保存中...',
      mask: true
    });

    wx.downloadFile({
      url: qrcodeUrl,
      success: (res) => {
        if (res.statusCode === 200) {
          wx.saveImageToPhotosAlbum({
            filePath: res.tempFilePath,
            success: () => {
              wx.hideLoading();
              wx.showToast({
                title: '保存成功',
                icon: 'success',
                duration: 2000
              });

              this.closeInsuranceModal();
            },
            fail: (err) => {
              wx.hideLoading();
              console.error('保存到相册失败:', err);

              if (err.errMsg.includes('auth deny') || err.errMsg.includes('authorized')) {
                wx.showModal({
                  title: '需要相册权限',
                  content: '保存二维码需要访问您的相册权限',
                  confirmText: '去设置',
                  success: (modalRes) => {
                    if (modalRes.confirm) {
                      wx.openSetting();
                    }
                  }
                });
              } else {
                wx.showToast({
                  title: '保存失败',
                  icon: 'none'
                });
              }
            }
          });
        }
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('下载二维码失败:', err);
        wx.showToast({
          title: '下载失败',
          icon: 'none'
        });
      }
    });
  },

  // ========== 辅助函数 ==========
  goBack() {
    wx.navigateBack();
  },

  formatDateTime(isoString) {
    if (!isoString) return '';

    try {
      const date = new Date(isoString.replace(/-/g, '/'));
      if (isNaN(date.getTime())) return isoString;

      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');

      return `${year}-${month}-${day} ${hours}:${minutes}`;
    } catch (error) {
      return isoString;
    }
  },

  onShareAppMessage() {
    const title = this.data.activity ? `${this.data.activity.title} - 志愿者活动` : '志愿者活动';
    return {
      title,
      path: `pages/detail/detail?id=${this.data.activityId}`
    };
  }
});