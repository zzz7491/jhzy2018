// pages/admin/review-aggregate/index.ts
import jhzyRequest from '../../../utils/request';

Page({
  data: {
    loading: false,
    refreshing: false,
    hasMore: true,
    page: 1,
    pageSize: 10,
    activities: [] as any[],
    selectedIds: [] as number[],
    selectAll: false,
    
    stats: {
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0
    },
    
    filters: {
      dateRange: '',
      activityType: '',
      volunteerName: ''
    },
    
    batchProcessing: false,
    operationType: '',
    operationNotes: ''
  },

  onLoad() {
    if (!this.checkAdminLogin()) {
      wx.showToast({ title: '请先登录', icon: 'error' });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/login-unified/index?role=admin' });
      }, 500);
      return;
    }
    this.loadPendingActivities();
    this.loadStats();
  },

  onShow() {
    if (this.data.activities.length > 0) {
      this.refreshData();
    }
    this.loadStats();
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

  checkAdminLogin(): boolean {
    const adminInfo = wx.getStorageSync('adminInfo');
    return !!(adminInfo && adminInfo.id);
  },

  async loadStats() {
    try {
      const res = await jhzyRequest.get('admin_get_stats.php');
      if (res.success === true) {
        this.setData({
          pending_reviews: res.data.pending_reviews || 0,
          approved_count: res.data.approved_count || 0,
          rejected_count: res.data.rejected_count || 0
        });
      }
    } catch (error) {
      console.error('加载统计数据失败:', error);
    }
  },

  async loadPendingActivities() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    
    try {
      const res = await jhzyRequest.get('admin_get_pending_activities_fixed.php');
      if (res.success === true) {
        this.setData({
          activities: res.data || [],
          'stats.pending': (res.data || []).length,
          hasMore: false,
          loading: false
        });
      } else {
        wx.showToast({ title: res.msg || '加载失败', icon: 'none' });
        this.setData({ loading: false });
      }
    } catch (error) {
      console.error('加载待审核活动失败:', error);
      wx.showToast({ title: '网络错误', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  async refreshData() {
    this.setData({
      page: 1,
      activities: [],
      hasMore: true,
      refreshing: true,
      selectedIds: [],
      selectAll: false
    });
    await this.loadPendingActivities();
    await this.loadStats();
    this.setData({ refreshing: false });
  },

  async loadMoreData() {},

  toggleSelect(e: any) {
    const id = e.currentTarget.dataset.id;
    let selectedIds = [...this.data.selectedIds];
    const index = selectedIds.indexOf(id);
    if (index > -1) {
      selectedIds.splice(index, 1);
    } else {
      selectedIds.push(id);
    }
    this.setData({
      selectedIds,
      selectAll: selectedIds.length === this.data.activities.length
    });
  },

  toggleSelectAll() {
    const selectAll = !this.data.selectAll;
    let selectedIds: number[] = [];
    if (selectAll) {
      selectedIds = this.data.activities.map((item: any) => item.id);
    }
    this.setData({ selectAll, selectedIds });
  },

  viewActivityDetail(e: any) {
    const activityId = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/detail/detail?id=${activityId}` });
  },

  viewVolunteerInfo(e: any) {
    wx.showModal({
      title: '志愿者信息',
      content: '查看志愿者详细信息功能即将开放',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  async approveSingle(e: any) {
    const id = e.currentTarget.dataset.id;
    const activityTitle = e.currentTarget.dataset.title;
    
    wx.showModal({
      title: '确认通过',
      content: `确定要通过 "${activityTitle}" 的报名吗？`,
      confirmText: '通过',
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          await this.processApprove([id]);
        }
      }
    });
  },

  async rejectSingle(e: any) {
    const id = e.currentTarget.dataset.id;
    const activityTitle = e.currentTarget.dataset.title;
    
    wx.showModal({
      title: '确认拒绝',
      content: `确定要拒绝 "${activityTitle}" 的报名吗？`,
      confirmText: '拒绝',
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          await this.processReject([id]);
        }
      }
    });
  },

  batchApprove() {
    if (this.data.selectedIds.length === 0) {
      wx.showToast({ title: '请先选择要审核的记录', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '批量通过',
      content: `确定要通过选中的 ${this.data.selectedIds.length} 条报名吗？`,
      confirmText: '批量通过',
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          await this.processApprove(this.data.selectedIds);
        }
      }
    });
  },

  batchReject() {
    if (this.data.selectedIds.length === 0) {
      wx.showToast({ title: '请先选择要审核的记录', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '批量拒绝',
      content: `确定要拒绝选中的 ${this.data.selectedIds.length} 条报名吗？`,
      confirmText: '批量拒绝',
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          await this.processReject(this.data.selectedIds);
        }
      }
    });
  },

  // 发送订阅消息 - 直接使用报名详情中的openid
  sendAuditMessage(openid: string, activityTitle: string, location: string) {
    if (!openid) return;
    wx.request({
      url: 'https://api.jhzyfw.com/api/independent_send.php',
      method: 'POST',
      data: {
        openid: openid,
        type: 'signup',
        data: {
          thing4: { value: activityTitle || '志愿活动' },
          thing6: { value: location || '活动地点' },
          thing10: { value: '审核通过' },
          thing11: { value: location || '活动地点' },
          thing18: { value: '嘉禾志愿' }
        }
      }
    });
  },

  async processApprove(ids: number[]) {
    if (ids.length === 0) return;
    
    wx.showLoading({ title: '处理中...', mask: true });
    
    try {
      let successCount = 0;
      
      for (const id of ids) {
        try {
          // 获取报名详情（包含openid、活动标题、地点）
          const detailRes = await jhzyRequest.get(`get_signup_detail.php?id=${id}`);
          const openid = detailRes.data?.openid;
          const activityTitle = detailRes.data?.activity_title;
          const location = detailRes.data?.location;
          
          const res = await jhzyRequest.post('approve_activity_fixed.php', {
            volunteer_id: id,
            action: 'approve',
            notes: '管理员审核通过'
          });
          
          if (res.code === 0) {
            successCount++;
            // 发送订阅消息
            if (openid) {
              this.sendAuditMessage(openid, activityTitle, location);
            }
          }
        } catch (error) {
          console.error(`审核ID ${id} 失败:`, error);
        }
      }
      
      if (successCount > 0) {
        wx.showToast({ title: `成功通过 ${successCount} 条`, icon: 'success' });
        setTimeout(() => { this.refreshData(); }, 500);
      }
      
    } catch (error) {
      console.error('审核操作失败:', error);
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async processReject(ids: number[]) {
    if (ids.length === 0) return;
    
    wx.showLoading({ title: '处理中...', mask: true });
    
    try {
      let successCount = 0;
      
      for (const id of ids) {
        try {
          const res = await jhzyRequest.post('approve_activity_fixed.php', {
            volunteer_id: id,
            action: 'reject',
            notes: '管理员审核拒绝'
          });
          if (res.code === 0) {
            successCount++;
          }
        } catch (error) {
          console.error(`拒绝ID ${id} 失败:`, error);
        }
      }
      
      if (successCount > 0) {
        wx.showToast({ title: `成功拒绝 ${successCount} 条`, icon: 'success' });
        setTimeout(() => { this.refreshData(); }, 500);
      }
      
    } catch (error) {
      console.error('拒绝操作失败:', error);
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  onNotesInput(e: any) {
    this.setData({ operationNotes: e.detail.value });
  },

  exportData() {
    wx.showModal({
      title: '导出数据',
      content: '导出功能即将开放',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  backToAdminPanel() {
    wx.navigateBack();
  }
});