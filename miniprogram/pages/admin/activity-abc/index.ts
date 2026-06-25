Page({
  data: {
    loading: true,
    activityList: [],
    pagination: {
      current_page: 1,
      per_page: 10,
      total: 0,
      total_pages: 1
    },
    searchKeyword: '',
    filterStatus: '',
    statusOptions: [
      { label: '全部状态', value: 'all' },
      { label: '未开始', value: 'upcoming' },
      { label: '进行中', value: 'ongoing' },
      { label: '已结束', value: 'completed' },
      { label: '已取消', value: 'cancelled' }
    ],
    filterStatusIndex: 0,
    currentActivity: null,
    showEditModal: false,
    showDeleteConfirm: false,
    editForm: {
      id: 0,
      title: '',
      description: '',
      location: '',
      activity_date: '',
      start_time: '',
      end_time: '',
      max_participants: 10,
      points_reward: 10,
      status: 'upcoming',
      category: '普通活动',
      contact_info: '',
      cover_image: [],
      enable_certificate: false
    },
    editFormStatusIndex: 0
  },

  onLoad() {
    this.checkLogin();
  },

  onShow() {
    this.loadActivityList();
  },

  checkLogin() {
    const adminInfo = wx.getStorageSync('adminInfo');
    const token = wx.getStorageSync('access_token');
    
    if (!adminInfo || !adminInfo.id || !token) {
      wx.showToast({
        title: '请先登录',
        icon: 'error',
        duration: 2000
      });
      
      setTimeout(() => {
        wx.redirectTo({
          url: '/pages/login-unified/index?role=admin'
        });
      }, 800);
      return false;
    }
    
    if (!['super_admin', 'admin'].includes(adminInfo.role)) {
      wx.showToast({
        title: '无管理权限',
        icon: 'error',
        duration: 2000
      });
      
      setTimeout(() => {
        wx.navigateBack();
      }, 800);
      return false;
    }
    
    return true;
  },

  // 加载活动列表
  loadActivityList(page = 1) {
    if (!this.checkLogin()) return;
    
    this.setData({ loading: true });
    
    const token = wx.getStorageSync('access_token');
    let url = `https://api.jhzyfw.com/api/volunteer_activity_manage.php?page=${page}&limit=${this.data.pagination.per_page}`;
    
    if (this.data.searchKeyword) {
      url += `&search=${encodeURIComponent(this.data.searchKeyword)}`;
    }
    
    if (this.data.filterStatus && this.data.filterStatus !== 'all') {
      url += `&status=${this.data.filterStatus}`;
    }
    
    wx.request({
      url: url,
      method: 'GET',
      header: { 'Authorization': `Bearer ${token}` },
      success: (res) => {
        console.log('活动数据返回:', res.data);
        
        if (res.data && res.data.success === true) {
          const list = res.data.data?.list || [];
          const total = res.data.data?.total || 0;
          const total_pages = Math.ceil(total / this.data.pagination.per_page) || 1;
          
          this.setData({
            activityList: list,
            pagination: {
              current_page: page,
              per_page: this.data.pagination.per_page,
              total: total,
              total_pages: total_pages
            }
          });
        } else {
          wx.showToast({
            title: res.data?.message || '加载失败',
            icon: 'error'
          });
        }
      },
      fail: (err) => {
        console.error('加载失败:', err);
        wx.showToast({
          title: '网络错误',
          icon: 'error'
        });
      },
      complete: () => {
        this.setData({ loading: false });
      }
    });
  },

  handleSearch(e) {
    this.setData({
      searchKeyword: e.detail.value,
      pagination: { ...this.data.pagination, current_page: 1 }
    }, () => {
      this.loadActivityList(1);
    });
  },

  handleStatusChange(e) {
    const index = e.detail.value;
    const selected = this.data.statusOptions[index];
    this.setData({
      filterStatus: selected.value,
      filterStatusIndex: index,
      pagination: { ...this.data.pagination, current_page: 1 }
    }, () => {
      this.loadActivityList(1);
    });
  },

  loadPrevPage() {
    if (this.data.pagination.current_page > 1) {
      this.loadActivityList(this.data.pagination.current_page - 1);
    }
  },

  loadNextPage() {
    if (this.data.pagination.current_page < this.data.pagination.total_pages) {
      this.loadActivityList(this.data.pagination.current_page + 1);
    }
  },

  refreshData() {
    this.loadActivityList(this.data.pagination.current_page);
  },

  goToEdit(e) {
    const id = e.currentTarget.dataset.id;
    this.loadActivityDetail(id);
  },

  loadActivityDetail(id) {
    const token = wx.getStorageSync('access_token');
    
    wx.request({
      url: `https://api.jhzyfw.com/api/activity_manage.php?id=${id}`,
      method: 'GET',
      header: { 'Authorization': `Bearer ${token}` },
      success: (res) => {
        if (res.data.code === 0) {
          const activity = res.data.data;
          const statusIndex = this.data.statusOptions.findIndex(
            opt => opt.value === activity.status
          ) || 0;
          
          this.setData({
            currentActivity: activity,
            showEditModal: true,
            editFormStatusIndex: statusIndex,
            editForm: {
              id: activity.id,
              title: activity.title,
              description: activity.description,
              location: activity.location,
              activity_date: activity.activity_date,
              start_time: activity.start_time,
              end_time: activity.end_time,
              max_participants: activity.max_participants,
              points_reward: activity.points_reward,
              status: activity.status,
              category: activity.category || '普通活动',
              contact_info: activity.contact_info || '',
              cover_image: activity.cover_image || [],
              enable_certificate: activity.enable_certificate === 1 || activity.enable_certificate === true
            }
          });
        } else {
          wx.showToast({
            title: '加载活动详情失败',
            icon: 'error'
          });
        }
      },
      fail: () => {
        wx.showToast({
          title: '网络错误',
          icon: 'error'
        });
      }
    });
  },

  onCertificateChange(e) {
    this.setData({
      'editForm.enable_certificate': e.detail.value
    });
  },

  handleEditInput(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    this.setData({
      [`editForm.${field}`]: value
    });
  },

  handleStatusPickerChange(e) {
    const index = e.detail.value;
    const selected = this.data.statusOptions[index];
    this.setData({
      'editForm.status': selected.value,
      editFormStatusIndex: index
    });
  },

  getStatusLabel(status) {
    if (!status || status === 'all') return '全部状态';
    const option = this.data.statusOptions.find(s => s.value === status);
    return option ? option.label : '全部状态';
  },

  getStatusText(status) {
    const map = {
      'upcoming': '未开始',
      'ongoing': '进行中', 
      'completed': '已结束',
      'cancelled': '已取消'
    };
    return map[status] || status;
  },

  saveActivityEdit() {
    const token = wx.getStorageSync('access_token');
    const form = this.data.editForm;
    
    if (!form.title.trim()) {
      wx.showToast({ title: '请输入活动标题', icon: 'error' });
      return;
    }
    
    if (!form.activity_date) {
      wx.showToast({ title: '请选择活动日期', icon: 'error' });
      return;
    }
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/activity_manage.php',
      method: 'PUT',
      header: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      data: form,
      success: (res) => {
        if (res.data.code === 0) {
          wx.showToast({
            title: '修改成功',
            icon: 'success'
          });
          this.setData({ showEditModal: false });
          this.loadActivityList(this.data.pagination.current_page);
        } else {
          wx.showToast({
            title: res.data.message || '修改失败',
            icon: 'error'
          });
        }
      },
      fail: () => {
        wx.showToast({
          title: '网络错误',
          icon: 'error'
        });
      }
    });
  },

  closeEditModal() {
    this.setData({ showEditModal: false });
  },

  showDeleteDialog(e) {
    const id = e.currentTarget.dataset.id;
    const activity = this.data.activityList.find(item => item.id === id);
    
    if (activity) {
      this.setData({
        currentActivity: activity,
        showDeleteConfirm: true
      });
    }
  },

  confirmDelete() {
    const token = wx.getStorageSync('access_token');
    const id = this.data.currentActivity.id;
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/activity_manage.php',
      method: 'DELETE',
      header: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      data: { id: id },
      success: (res) => {
        if (res.data.code === 0) {
          wx.showToast({
            title: '删除成功',
            icon: 'success'
          });
          this.setData({ showDeleteConfirm: false });
          this.loadActivityList(this.data.pagination.current_page);
        } else {
          wx.showToast({
            title: res.data.message || '删除失败',
            icon: 'error'
          });
        }
      },
      fail: () => {
        wx.showToast({
          title: '网络错误',
          icon: 'error'
        });
      }
    });
  },

  cancelDelete() {
    this.setData({ showDeleteConfirm: false });
  },

  // 【修改】查看报名列表 - 替换原来的查看详情
  goToDetail(e) {
    const id = e.currentTarget.dataset.id;
    const title = e.currentTarget.dataset.title || '';
    
    wx.navigateTo({
      url: `/pages/admin/activity-signups/activity-signups?id=${id}&title=${encodeURIComponent(title)}`
    });
  },

  goToCreate() {
    wx.navigateTo({
      url: '/pages/admin/activity-create-flow/basic'
    });
  },

  // 复制活动的跳转逻辑
  copyActivity(e) {
    const id = e.currentTarget.dataset.id;
    wx.showToast({
      title: '正在准备模板...',
      icon: 'loading',
      duration: 800
    });
    
    setTimeout(() => {
      wx.navigateTo({
        url: `/pages/admin/activity-create-flow/basic?copy_id=${id}`
      });
    }, 500);
  },

  goBack() {
    wx.navigateBack();
  }
});