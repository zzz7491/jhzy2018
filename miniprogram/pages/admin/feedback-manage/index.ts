// pages/admin/feedback-manage/index.ts
Page({
  data: {
    // 搜索关键词
    searchKeyword: '',
    
    // 状态筛选
    statusIndex: 0,
    statusOptions: [
      { value: -1, label: '全部状态' },
      { value: 0, label: '待处理' },
      { value: 1, label: '处理中' },
      { value: 2, label: '已回复' }
    ],
    
    // 类型筛选
    typeIndex: 0,
    typeOptions: [
      { value: '', label: '全部类型' },
      { value: 'bug', label: 'BUG反馈' },
      { value: 'suggestion', label: '功能建议' },
      { value: 'complaint', label: '投诉建议' },
      { value: 'other', label: '其他反馈' }
    ],
    
    // 紧急程度筛选
    priorityIndex: 0,
    priorityOptions: [
      { value: '', label: '全部等级' },
      { value: 'high', label: '紧急' },
      { value: 'medium', label: '普通' },
      { value: 'low', label: '低优先级' }
    ],
    
    // 列表数据
    feedbackList: [] as any[],
    currentFeedback: {} as any,
    showDetailModal: false,
    replyContent: '',
    
    // 分页
    page: 1,
    limit: 10,
    total: 0,
    hasMore: true,
    loading: false,
    
    // 统计数据
    stats: {
      total: 0,
      pending: 0,
      processing: 0,
      resolved: 0,
      today: 0
    }
  },

  onLoad() {
    // 检查管理员权限
    const adminInfo = wx.getStorageSync('adminInfo');
    if (!adminInfo) {
      wx.redirectTo({
        url: '/pages/login-unified/index?role=login-unified/index?role=admin'
      });
      return;
    }
    
    this.loadFeedbackData();
  },

  onShow() {
    if (this.data.feedbackList.length > 0) {
      this.refreshData();
    }
  },

  onPullDownRefresh() {
    this.refreshData();
    wx.stopPullDownRefresh();
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadMore();
    }
  },

  // 返回管理面板
  goBack() {
    wx.redirectTo({
      url: '/pages/adminPanel/adminPanel'
    });
  },

  // 搜索输入
  onSearchInput(e: any) {
    const value = e.detail.value;
    this.setData({ searchKeyword: value });
    
    // 防抖搜索
    clearTimeout((this as any).searchTimer);
    (this as any).searchTimer = setTimeout(() => {
      this.refreshData();
    }, 300);
  },

  onSearchConfirm() {
    this.refreshData();
  },

  clearSearch() {
    this.setData({ searchKeyword: '' });
    this.refreshData();
  },

  // 状态筛选
  onStatusChange(e: any) {
    const index = e.detail.value;
    this.setData({ statusIndex: index });
    this.refreshData();
  },

  // 类型筛选
  onTypeChange(e: any) {
    const index = e.detail.value;
    this.setData({ typeIndex: index });
    this.refreshData();
  },

  // 紧急程度筛选
  onPriorityChange(e: any) {
    const index = e.detail.value;
    this.setData({ priorityIndex: index });
    this.refreshData();
  },

  // 加载反馈数据
  async loadFeedbackData() {
    if (this.data.loading) return;
    
    this.setData({ loading: true });
    
    try {
      const token = wx.getStorageSync('access_token');
      if (!token) {
        wx.showToast({
          title: '请先登录',
          icon: 'none'
        });
        setTimeout(() => {
          wx.redirectTo({ url: '/pages/login-unified/index?role=login-unified/index?role=admin' });
        }, 1000);
        return;
      }

      const { page, limit, searchKeyword, statusIndex, typeIndex, priorityIndex } = this.data;
      const status = this.data.statusOptions[statusIndex].value;
      const type = this.data.typeOptions[typeIndex].value;
      const priority = this.data.priorityOptions[priorityIndex].value;
      
      // 构建请求参数
      const params: any = {
        page,
        pageSize: limit
      };
      
      if (searchKeyword) {
        params.search = searchKeyword;
      }
      
      if (status !== -1) {
        params.status = status;
      }
      
      if (type) {
        params.type = type;
      }
      
      if (priority) {
        params.priority = priority;
      }
      
      // 调用反馈列表API
      const result = await this.requestApi('/admin_get_feedbacks.php', params, 'GET');
      
      console.log('反馈API响应:', result);
      
      if (result.success === true || result.code === 0) {
        const data = result.data || result;
        const list = data.list || [];
        
        // 处理图片数据
        const processedList = list.map((item: any) => {
          // 确保images字段是数组
          let images = [];
          if (item.images) {
            try {
              // 如果images是字符串，尝试解析为JSON
              if (typeof item.images === 'string') {
                const parsed = JSON.parse(item.images);
                if (parsed && parsed.images && Array.isArray(parsed.images)) {
                  images = parsed.images;
                } else if (Array.isArray(parsed)) {
                  images = parsed;
                }
              } else if (Array.isArray(item.images)) {
                images = item.images;
              }
            } catch (e) {
              console.error('解析图片数据失败:', e);
            }
          }
          
          return {
            ...item,
            images: images
          };
        });
        
        // 更新统计数据
        this.updateStats(processedList);
        
        // 更新列表数据
        if (page === 1) {
          this.setData({
            feedbackList: processedList,
            total: parseInt(data.total) || 0,
            hasMore: processedList.length >= limit
          });
        } else {
          this.setData({
            feedbackList: [...this.data.feedbackList, ...processedList],
            hasMore: processedList.length >= limit
          });
        }
      } else {
        wx.showToast({
          title: result.msg || '加载失败',
          icon: 'none'
        });
      }
    } catch (error) {
      console.error('加载反馈数据失败:', error);
      wx.showToast({
        title: '网络错误',
        icon: 'none'
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 更新统计数据
  updateStats(list: any[]) {
    const today = new Date().toISOString().split('T')[0];
    const stats = {
      total: list.length,
      pending: list.filter(item => item.status === 0).length,
      processing: list.filter(item => item.status === 1).length,
      resolved: list.filter(item => item.status === 2).length,
      today: list.filter(item => {
        const feedbackDate = item.created_at ? item.created_at.split(' ')[0] : '';
        return feedbackDate === today;
      }).length
    };
    
    this.setData({ stats });
  },

  // 刷新数据
  refreshData() {
    this.setData({
      page: 1,
      hasMore: true,
      feedbackList: []
    });
    this.loadFeedbackData();
  },

  // 加载更多
  loadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    
    this.setData({
      page: this.data.page + 1
    });
    this.loadFeedbackData();
  },

  // 获取状态文本
  getStatusText(status: number): string {
    const statusMap: Record<number, string> = {
      0: '待处理',
      1: '处理中',
      2: '已回复'
    };
    return statusMap[status] || '未知状态';
  },

  // 获取状态类名
  getStatusClass(status: number): string {
    const statusClassMap: Record<number, string> = {
      0: 'status-pending',
      1: 'status-processing',
      2: 'status-resolved'
    };
    return statusClassMap[status] || '';
  },

  // 获取类型文本
  getTypeText(type: string): string {
    const typeMap: Record<string, string> = {
      'bug': 'BUG反馈',
      'suggestion': '功能建议',
      'complaint': '投诉建议',
      'other': '其他反馈'
    };
    return typeMap[type] || '未知类型';
  },

  // 获取紧急程度文本
  getPriorityText(priority: string): string {
    const priorityMap: Record<string, string> = {
      'high': '紧急',
      'medium': '普通',
      'low': '低优先级'
    };
    return priorityMap[priority] || '未知';
  },

  // 获取紧急程度类名
  getPriorityClass(priority: string): string {
    return `priority-${priority}`;
  },

  // 查看反馈详情
  viewFeedbackDetail(e: any) {
    const id = e.currentTarget.dataset.id;
    const feedback = this.data.feedbackList.find((item: any) => item.id == id);
    
    if (feedback) {
      this.setData({
        currentFeedback: feedback,
        replyContent: '',
        showDetailModal: true
      });
    }
  },

  // 隐藏详情模态框
  hideDetailModal() {
    this.setData({ 
      showDetailModal: false,
      replyContent: ''
    });
  },

  // 防止模态框滑动穿透
  preventTouchMove() {
    return;
  },

  // 防止事件冒泡
  stopPropagation() {
    return;
  },

  // 预览图片
  previewImage(e: any) {
    const index = e.currentTarget.dataset.index;
    const images = e.currentTarget.dataset.images;
    
    console.log('预览图片:', index, images);
    
    if (images && images.length > 0) {
      wx.previewImage({
        current: images[index],
        urls: images
      });
    }
  },

  // 回复内容输入
  onReplyInput(e: any) {
    const value = e.detail.value;
    this.setData({ replyContent: value });
  },

  // 更新反馈状态
  updateFeedbackStatus(e: any) {
    const status = parseInt(e.currentTarget.dataset.status);
    const statusText = this.getStatusText(status);
    
    wx.showModal({
      title: '更新状态',
      content: `确定要将此反馈标记为【${statusText}】吗？`,
      confirmText: statusText,
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          await this.doUpdateFeedbackStatus(status);
        }
      }
    });
  },

  // 执行更新反馈状态
  async doUpdateFeedbackStatus(status: number) {
    wx.showLoading({ title: '处理中...' });
    
    try {
      const token = wx.getStorageSync('access_token');
      const result = await this.requestApi('/admin_update_feedback.php', {
        id: this.data.currentFeedback.id,
        status: status
      }, 'POST');
      
      wx.hideLoading();
      
      if (result.code === 0) {
        wx.showToast({
          title: '状态更新成功',
          icon: 'success'
        });
        
        // 更新当前反馈状态
        const updatedFeedback = { 
          ...this.data.currentFeedback, 
          status: status,
          updated_at: new Date().toISOString()
        };
        this.setData({
          currentFeedback: updatedFeedback
        });
        
        // 更新列表中的反馈状态
        const updatedList = this.data.feedbackList.map((item: any) => {
          if (item.id == this.data.currentFeedback.id) {
            return updatedFeedback;
          }
          return item;
        });
        
        this.setData({ feedbackList: updatedList });
        
        // 更新统计数据
        this.updateStats(updatedList);
      } else {
        wx.showToast({
          title: result.msg || '更新失败',
          icon: 'none'
        });
      }
    } catch (error) {
      wx.hideLoading();
      console.error('更新反馈状态失败:', error);
      wx.showToast({
        title: '网络错误',
        icon: 'none'
      });
    }
  },

  // 提交回复
  submitReply() {
    const content = this.data.replyContent.trim();
    if (!content) {
      wx.showToast({
        title: '请输入回复内容',
        icon: 'none'
      });
      return;
    }
    
    const actionText = this.data.currentFeedback.admin_reply ? '更新回复' : '提交回复';
    
    wx.showModal({
      title: actionText,
      content: `确定要${actionText}给用户吗？`,
      confirmText: actionText,
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          await this.doSubmitReply(content);
        }
      }
    });
  },

  // 执行提交回复
  async doSubmitReply(content: string) {
    wx.showLoading({ title: '发送中...' });
    
    try {
      const token = wx.getStorageSync('access_token');
      const adminInfo = wx.getStorageSync('adminInfo');
      const result = await this.requestApi('/admin_reply_feedback.php', {
        feedback_id: this.data.currentFeedback.id,
        content: content,
        admin_id: adminInfo.id,
        admin_name: adminInfo.real_name || adminInfo.username
      }, 'POST');
      
      wx.hideLoading();
      
      if (result.code === 0) {
        wx.showToast({
          title: '回复发送成功',
          icon: 'success'
        });
        
        // 更新当前反馈
        const updatedFeedback = { 
          ...this.data.currentFeedback,
          admin_reply: content,
          reply_time: new Date().toISOString(),
          reply_admin: adminInfo.real_name || adminInfo.username,
          status: 2 // 自动标记为已回复
        };
        
        this.setData({
          currentFeedback: updatedFeedback,
          replyContent: ''
        });
        
        // 更新列表中的反馈
        const updatedList = this.data.feedbackList.map((item: any) => {
          if (item.id == this.data.currentFeedback.id) {
            return updatedFeedback;
          }
          return item;
        });
        
        this.setData({ feedbackList: updatedList });
        
        // 更新统计数据
        this.updateStats(updatedList);
        
        // 清空输入框
        this.setData({ replyContent: '' });
      } else {
        wx.showToast({
          title: result.msg || '发送失败',
          icon: 'none'
        });
      }
    } catch (error) {
      wx.hideLoading();
      console.error('发送回复失败:', error);
      wx.showToast({
        title: '网络错误',
        icon: 'none'
      });
    }
  },

  // 导出反馈数据
  exportFeedback() {
    if (this.data.feedbackList.length === 0) {
      wx.showToast({
        title: '没有数据可以导出',
        icon: 'none'
      });
      return;
    }
    
    wx.showModal({
      title: '导出数据',
      content: '即将导出反馈数据，请确认',
      confirmText: '确认导出',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          this.generateExportData();
        }
      }
    });
  },

  // 生成导出数据
  generateExportData() {
    const data = this.data.feedbackList.map((item: any, index: number) => {
      return {
        '序号': index + 1,
        '反馈ID': item.id,
        '反馈用户': item.volunteer_name || '匿名用户',
        '联系方式': item.contact || '未提供',
        '反馈类型': this.getTypeText(item.type),
        '反馈内容': item.content,
        '反馈状态': this.getStatusText(item.status),
        '创建时间': this.formatFullDate(item.created_at),
        '回复内容': item.admin_reply || '未回复',
        '回复管理员': item.reply_admin || '无',
        '回复时间': item.reply_time ? this.formatFullDate(item.reply_time) : '未回复'
      };
    });
    
    // 生成CSV内容
    const headers = Object.keys(data[0]).join(',');
    const rows = data.map(row => Object.values(row).map(value => `"${value}"`).join(','));
    const csvContent = [headers, ...rows].join('\n');
    
    // 保存文件
    const filePath = `${wx.env.USER_DATA_PATH}/feedback_export_${new Date().getTime()}.csv`;
    const fs = wx.getFileSystemManager();
    
    wx.showLoading({ title: '导出中...' });
    
    fs.writeFile({
      filePath,
      data: csvContent,
      encoding: 'utf8',
      success: () => {
        wx.hideLoading();
        wx.showModal({
          title: '导出成功',
          content: `反馈数据已导出到文件`,
          showCancel: false,
          confirmText: '知道了',
          success: () => {
            // 可以分享文件
            wx.openDocument({
              filePath,
              fileType: 'csv'
            });
          }
        });
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('导出文件失败:', err);
        wx.showToast({
          title: '导出失败',
          icon: 'none'
        });
      }
    });
  },

  // 标记为紧急
  markAsUrgent(e: any) {
    const id = e.currentTarget.dataset.id;
    
    wx.showModal({
      title: '标记紧急',
      content: '确定要将此反馈标记为紧急吗？',
      confirmText: '标记',
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          await this.doUpdateFeedbackPriority(id, 'high');
        }
      }
    });
  },

  // 更新反馈紧急程度
  async doUpdateFeedbackPriority(id: number, priority: string) {
    wx.showLoading({ title: '处理中...' });
    
    try {
      const token = wx.getStorageSync('access_token');
      const result = await this.requestApi('/admin_update_feedback.php', {
        id: id,
        priority: priority
      }, 'POST');
      
      wx.hideLoading();
      
      if (result.code === 0) {
        wx.showToast({
          title: '标记成功',
          icon: 'success'
        });
        
        // 刷新数据
        this.refreshData();
      } else {
        wx.showToast({
          title: result.msg || '操作失败',
          icon: 'none'
        });
      }
    } catch (error) {
      wx.hideLoading();
      console.error('更新反馈紧急程度失败:', error);
      wx.showToast({
        title: '网络错误',
        icon: 'none'
      });
    }
  },

  // 统一的API请求方法
  requestApi(url: string, data: any = {}, method: 'GET' | 'POST' = 'GET'): Promise<any> {
    return new Promise((resolve, reject) => {
      const token = wx.getStorageSync('access_token');
      
      const header: any = {
        'Content-Type': 'application/x-www-form-urlencoded'
      };
      
      if (token) {
        header['Authorization'] = `Bearer ${token}`;
      }
      
      wx.request({
        url: `https://api.jhzyfw.com/api${url}`,
        method,
        data,
        header,
        success: (res: any) => {
          console.log(`API ${url} 响应:`, res.data);
          resolve(res.data);
        },
        fail: (err) => {
          console.error(`API ${url} 请求失败:`, err);
          reject(err);
        }
      });
    });
  },

  // 格式化日期
  formatDate(dateString: string): string {
    if (!dateString) return '';
    
    const date = new Date(dateString);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    
    return `${month}-${day} ${hours}:${minutes}`;
  },

  // 格式化完整日期
  formatFullDate(dateString: string): string {
    if (!dateString) return '';
    
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  },

  // 格式化相对时间
  formatRelativeTime(dateString: string): string {
    if (!dateString) return '';
    
    const now = new Date();
    const date = new Date(dateString);
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) {
      return '刚刚';
    } else if (diffMins < 60) {
      return `${diffMins}分钟前`;
    } else if (diffHours < 24) {
      return `${diffHours}小时前`;
    } else if (diffDays < 30) {
      return `${diffDays}天前`;
    } else {
      return this.formatDate(dateString);
    }
  }
});