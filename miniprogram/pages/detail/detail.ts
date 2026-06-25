// pages/activity/detail/detail.js - 简化版适配当前系统，保留保险功能

// 引入订阅消息工具
const subscribe = require('../../utils/subscribe')

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
    activeCheckinId: null,
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

  // 检查是否有进行中的签到
  checkActiveCheckin() {
    const activityId = this.data.activityId;
    if (!activityId || !this.data.isLoggedIn) return;

    wx.request({
      url: 'https://api.jhzyfw.com/api/attendance_active.php',
      method: 'GET',
      header: {
        'Authorization': `Bearer ${this.data.token}`
      },
      data: { activity_id: activityId },
      success: (res) => {
        console.log('活动签到状态:', res.data);
        if (res.data && res.data.success) {
          const active = res.data.data;
          if (active && active.length > 0) {
            this.setData({
              isCheckinActive: true,
              activeCheckinId: active[0].id
            });
            this.updateButtonByStatus();
          } else {
            this.setData({
              isCheckinActive: false,
              activeCheckinId: null
            });
            this.updateButtonByStatus();
          }
        } else {
          this.setData({
            isCheckinActive: false,
            activeCheckinId: null
          });
          this.updateButtonByStatus();
        }
      },
      fail: (err) => {
        console.error('检查签到状态失败:', err);
        this.setData({
          isCheckinActive: false,
          activeCheckinId: null
        });
      }
    });
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

  // 加载活动详情
  loadActivityDetail() {
    const activityId = this.data.activityId;
    if (!activityId) return;

    this.setData({ loading: true, errorMsg: '' });

    wx.request({
      url: `https://api.jhzyfw.com/api/activity_detail_enhanced.php?id=${activityId}`,
      method: 'GET',
      header: {
        'Authorization': this.data.token ? `Bearer ${this.data.token}` : ''
      },
      success: (res) => {
        console.log('活动详情响应:', res.data);

        if (res.data && res.data.success) {
          const activity = res.data.data || {};

          console.log('activity对象:', activity);
          
          this.processActivityData(activity);
          this.processRecurrenceInfo(activity);
          
          const currentParticipants = activity.current_participants || 0;
          const maxParticipants = activity.max_participants || 0;
          const remainingSlots = Math.max(0, maxParticipants - currentParticipants);
          
          this.setData({
            activity,
            contactPerson: activity.contact_person || '',
            contactPhone: activity.contact_phone || '',
            activityStatus: {
              isFull: maxParticipants > 0 && remainingSlots <= 0,
              remainingSlots,
              totalParticipants: currentParticipants
            },
            loading: false
          });

          if (this.data.isLoggedIn) {
            this.checkSignupStatus();
          }
        } else {
          this.setData({
            errorMsg: res.data?.message || '加载失败',
            loading: false
          });
        }
      },
      fail: (err) => {
        console.error('加载活动详情失败:', err);
        this.setData({
          errorMsg: '网络错误',
          loading: false
        });
      }
    });
  },

  // 处理活动数据
  processActivityData(activity) {
    if (!activity) return;

    if (activity.start_time) {
      activity.display_time = this.formatDisplayTime(activity.start_time, activity.end_time);
    }

    activity.address = activity.location || '待定';
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

  // 检查报名状态
  checkSignupStatus() {
    const activityId = this.data.activityId;
    if (!activityId || !this.data.isLoggedIn) return;

    wx.request({
      url: `https://api.jhzyfw.com/api/check_signup_status.php`,
      method: 'GET',
      header: {
        'Authorization': `Bearer ${this.data.token}`
      },
      data: { activity_id: activityId },
      success: (res) => {
        console.log('报名状态响应:', res.data);
        if (res.data && res.data.success) {
          const status = res.data.status || 0;
          const hasJoined = status > 0;
          
          this.setData({
            hasJoined,
            signupStatus: status
          });
          
          this.updateButtonByStatus();
        }
      },
      fail: (err) => {
        console.error('检查报名状态失败:', err);
      }
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
    const { signupStatus, isCheckinActive } = this.data;
    
    if (isCheckinActive) {
      this.goToTimerPage();
    } else if (signupStatus === 2) {
      this.goToCheckinPage();
    } else if (signupStatus === 1) {
      wx.showToast({
        title: '您的报名正在审核中',
        icon: 'none'
      });
    } else if (signupStatus === 3) {
      wx.showToast({
        title: '您已参与此活动',
        icon: 'none'
      });
    } else {
      this.handleJoinClick();
    }
  },

  // 跳转到签到页面
  goToCheckinPage() {
    wx.navigateTo({
      url: `/pages/activities/checkout-confirm/sign-confirm?activity_id=${this.data.activityId}&page_type=signin`
    });
  },

  // 跳转到计时页面
  goToTimerPage() {
    wx.navigateTo({
      url: `/pages/activities/timer/timer?activity_id=${this.data.activityId}&signin_id=${this.data.activeCheckinId || ''}`
    });
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

  // 处理报名 - 发送通知给管理员
  processJoin() {
    const activityId = this.data.activityId;

    wx.showLoading({
      title: '报名中...',
      mask: true
    });

    wx.request({
      url: 'https://api.jhzyfw.com/api/activity_signup_simple.php',
      method: 'POST',
      header: {
        'Authorization': `Bearer ${this.data.token}`,
        'Content-Type': 'application/json'
      },
      data: {
        activity_id: activityId
      },
      success: (res) => {
        wx.hideLoading();

        if (res.data && res.data.code === 0) {
          this.setData({
            hasJoined: true,
            signupStatus: 1
          });
          this.updateButtonByStatus();

          // 报名成功后提示订阅消息
          subscribe.subscribeAfterSignup().catch(err => {
            console.log('用户未订阅或订阅失败', err);
          });

          // 发送订阅消息给管理员（有新报名待审核）
          wx.request({
            url: 'https://api.jhzyfw.com/api/get_admin_openid.php',
            method: 'GET',
            header: { 'Authorization': `Bearer ${this.data.token}` },
            success: (adminRes) => {
              if (adminRes.data.success && adminRes.data.openid && this.data.activity) {
                // 获取志愿者姓名
                const volunteerName = this.data.userInfo?.real_name || '志愿者';
                wx.request({
                  url: 'https://api.jhzyfw.com/api/independent_send.php',
                  method: 'POST',
                  data: {
                    openid: adminRes.data.openid,
                    type: 'signup',
                    data: {
                      thing4: { value: this.data.activity.title || '志愿活动' },
                      thing6: { value: this.data.activity.location || '活动地点' },
                      thing10: { value: `${volunteerName} 报名，待审核` },
                      thing11: { value: this.data.activity.location || '活动地点' },
                      thing18: { value: '嘉禾志愿' }
                    }
                  }
                });
              }
            }
          });

          wx.showToast({
            title: '报名成功，等待审核',
            icon: 'success',
            duration: 2000
          });

          setTimeout(() => {
            this.loadActivityDetail();
          }, 500);

        } else if (res.data && res.data.code === -400) {
          this.checkSignupStatus();
          wx.showToast({
            title: res.data.msg || '您已报名此活动',
            icon: 'none'
          });
        } else {
          wx.showToast({
            title: res.data?.msg || '报名失败',
            icon: 'none'
          });
        }
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('报名失败:', err);
        wx.showToast({
          title: '网络错误',
          icon: 'none'
        });
      }
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