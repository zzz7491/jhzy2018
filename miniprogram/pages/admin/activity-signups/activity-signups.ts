// pages/admin/activity-signups/activity-signups.js
const app = getApp();

Page({
  data: {
    fixedActivityId: null,
    fixedActivityTitle: '',
    activity: null,
    signups: [],
    loading: false,
    loadingSignups: false
  },

  onLoad(options) {
    if (options && options.id) {
      // 直接从参数获取活动信息，不再调用详情接口
      const activityTitle = decodeURIComponent(options.title || '活动');
      const activityDate = decodeURIComponent(options.date || '');
      const activityLocation = decodeURIComponent(options.location || '');
      const activityMaxParticipants = options.max_participants || 0;
      const activityPointsReward = options.points_reward || 0;
      
      this.setData({ 
        fixedActivityId: options.id,
        fixedActivityTitle: activityTitle,
        activity: {
          id: options.id,
          title: activityTitle,
          activity_date: activityDate,
          location: activityLocation,
          max_participants: parseInt(activityMaxParticipants),
          points_reward: parseInt(activityPointsReward)
        }
      });
      
      wx.setNavigationBarTitle({ 
        title: `${activityTitle} - 报名列表` 
      });
      
      // 直接加载报名列表
      this.loadSignups(options.id);
    } else {
      this.checkAdminAndLoad();
    }
  },

  checkAdminAndLoad() {
    const userInfo = wx.getStorageSync('userInfo');
    const isAdmin = userInfo && (userInfo.role === 'admin' || userInfo.is_admin === true);
    
    if (!isAdmin) {
      wx.showModal({
        title: '权限不足',
        content: '此页面仅管理员可访问',
        showCancel: false,
        success: () => {
          wx.navigateBack();
        }
      });
      return;
    }
    
    if (!this.data.fixedActivityId) {
      this.loadActivities();
    }
  },

  // 加载报名列表
  loadSignups(activityId) {
    this.setData({ loadingSignups: true });
    
    const token = wx.getStorageSync('access_token');
    
    wx.request({
      url: `https://api.jhzyfw.com/api/admin_activity_signups.php?activity_id=${activityId}`,
      method: 'GET',
      header: {
        'ACCESSTOKEN': token
      },
      success: (res) => {
        console.log('报名列表响应:', res.data);
        
        let signups = [];
        if (res.data.code === 0 && res.data.data) {
          signups = res.data.data.signups || [];
          // 更新活动报名人数
          if (this.data.activity) {
            this.setData({
              'activity.current_participants': signups.length
            });
          }
        } else if (res.data.code === 401) {
          wx.showToast({ title: '请重新登录', icon: 'none' });
          setTimeout(() => {
            wx.redirectTo({ url: '/pages/login-unified/index?role=admin' });
          }, 1500);
        }
        
        this.setData({ 
          signups: signups,
          loadingSignups: false 
        });
      },
      fail: (err) => {
        console.error('加载报名列表失败:', err);
        wx.showToast({ title: '加载报名列表失败', icon: 'none' });
        this.setData({ loadingSignups: false });
      }
    });
  },

  // 加载所有活动（备用，用于非单活动模式）
  loadActivities() {
    this.setData({ loading: true });
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/activities.php',
      data: { status: 'active', limit: 50 },
      method: 'GET',
      success: (res) => {
        let activities = [];
        if (res.data.code === 0 && res.data.data && res.data.data.activities) {
          activities = res.data.data.activities;
        }
        this.setData({ activities, loading: false });
      },
      fail: () => {
        this.setData({ loading: false });
      }
    });
  },

  // 刷新
  refresh() {
    if (this.data.fixedActivityId) {
      this.loadSignups(this.data.fixedActivityId);
    }
  },

  // 获取状态文本
  getStatusText(status) {
    const map = {
      'pending': '待审核',
      'approved': '已通过',
      'checked': '已签到',
      'rejected': '已拒绝',
      'completed': '已完成',
      'cancelled': '已取消'
    };
    return map[status] || status || '未知';
  },

  // 获取状态样式
  getStatusClass(status) {
    const map = {
      'pending': 'pending',
      'approved': 'approved',
      'checked': 'checked',
      'rejected': 'rejected',
      'completed': 'completed',
      'cancelled': 'cancelled'
    };
    return map[status] || 'pending';
  },

  // 格式化日期时间
  formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    return `${date.getMonth()+1}/${date.getDate()} ${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`;
  },

  // 格式化完整时间
  formatFullDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    return `${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2,'0')}-${date.getDate().toString().padStart(2,'0')} ${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}:${date.getSeconds().toString().padStart(2,'0')}`;
  },

  // 拨打电话
  makePhoneCall(e) {
    const phone = e.currentTarget.dataset.phone;
    if (phone && phone !== '-') {
      wx.makePhoneCall({ phoneNumber: phone });
    } else {
      wx.showToast({ title: '无电话号码', icon: 'none' });
    }
  },

  // 复制信息
  copyText(e) {
    const text = e.currentTarget.dataset.text;
    if (text && text !== '-') {
      wx.setClipboardData({
        data: text,
        success: () => {
          wx.showToast({ title: '复制成功', icon: 'success' });
        }
      });
    }
  },

  // 导出报名列表
  exportSignups() {
    if (this.data.signups.length === 0) {
      wx.showToast({ title: '暂无报名数据', icon: 'none' });
      return;
    }
    
    let exportText = `活动：${this.data.activity?.title || this.data.fixedActivityTitle}\n`;
    exportText += `日期：${this.data.activity?.activity_date || ''}\n`;
    exportText += `地点：${this.data.activity?.location || ''}\n`;
    exportText += `报名人数：${this.data.signups.length}\n`;
    exportText += `\n姓名\t手机号\t志愿者编号\t报名时间\t签到时间\t状态\n`;
    exportText += `--------------------------------------------------\n`;
    
    this.data.signups.forEach(s => {
      exportText += `${s.real_name || '未知'}\t`;
      exportText += `${s.phone || '-'}\t`;
      exportText += `${s.volunteer_id || '-'}\t`;
      exportText += `${this.formatFullDate(s.signup_time)}\t`;
      exportText += `${s.checkin_time ? this.formatFullDate(s.checkin_time) : '-'}\t`;
      exportText += `${this.getStatusText(s.signup_status)}\n`;
    });
    
    wx.setClipboardData({
      data: exportText,
      success: () => {
        wx.showToast({ title: '已复制，可粘贴到Excel', icon: 'success', duration: 3000 });
      }
    });
  },

  // 返回上一页
  goBack() {
    wx.navigateBack();
  }
});