Page({
  data: {
    adminName: '',
    adminRole: '',
    form: {
      current_password: '',
      new_password: '',
      confirm_password: ''
    },
    showCurrentPassword: false,
    showNewPassword: false,
    showConfirmPassword: false,
    passwordStrength: 0,
    passwordChecks: {
      length: false,
      letter: false,
      number: false,
      match: false
    },
    isFormValid: false,
    submitLoading: false
  },

  onLoad() {
    this.loadAdminInfo();
  },

  onShow() {
    this.checkLogin();
  },

  checkLogin() {
    const token = wx.getStorageSync('access_token');
    const adminInfo = wx.getStorageSync('adminInfo');
    
    if (!token || !adminInfo) {
      wx.showToast({
        title: '请先登录',
        icon: 'error',
        duration: 2000
      });
      
      setTimeout(() => {
        wx.redirectTo({
          url: '/pages/login-unified/index?role=login-unified/index?role=admin'
        });
      }, 1500);
      return false;
    }
    return true;
  },

  loadAdminInfo() {
    const adminInfo = wx.getStorageSync('adminInfo');
    if (adminInfo) {
      this.setData({
        adminName: adminInfo.name || '管理员',
        adminRole: adminInfo.role || ''
      });
    }
  },

  handleInput(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    
    this.setData({
      [`form.${field}`]: value
    }, () => {
      this.checkPasswordRequirements();
      this.updatePasswordStrength();
      this.validateForm();
    });
  },

  toggleCurrentPassword() {
    this.setData({
      showCurrentPassword: !this.data.showCurrentPassword
    });
  },

  toggleNewPassword() {
    this.setData({
      showNewPassword: !this.data.showNewPassword
    });
  },

  toggleConfirmPassword() {
    this.setData({
      showConfirmPassword: !this.data.showConfirmPassword
    });
  },

  // 检查密码要求
  checkPasswordRequirements() {
    const { new_password, confirm_password } = this.data.form;
    
    const checks = {
      length: new_password.length >= 8 && new_password.length <= 32,
      letter: /[a-zA-Z]/.test(new_password),
      number: /\d/.test(new_password),
      match: new_password === confirm_password && new_password.length > 0
    };
    
    this.setData({
      passwordChecks: checks
    });
  },

  // 更新密码强度
  updatePasswordStrength() {
    const password = this.data.form.new_password;
    let strength = 0;
    
    if (password.length >= 8) strength++;
    if (/[a-zA-Z]/.test(password) && /\d/.test(password)) strength++;
    if (/[!@#$%^&*(),.?":{}|<>]/.test(password)) strength++;
    
    this.setData({
      passwordStrength: Math.min(strength, 3)
    });
  },

  // 获取强度文本
  getStrengthText(strength) {
    const texts = ['弱', '中', '强'];
    return texts[strength - 1] || '';
  },

  // 表单验证
  validateForm() {
    const { current_password, new_password, confirm_password } = this.data.form;
    const checks = this.data.passwordChecks;
    
    const isValid = current_password.length > 0 && 
                   new_password.length > 0 && 
                   confirm_password.length > 0 &&
                   checks.length &&
                   checks.letter &&
                   checks.number &&
                   checks.match;
    
    this.setData({
      isFormValid: isValid
    });
  },

  // 修改密码
  changePassword() {
    // 验证登录
    if (!this.checkLogin()) return;
    
    // 表单验证
    if (!this.data.isFormValid) {
      wx.showToast({
        title: '请填写完整并满足所有密码要求',
        icon: 'none'
      });
      return;
    }
    
    this.setData({ submitLoading: true });
    
    const token = wx.getStorageSync('access_token');
    const { current_password, new_password, confirm_password } = this.data.form;
    
    // 检查两次输入的新密码是否一致
    if (new_password !== confirm_password) {
      this.setData({ submitLoading: false });
      wx.showModal({
        title: '密码不一致',
        content: '两次输入的新密码不一致，请重新输入',
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }
    
    const submitData = {
      current_password: current_password,
      new_password: new_password,
      confirm_password: confirm_password
    };
    
    console.log('提交数据:', submitData);
    console.log('API地址:', 'https://api.jhzyfw.com/api/admin_change_password.php');
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/admin_change_password.php',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      data: submitData,
      success: (res) => {
        console.log('API响应:', res.data);
        
        // 修改这里：根据后端返回格式判断成功或失败
        if (res.data && res.data.success === true) {
          // 成功 - 显示成功提示并要求重新登录
          wx.showModal({
            title: '修改成功',
            content: '密码已成功修改！请使用新密码重新登录。',
            showCancel: false,
            confirmText: '重新登录',
            success: () => {
              // 清除登录信息
              wx.removeStorageSync('adminInfo');
              wx.removeStorageSync('access_token');
              wx.removeStorageSync('userInfo');
              
              // 跳转到登录页面
              wx.reLaunch({
                url: '/pages/login-unified/index?role=login-unified/index?role=admin'
              });
            }
          });
          
        } else if (res.data && res.data.message) {
          // 失败 - 显示后端返回的错误信息
          wx.showModal({
            title: '修改失败',
            content: res.data.message,
            showCancel: false,
            confirmText: '知道了'
          });
        } else {
          // 其他情况
          wx.showModal({
            title: '修改失败',
            content: '密码修改失败，请稍后重试',
            showCancel: false,
            confirmText: '知道了'
          });
        }
      },
      fail: (err) => {
        console.error('请求失败:', err);
        wx.showModal({
          title: '网络错误',
          content: '请检查网络连接后重试',
          showCancel: false,
          confirmText: '确定'
        });
      },
      complete: () => {
        this.setData({ submitLoading: false });
      }
    });
  },

  // 取消修改
  cancelChange() {
    wx.showModal({
      title: '确认取消',
      content: '确定要取消修改密码吗？已填写的内容将不会被保存。',
      confirmText: '确定',
      cancelText: '继续修改',
      success: (res) => {
        if (res.confirm) {
          wx.navigateBack();
        }
      }
    });
  }
});