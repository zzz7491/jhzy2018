// pages/admin/quick-action-review/quick-action-review.ts
import { QuickActionRecord, ReviewStats, ApiResponse, ReviewActionParams } from '../../types/quick-action';

const API_BASE_URL = 'https://api.jhzyfw.com/api';

interface PageData {
  loading: boolean;
  refreshing: boolean;
  hasMore: boolean;
  page: number;
  pageSize: number;
  status: 'pending' | 'approved' | 'rejected' | 'all';
  stats: ReviewStats;
  records: QuickActionRecord[];
  selectedIds: number[];
  selectAll: boolean;
  previewImages: string[];
  currentImageIndex: number;
  showImagePreview: boolean;
  showConfirmDialog: boolean;
  confirmTitle: string;
  confirmContent: string;
  confirmAction: string;
  confirmData: any;
}

Page({
  data: {
    loading: false,
    refreshing: false,
    hasMore: true,
    page: 1,
    pageSize: 10,
    status: 'pending',
    stats: {
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0
    },
    records: [],
    selectedIds: [],
    selectAll: false,
    previewImages: [],
    currentImageIndex: 0,
    showImagePreview: false,
    showConfirmDialog: false,
    confirmTitle: '',
    confirmContent: '',
    confirmAction: '',
    confirmData: null
  } as PageData,

  onLoad() {
    console.log('审核页面加载');
    this.checkAdminLogin();
  },

  onShow() {
    console.log('审核页面显示');
    if (wx.getStorageSync('adminInfo')) {
      this.loadData();
    }
  },

  onPullDownRefresh() {
    console.log('下拉刷新');
    this.refreshData().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    console.log('滚动到底部');
    if (this.data.hasMore && !this.data.loading) {
      this.loadMoreData();
    }
  },

  // 检查管理员登录
  checkAdminLogin(): boolean {
    const adminInfo = wx.getStorageSync('adminInfo');
    const token = wx.getStorageSync('access_token');
    
    console.log('检查管理员登录:', { adminInfo: !!adminInfo, token: !!token });
    
    if (!adminInfo || !token) {
      wx.showToast({
        title: '请先登录',
        icon: 'error'
      });
      
      setTimeout(() => {
        wx.redirectTo({
          url: '/pages/login-unified/index?role=admin'
        });
      }, 1500);
      
      return false;
    }
    
    return true;
  },

  // 加载数据
  async loadData() {
    if (this.data.loading) return;
    
    this.setData({ loading: true });
    
    try {
      await this.loadRecords();
    } catch (error: any) {
      console.error('加载数据失败:', error);
      wx.showToast({
        title: error.message || '加载失败',
        icon: 'none'
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 加载记录
  loadRecords(): Promise<void> {
    return new Promise((resolve, reject) => {
      wx.request({
        url: `${API_BASE_URL}/admin_quick_simple.php`,
        method: 'GET',
        header: {
          'Authorization': `Bearer ${wx.getStorageSync('access_token')}`
        },
        data: {
          action: 'list',
          status: this.data.status === 'all' ? 'all' : this.data.status,
          page: this.data.page,
          limit: this.data.pageSize
        },
        success: (res: any) => {
          console.log('API响应:', res.data);
          
          const response = res.data;
          
          if (response.success === true) {
            const records = response.data?.records || [];
            const total = response.data?.total || 0;
            
            // 处理图片：确保是数组格式
            const processedRecords = records.map(record => {
              return {
                ...record,
                images: this.processImages(record.images),
                status: record.status || 0,
                points: record.points || 1,
                created_at: record.created_at || record.create_time || record.datetime || ''
              };
            });
            
            console.log('处理后的记录:', processedRecords);
            
            this.setData({
              records: processedRecords,
              hasMore: this.data.page * this.data.pageSize < total,
              stats: {
                total: total,
                pending: response.data?.pending || 0,
                approved: response.data?.approved || 0,
                rejected: response.data?.rejected || 0
              }
            }, () => {
              console.log('数据渲染完成，记录数:', processedRecords.length);
            });
            
            resolve();
          } else {
            if (res.statusCode === 401) {
              this.handleUnauthorized();
            }
            reject(new Error(response.message || '加载失败'));
          }
        },
        fail: (err: any) => {
          console.error('网络请求失败:', err);
          reject(new Error('网络错误'));
        }
      });
    });
  },

  // 处理图片数据
  processImages(images: any): string[] {
    if (!images) return [];
    
    if (Array.isArray(images)) {
      return images.filter(img => img && typeof img === 'string');
    }
    
    if (typeof images === 'string') {
      try {
        // 尝试解析JSON字符串
        const parsed = JSON.parse(images);
        if (Array.isArray(parsed)) {
          return parsed.filter(img => img);
        }
      } catch (e) {
        // 不是JSON，按逗号分割
        return images.split(',').filter(img => img.trim()).map(img => img.trim());
      }
    }
    
    return [];
  },

  // 处理未授权
  handleUnauthorized() {
    wx.showToast({
      title: '登录已过期',
      icon: 'error'
    });
    
    setTimeout(() => {
      wx.removeStorageSync('adminInfo');
      wx.removeStorageSync('access_token');
      wx.redirectTo({
        url: '/pages/login-unified/index?role=admin'
      });
    }, 1500);
  },

  // 刷新数据
  async refreshData() {
    this.setData({
      page: 1,
      hasMore: true,
      refreshing: true,
      selectedIds: [],
      selectAll: false
    });
    
    await this.loadData();
    this.setData({ refreshing: false });
  },

  // 加载更多数据
  async loadMoreData() {
    if (!this.data.hasMore || this.data.loading) return;
    
    const nextPage = this.data.page + 1;
    this.setData({ page: nextPage });
    
    await this.loadData();
  },

  // 切换筛选状态
  switchStatus(e: any) {
    const status = e.currentTarget.dataset.status as 'pending' | 'approved' | 'rejected' | 'all';
    if (this.data.status === status) return;
    
    this.setData({
      status,
      page: 1,
      hasMore: true,
      selectedIds: [],
      selectAll: false
    });
    
    this.loadData();
  },

  // 单个选择切换
  toggleSelect(e: any) {
    const id = Number(e.currentTarget.dataset.id);
    let selectedIds = [...this.data.selectedIds];
    
    const index = selectedIds.indexOf(id);
    if (index > -1) {
      selectedIds.splice(index, 1);
    } else {
      selectedIds.push(id);
    }
    
    this.setData({
      selectedIds,
      selectAll: selectedIds.length === this.data.records.length
    });
  },

  // 全选/取消全选
  toggleSelectAll() {
    const selectAll = !this.data.selectAll;
    let selectedIds: number[] = [];
    
    if (selectAll) {
      selectedIds = this.data.records.map(item => item.id);
    }
    
    this.setData({
      selectAll,
      selectedIds
    });
  },

  // 单个通过审核
  approveSingle(e: any) {
    const id = Number(e.currentTarget.dataset.id);
    const title = e.currentTarget.dataset.title || '';
    
    this.showConfirmDialog(
      '确认通过',
      `确定要通过该记录吗？${title ? '\n' + title : ''}`,
      'approve',
      { id }
    );
  },

  // 单个拒绝审核
  rejectSingle(e: any) {
    const id = Number(e.currentTarget.dataset.id);
    const title = e.currentTarget.dataset.title || '';
    
    wx.showModal({
      title: '拒绝理由',
      content: `${title ? title + '\n\n' : ''}请输入拒绝理由（选填）：`,
      editable: true,
      confirmText: '确认拒绝',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          this.processReject([id], res.content || '');
        }
      }
    });
  },

  // 批量通过
  batchApprove() {
    const selectedIds = this.data.selectedIds;
    const count = selectedIds.length;
    
    if (count === 0) {
      wx.showToast({
        title: '请先选择要审核的记录',
        icon: 'none'
      });
      return;
    }
    
    this.showConfirmDialog(
      '批量通过',
      `确定要通过选中的 ${count} 条记录吗？`,
      'batchApprove',
      { selectedIds }
    );
  },

  // 批量拒绝
  batchReject() {
    const selectedIds = this.data.selectedIds;
    const count = selectedIds.length;
    
    if (count === 0) {
      wx.showToast({
        title: '请先选择要审核的记录',
        icon: 'none'
      });
      return;
    }
    
    wx.showModal({
      title: '拒绝理由',
      content: `为选中的 ${count} 条记录输入拒绝理由（选填）：`,
      editable: true,
      confirmText: '确认拒绝',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          this.processReject(selectedIds, res.content || '');
        }
      }
    });
  },

  // 显示确认对话框
  showConfirmDialog(title: string, content: string, action: string, data: any) {
    this.setData({
      showConfirmDialog: true,
      confirmTitle: title,
      confirmContent: content,
      confirmAction: action,
      confirmData: data
    });
  },

  // 隐藏确认对话框
  hideConfirmDialog() {
    this.setData({
      showConfirmDialog: false,
      confirmTitle: '',
      confirmContent: '',
      confirmAction: '',
      confirmData: null
    });
  },

  // 确认对话框操作
  async onConfirmDialogConfirm() {
    const { confirmAction, confirmData } = this.data;
    
    this.hideConfirmDialog();
    
    if (confirmAction === 'approve') {
      await this.processApprove([confirmData.id]);
    } else if (confirmAction === 'batchApprove') {
      await this.processApprove(confirmData.selectedIds);
    }
  },

  // 处理通过审核
  async processApprove(ids: number[]) {
    if (ids.length === 0) return;
    
    wx.showLoading({ title: '处理中...', mask: true });
    
    try {
      let successCount = 0;
      
      for (const id of ids) {
        try {
          const res = await this.reviewAction({ id, action: 'approve' });
          if (res.success) {
            successCount++;
          }
        } catch (error) {
          console.error(`审核ID ${id} 失败:`, error);
        }
      }
      
      wx.hideLoading();
      
      if (successCount > 0) {
        wx.showToast({
          title: `成功通过 ${successCount} 条`,
          icon: 'success'
        });
        
        setTimeout(() => {
          this.refreshData();
        }, 1500);
      } else {
        wx.showToast({
          title: '操作失败',
          icon: 'none'
        });
      }
      
    } catch (error: any) {
      wx.hideLoading();
      console.error('审核操作失败:', error);
      wx.showToast({
        title: error.message || '操作失败',
        icon: 'none'
      });
    }
  },

  // 处理拒绝审核
  async processReject(ids: number[], remark: string = '') {
    if (ids.length === 0) return;
    
    wx.showLoading({ title: '处理中...', mask: true });
    
    try {
      let successCount = 0;
      
      for (const id of ids) {
        try {
          const res = await this.reviewAction({ id, action: 'reject', remark });
          if (res.success) {
            successCount++;
          }
        } catch (error) {
          console.error(`拒绝ID ${id} 失败:`, error);
        }
      }
      
      wx.hideLoading();
      
      if (successCount > 0) {
        wx.showToast({
          title: `成功拒绝 ${successCount} 条`,
          icon: 'success'
        });
        
        setTimeout(() => {
          this.refreshData();
        }, 1500);
      } else {
        wx.showToast({
          title: '操作失败',
          icon: 'none'
        });
      }
      
    } catch (error: any) {
      wx.hideLoading();
      console.error('拒绝操作失败:', error);
      wx.showToast({
        title: error.message || '操作失败',
        icon: 'none'
      });
    }
  },

  // 审核操作
  reviewAction(params: ReviewActionParams): Promise<{ success: boolean; id: number; message?: string; error?: string }> {
    return new Promise((resolve) => {
      wx.request({
        url: `${API_BASE_URL}/admin_quick_simple.php?action=review`,
        method: 'POST',
        header: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${wx.getStorageSync('access_token')}`
        },
        data: params,
        success: (res: any) => {
          const response = res.data;
          
          if (response.success === true) {
            resolve({ 
              success: true, 
              id: params.id, 
              message: response.message 
            });
          } else {
            resolve({ 
              success: false, 
              id: params.id, 
              error: response.message || '操作失败' 
            });
          }
        },
        fail: () => {
          resolve({ 
            success: false, 
            id: params.id, 
            error: '网络请求失败' 
          });
        }
      });
    });
  },

  // 查看图片
  viewImage(e: any) {
    const images = e.currentTarget.dataset.images;
    const imageList = this.processImages(images);
    
    if (imageList.length === 0) {
      wx.showToast({
        title: '无有效图片',
        icon: 'none'
      });
      return;
    }
    
    this.setData({
      previewImages: imageList,
      currentImageIndex: 0,
      showImagePreview: true
    });
  },

  // 关闭图片预览
  closeImagePreview() {
    this.setData({
      showImagePreview: false,
      previewImages: [],
      currentImageIndex: 0
    });
  },

  // 切换图片预览
  swiperImageChange(e: any) {
    this.setData({
      currentImageIndex: e.detail.current
    });
  },

  // 获取服务类型文本
  getServiceTypeText(type: string): string {
    const typeMap: Record<string, string> = {
      'bike_tidy': '整理共享单车',
      'trash_pick': '捡拾垃圾',
      'help_elder': '帮助老人',
      'traffic_guide': '交通引导',
      'community_clean': '社区清洁',
      'charity_share': '公益宣传',
      'community': '社区服务',
      'environment': '环境保护',
      'traffic': '交通引导',
      'other': '其他服务',
      'cleanup': '清理打扫'
    };
    return typeMap[type] || type;
  },

  // 获取状态文本
  getStatusText(status: number): string {
    if (status === 0) return '待审核';
    if (status === 1) return '已通过';
    if (status === 2) return '已拒绝';
    return '未知状态';
  },

  // 获取状态颜色
  getStatusColor(status: number): string {
    if (status === 0) return '#faad14';
    if (status === 1) return '#52c41a';
    if (status === 2) return '#ff4d4f';
    return '#999';
  },

  // 格式化日期
  formatDate(dateString: string): string {
    if (!dateString) return '';
    
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return dateString;
      
      const now = new Date();
      
      if (date.toDateString() === now.toDateString()) {
        return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
      }
      
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      if (date.toDateString() === yesterday.toDateString()) {
        return `昨天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
      }
      
      return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    } catch (error) {
      return dateString;
    }
  },

  // 获取选中数量
  getSelectedCount(): number {
    return this.data.selectedIds.length;
  },

  // 刷新页面
  onRefresh() {
    this.refreshData();
  },

  // 返回管理面板
  backToAdminPanel() {
    wx.navigateBack();
  }
});