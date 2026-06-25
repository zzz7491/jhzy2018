const API_BASE = 'https://api.jhzyfw.com/api';

Page({
  data: {
    records: [] as any[],
    page: 1,
    limit: 20,
    total: 0,
    hasMore: false,
    loading: false,
    currentStatus: '',
    keyword: ''
  },

  onLoad() {
    this.loadRecords();
  },

  onSearchInput(e: any) {
    this.setData({ keyword: e.detail.value });
  },

  doSearch() {
    this.setData({ records: [], page: 1 });
    this.loadRecords();
  },

  filterStatus(e: any) {
    const status = e.currentTarget.dataset.status;
    this.setData({ currentStatus: status, records: [], page: 1 });
    this.loadRecords();
  },

  loadRecords() {
    if (this.data.loading) return;
    this.setData({ loading: true });

    const token = wx.getStorageSync('access_token');
    let url = `${API_BASE}/admin_exchange_records.php?page=${this.data.page}&limit=${this.data.limit}`;
    if (this.data.currentStatus) {
      url += `&status=${this.data.currentStatus}`;
    }
    if (this.data.keyword.trim()) {
      url += `&keyword=${encodeURIComponent(this.data.keyword.trim())}`;
    }

    wx.request({
      url,
      header: { 'Authorization': `Bearer ${token}` },
      success: (res: any) => {
        if (res.data.success) {
          const data = res.data.data;
          const newRecords = this.data.page === 1 ? data.records : [...this.data.records, ...data.records];
          this.setData({
            records: newRecords,
            total: data.pagination.total,
            hasMore: data.pagination.page < data.pagination.total_pages
          });
        }
      },
      complete: () => {
        this.setData({ loading: false });
      }
    });
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 });
    this.loadRecords();
  },

  completeRecord(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确认核销',
      content: '确定将此兑换记录标记为已核销吗？',
      success: (res) => {
        if (res.confirm) {
          this.updateRecord(id, 'complete');
        }
      }
    });
  },

  cancelRecord(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确认取消',
      content: '取消后将恢复商品库存并退还用户积分，确定取消吗？',
      success: (res) => {
        if (res.confirm) {
          this.updateRecord(id, 'cancel');
        }
      }
    });
  },

  updateRecord(recordId: number, action: string) {
    const token = wx.getStorageSync('access_token');
    wx.request({
      url: `${API_BASE}/admin_exchange_records.php`,
      method: 'PUT',
      header: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      data: {
        record_id: recordId,
        action: action
      },
      success: (res: any) => {
        if (res.data.success) {
          wx.showToast({ title: res.data.message, icon: 'success' });
          // 重新加载当前页
          this.setData({ records: [], page: 1 });
          this.loadRecords();
        } else {
          wx.showToast({ title: res.data.message, icon: 'none' });
        }
      }
    });
  }
});