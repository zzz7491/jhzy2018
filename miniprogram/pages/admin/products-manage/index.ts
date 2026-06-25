const API_BASE = 'https://api.jhzyfw.com/api';

Page({
  data: {
    products: [] as any[],
    page: 1,
    limit: 20,
    total: 0,
    hasMore: false,
    loading: false,
    currentStatus: ''
  },

  onLoad() {
    this.loadProducts();
  },

  onShow() {
    // 从详情页返回时刷新
    const needRefresh = wx.getStorageSync('productNeedRefresh');
    if (needRefresh) {
      wx.removeStorageSync('productNeedRefresh');
      this.setData({ products: [], page: 1 });
      this.loadProducts();
    }
  },

  filterStatus(e: any) {
    const status = e.currentTarget.dataset.status;
    this.setData({ currentStatus: status, products: [], page: 1 });
    this.loadProducts();
  },

  loadProducts() {
    if (this.data.loading) return;
    this.setData({ loading: true });

    const token = wx.getStorageSync('access_token');
    let url = `${API_BASE}/admin_products.php?page=${this.data.page}&limit=${this.data.limit}`;
    if (this.data.currentStatus) {
      url += `&status=${this.data.currentStatus}`;
    }

    wx.request({
      url,
      header: { 'Authorization': `Bearer ${token}` },
      success: (res: any) => {
        if (res.data.success) {
          const data = res.data.data;
          const newProducts = this.data.page === 1 ? data.products : [...this.data.products, ...data.products];
          this.setData({
            products: newProducts,
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
    this.loadProducts();
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/admin/products-manage/detail/index' });
  },

  goDetail(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/admin/products-manage/detail/index?id=${id}` });
  }
});