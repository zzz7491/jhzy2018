// pages/activities/my/my.js
import jhzyRequest from '../../../utils/request';

Page({
  data: {
    loading: true,
    refreshing: false,
    hasMore: true,
    page: 1,
    pageSize: 10,
    activities: [],
    tabs: [
      { id: 'all', name: '全部', count: 0 },
      { id: 'ongoing', name: '进行中', count: 0 },
      { id: 'completed', name: '已完成', count: 0 },
      { id: 'signed', name: '已报名', count: 0 }
    ],
    activeTab: 'all',
    stats: {
      total: 0,
      ongoing: 0,
      completed: 0,
      signed: 0
    }
  },

  onLoad(options) {
    this.loadMyActivities();
  },

  onShow() {
    // 刷新数据
    if (this.data.activities.length > 0) {
      this.refreshData();
    }
  },

  onPullDownRefresh() {
    this.refreshData().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadMoreData();
    }
  },

  // 切换标签页
  switchTab(e) {
    const tabId = e.currentTarget.dataset.id;
    if (this.data.activeTab === tabId) return;
    
    this.setData({
      activeTab: tabId,
      activities: [],
      page: 1,
      hasMore: true,
      loading: true
    }, () => {
      this.loadMyActivities();
    });
  },

  // 加载我的活动数据
  async loadMyActivities() {
    if (!this.data.hasMore && this.data.page > 1) return;
    
    try {
      const params = {
        page: this.data.page,
        limit: this.data.pageSize
      };
      
      // 根据tab添加筛选条件
      if (this.data.activeTab === 'ongoing') {
        params.type = 'ongoing';
      } else if (this.data.activeTab === 'completed') {
        params.type = 'completed';
      } else if (this.data.activeTab === 'signed') {
        params.type = 'signed';
      }
      
      const res = await jhzyRequest.get('user_activities.php', params);
      
      if (res.code === 0) {
        const newActivities = res.data.list || [];
        const stats = res.data.stats || {};
        
        // 处理时间段信息
        const processedActivities = await this.processActivitiesWithTimeSlots(newActivities);
        
        // 更新统计
        this.setData({
          activities: this.data.page === 1 ? processedActivities : [...this.data.activities, ...processedActivities],
          hasMore: newActivities.length >= this.data.pageSize,
          loading: false,
          refreshing: false,
          stats: stats,
          'tabs[0].count': stats.total || 0,
          'tabs[1].count': stats.ongoing || 0,
          'tabs[2].count': stats.completed || 0,
          'tabs[3].count': stats.signed || 0
        });
      } else {
        this.setData({ loading: false, refreshing: false });
        wx.showToast({
          title: res.msg || '加载失败',
          icon: 'none'
        });
      }
      
    } catch (error) {
      console.error('加载我的活动失败:', error);
      this.setData({ loading: false, refreshing: false });
      wx.showToast({
        title: '网络错误',
        icon: 'none'
      });
    }
  },

  // 处理活动数据，获取时间段信息
  async processActivitiesWithTimeSlots(activities) {
    if (!activities || activities.length === 0) return activities;
    
    const processedActivities = [];
    
    for (const activity of activities) {
      try {
        // 如果活动已报名且有活动ID，获取时间段信息
        if (activity.sign_status === 'signed' && activity.id) {
          const timeSlotsRes = await jhzyRequest.get('activity_time_slots.php', {
            activity_id: activity.id
          });
          
          if (timeSlotsRes.code === 0 && timeSlotsRes.data) {
            // 查找用户报名的时间段
            const userSignups = timeSlotsRes.data.user_signups || [];
            const allSlots = timeSlotsRes.data.all_slots || [];
            
            if (userSignups.length > 0 && allSlots.length > 0) {
              const userTimeSlots = [];
              
              // 查找用户报名的具体时间段
              for (const signup of userSignups) {
                const matchedSlot = allSlots.find(slot => 
                  slot.id === signup.time_slot_id ||
                  (slot.slot_date === signup.slot_date && 
                   slot.start_time === signup.start_time)
                );
                
                if (matchedSlot) {
                  userTimeSlots.push({
                    ...matchedSlot,
                    signup_id: signup.signup_id,
                    checkin_status: signup.checkin_status,
                    checkout_time: signup.checkout_time
                  });
                }
              }
              
              activity.time_slots = userTimeSlots;
              
              // 更新活动显示时间
              if (userTimeSlots.length > 0) {
                const firstSlot = userTimeSlots[0];
                activity.activity_time = `${firstSlot.slot_date} ${firstSlot.start_time} - ${firstSlot.end_time}`;
                
                if (userTimeSlots.length > 1) {
                  activity.time_slots_count = userTimeSlots.length;
                }
              }
            }
          }
        }
        
        processedActivities.push(activity);
        
      } catch (error) {
        console.error('处理活动时间段信息失败:', error, activity);
        processedActivities.push(activity); // 即使失败也保留原活动信息
      }
    }
    
    return processedActivities;
  },

  // 刷新数据
  async refreshData() {
    this.setData({ refreshing: true, page: 1, hasMore: true });
    await this.loadMyActivities();
  },

  // 加载更多数据
  async loadMoreData() {
    if (this.data.loading || !this.data.hasMore) return;
    
    this.setData({ 
      page: this.data.page + 1,
      loading: true 
    });
    
    await this.loadMyActivities();
  },

  // 查看活动详情
  viewActivityDetail(e) {
    const activityId = e.currentTarget.dataset.id;
    const hasTimeSlots = e.currentTarget.dataset.timeslots || false;
    
    if (!activityId) return;
    
    if (hasTimeSlots) {
      // 如果有时段，跳转到带时间段的详情页
      wx.navigateTo({
        url: `/pages/activities/activity-detail/activity-detail?id=${activityId}`
      });
    } else {
      // 传统详情页
      wx.navigateTo({
        url: `/pages/detail/detail?id=${activityId}`
      });
    }
  },

  // 签到活动
  async signInActivity(e) {
    const activityId = e.currentTarget.dataset.id;
    const slotId = e.currentTarget.dataset.slotid;
    
    if (!activityId) return;
    
    try {
      wx.showLoading({ title: '签到中...', mask: true });
      
      let data = { activity_id: activityId };
      if (slotId) {
        data.time_slot_id = slotId;
      }
      
      const res = await jhzyRequest.post('activity_signin_simple.php', data);
      
      wx.hideLoading();
      
      if (res.code === 0) {
        wx.showToast({
          title: '签到成功',
          icon: 'success',
          duration: 1500
        });
        
        // 刷新当前活动状态
        this.refreshData();
      } else {
        wx.showToast({
          title: res.msg || '签到失败',
          icon: 'none'
        });
      }
      
    } catch (error) {
      wx.hideLoading();
      wx.showToast({
        title: '网络错误',
        icon: 'none'
      });
    }
  },

  // 取消报名
  async cancelSignUp(e) {
    const activityId = e.currentTarget.dataset.id;
    const slotId = e.currentTarget.dataset.slotid;
    
    if (!activityId) return;
    
    wx.showModal({
      title: '确认取消',
      content: slotId ? '确定要取消该时间段的报名吗？' : '确定要取消报名吗？',
      confirmText: '确定取消',
      cancelText: '再想想',
      success: async (res) => {
        if (res.confirm) {
          try {
            wx.showLoading({ title: '处理中...', mask: true });
            
            let data = { activity_id: activityId };
            if (slotId) {
              data.time_slot_id = slotId;
            }
            
            const result = await jhzyRequest.post('activity_cancel.php', data);
            
            wx.hideLoading();
            
            if (result.code === 0) {
              wx.showToast({
                title: '取消成功',
                icon: 'success',
                duration: 1500
              });
              
              // 刷新数据
              this.refreshData();
            } else {
              wx.showToast({
                title: result.msg || '取消失败',
                icon: 'none'
              });
            }
            
          } catch (error) {
            wx.hideLoading();
            wx.showToast({
              title: '网络错误',
              icon: 'none'
            });
          }
        }
      }
    });
  },

  // 评价活动
  rateActivity(e) {
    const activityId = e.currentTarget.dataset.id;
    if (!activityId) return;
    
    wx.showModal({
      title: '活动评价',
      content: '评价功能即将开放',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  // 分享活动
  shareActivity(e) {
    const activityId = e.currentTarget.dataset.id;
    const activity = this.data.activities.find(item => item.id === activityId);
    
    if (!activity) return;
    
    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage', 'shareTimeline']
    });
  },

  // 手动刷新
  manualRefresh() {
    this.refreshData();
  },

  // 跳转到活动列表
  goToActivityList() {
    wx.switchTab({
      url: '/pages/activities/activities'
    });
  },

  // 查看时间段详情
  viewTimeSlotDetail(e) {
    const activityId = e.currentTarget.dataset.activityid;
    const slotId = e.currentTarget.dataset.slotid;
    
    if (!activityId || !slotId) return;
    
    wx.navigateTo({
      url: `/pages/activities/time-slot-detail/time-slot-detail?activity_id=${activityId}&slot_id=${slotId}`
    });
  }
});