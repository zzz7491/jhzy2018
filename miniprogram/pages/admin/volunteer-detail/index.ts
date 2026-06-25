// pages/admin/volunteer-detail/index.ts
Page({
  data: {
    volunteer: null as any,
    loading: true,
    error: ''
  },

  onLoad(options: any) {
    const id = options.id;
    if (!id) {
      this.setData({ 
        loading: false, 
        error: '缺少志愿者ID' 
      });
      return;
    }
    
    this.setData({ 
      'volunteer.id': parseInt(id) 
    });
    
    this.loadData();
  },

  loadData() {
    this.setData({ loading: true, error: '' });
    
    const token = wx.getStorageSync('access_token');
    if (!token) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/login-unified/index?role=admin' });
      }, 1500);
      return;
    }
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/admin_get_volunteer_detail.php',
      method: 'GET',
      header: {
        'Authorization': `Bearer ${token}`
      },
      data: {
        id: this.data.volunteer.id
      },
      success: (res: any) => {
        if (res.statusCode === 200 && res.data && res.data.success) {
          // 处理返回的数据，添加显示字段
          let rawData = res.data.data;
          
          if (rawData) {
            // 性别转换：2->女, 1->男, 0->未知
            if (rawData.gender === '1') {
              rawData.gender_display = '男';
            } else if (rawData.gender === '2') {
              rawData.gender_display = '女';
            } else {
              rawData.gender_display = '未填写';
            }
            
            // 年龄：使用 age 字段
            rawData.age_display = rawData.age || '未计算';
            
            // 培训状态转换
            rawData.trained_display = rawData.is_trained == '1' ? '已培训' : '未培训';
            
            // 保险状态转换
            rawData.insurance_display = rawData.has_insurance == '1' ? '是' : '否';
          }
          
          this.setData({
            volunteer: rawData,
            loading: false
          });
        } else {
          this.setData({
            error: res.data?.message || '加载失败',
            loading: false
          });
        }
      },
      fail: () => {
        this.setData({
          error: '网络错误',
          loading: false
        });
      }
    });
  },

  // 获取状态文本
  getStatusText(status: number): string {
    if (status == 0) return '待审核';
    if (status == 1) return '已启用';
    if (status == 2) return '已禁用';
    if (status == 3) return '已拒绝';
    return '未知';
  },

  // 获取状态类名
  getStatusClass(status: number): string {
    if (status == 0) return 'pending';
    if (status == 1) return 'active';
    if (status == 2) return 'disabled';
    if (status == 3) return 'rejected';
    return '';
  },

  // 格式化时间
  formatTime(time: string): string {
    if (!time) return '';
    return time.substring(0, 10) + ' ' + time.substring(11, 16);
  },

  // 重置密码
  resetPassword() {
    const volunteer = this.data.volunteer;
    if (!volunteer) return;
    
    wx.showModal({
      title: '重置密码',
      content: `确定要重置志愿者 "${volunteer.real_name}" 的密码吗？`,
      success: (res) => {
        if (res.confirm) {
          this.doResetPassword();
        }
      }
    });
  },

  // 执行重置密码
  doResetPassword() {
    wx.showLoading({ title: "重置密码中...", mask: true });
    
    const token = wx.getStorageSync('access_token');
    wx.request({
      url: 'https://api.jhzyfw.com/api/admin_reset_password.php',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': token ? `Bearer ${token}` : ''
      },
      data: { volunteer_id: this.data.volunteer.id },
      success: (res: any) => {
        wx.hideLoading();
        
        if (res.statusCode === 200 && res.data && res.data.code === 0) {
          wx.showModal({
            title: "重置成功",
            content: `新密码: ${res.data.new_password}`,
            showCancel: false
          });
        } else {
          wx.showToast({ 
            title: res.data?.msg || "重置失败", 
            icon: "none" 
          });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: "网络错误", icon: "none" });
      }
    });
  },

  // 切换状态
  toggleStatus() {
    const volunteer = this.data.volunteer;
    if (!volunteer) return;
    
    const newStatus = volunteer.status == 1 ? 2 : 1;
    const action = newStatus == 1 ? '启用' : '禁用';
    
    wx.showModal({
      title: '确认操作',
      content: `确定要${action}"${volunteer.real_name}"的账号吗？`,
      success: (res) => {
        if (res.confirm) {
          this.updateStatus(newStatus);
        }
      }
    });
  },

  // 更新状态
  updateStatus(status: number) {
    wx.showLoading({ title: '处理中...', mask: true });
    
    const token = wx.getStorageSync('access_token');
    wx.request({
      url: 'https://api.jhzyfw.com/api/admin_update_volunteer.php',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      data: { 
        id: this.data.volunteer.id, 
        status 
      },
      success: (res: any) => {
        wx.hideLoading();
        
        if (res.statusCode === 200 && res.data && res.data.code === 0) {
          wx.showToast({ title: '操作成功', icon: 'success' });
          
          // 更新本地数据
          this.setData({
            'volunteer.status': status
          });
        } else {
          wx.showToast({ 
            title: res.data?.msg || '操作失败', 
            icon: 'none' 
          });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '网络错误', icon: 'none' });
      }
    });
  }
});