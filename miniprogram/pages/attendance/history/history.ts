// pages/attendance/history/history.js
import checkinService from '../../../services/checkinService';

Page({
  data: {
    records: [],
    loading: true,
    page: 1,
    limit: 20,
    hasMore: true,
    total: 0,
    stats: {
      total_duration: 0,
      total_points: 0,
      total_count: 0
    }
  },

  onLoad() {
    this.loadHistory();
  },

  onShow() {
    // 每次显示页面时刷新
    this.setData({ page: 1, records: [], hasMore: true }, () => {
      this.loadHistory();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.setData({ page: this.data.page + 1 }, () => {
        this.loadHistory();
      });
    }
  },

  onPullDownRefresh() {
    this.setData({ page: 1, records: [], hasMore: true }, () => {
      this.loadHistory().finally(() => {
        wx.stopPullDownRefresh();
      });
    });
  },

  async loadHistory() {
    if (this.data.loading) return;
    
    this.setData({ loading: true });
    
    try {
      const res = await checkinService.getAttendanceHistory(this.data.page, this.data.limit);
      
      if (res.success) {
        const newRecords = res.data.list || [];
        const total = res.data.total || 0;
        
        this.setData({
          records: this.data.page === 1 ? newRecords : [...this.data.records, ...newRecords],
          total: total,
          hasMore: this.data.records.length + newRecords.length < total,
          loading: false
        });
        
        // 计算统计
        this.calculateStats();
      } else {
        this.setData({ loading: false });
        wx.showToast({ title: '加载失败', icon: 'none' });
      }
    } catch (error) {
      console.error('加载历史记录失败:', error);
      this.setData({ loading: false });
      wx.showToast({ title: '网络错误', icon: 'none' });
    }
  },

  calculateStats() {
    const records = this.data.records;
    let totalDuration = 0;
    let totalPoints = 0;
    
    records.forEach(item => {
      if (item.status === 2) { // 只统计正常完成的
        totalDuration += item.duration_minutes || 0;
        totalPoints += item.points || 0;
      }
    });
    
    this.setData({
      stats: {
        total_duration: (totalDuration / 60).toFixed(2),
        total_points: totalPoints.toFixed(2),
        total_count: records.length
      }
    });
  },

  getStatusText(status) {
    const map = {
      1: '进行中',
      2: '正常完成',
      3: '强制签退'
    };
    return map[status] || '未知';
  },

  getStatusClass(status) {
    const map = {
      1: 'status-active',
      2: 'status-completed',
      3: 'status-forced'
    };
    return map[status] || '';
  },

  formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr.replace(' ', 'T'));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  },

  formatDuration(minutes) {
    if (!minutes) return '0分钟';
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0) {
      return `${hours}小时${mins > 0 ? mins + '分钟' : ''}`;
    }
    return `${minutes}分钟`;
  },

  viewActivityDetail(e) {
    const activityId = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${activityId}`
    });
  },

  goBack() {
    wx.navigateBack();
  }
});