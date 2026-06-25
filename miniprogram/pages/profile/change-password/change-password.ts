// pages/profile/change-password/change-password.js
import jhzyRequest from '../../../utils/request';

Page({
  data: {
    // 表单数据
    formData: {
      old_password: '',
      new_password: '',
      confirm_password: ''
    },
    
    // 表单错误
    formErrors: {
      old_password: '',
      new_password: '',
      confirm_password: ''
    },
    
    // 状态
    loading: false,
    submitting: false,
    passwordStrength: 0,
    isFormValid: false,
    
    // 密码验证状态
    isValidPasswordLength: false,
    isValidPasswordComplexity: false
  },

  onLoad() {
    console.log('修改密码页面加载');
  },

  onShow() {
    console.log('修改密码页面显示');
  },

  // 返回上一页
  goBack() {
    wx.navigateBack();
  },

  // 输入框变化
  onInputChange(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    
    this.setData({
      [`formData.${field}`]: value,
      [`formErrors.${field}`]: ''
    });
    
    // 如果是新密码字段，检查密码强度和规则
    if (field === 'new_password') {
      this.checkPasswordStrength(value);
      this.checkPasswordRules(value);
    }
    
    // 如果是确认密码字段，检查是否一致
    if (field === 'confirm_password' || field === 'new_password') {
      this.checkPasswordMatch();
    }
    
    // 更新表单有效性状态
    this.updateFormValid();
  },

  // 检查密码强度
  checkPasswordStrength(password) {
    let strength = 0;
    
    if (password.length >= 6) strength++;
    if (password.length >= 8) strength++;
    
    // 检查是否包含字母和数字
    const hasLetter = /[a-zA-Z]/.test(password);
    const hasNumber = /\d/.test(password);
    const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);
    
    if (hasLetter && hasNumber) strength++;
    if (hasSpecial) strength++;
    
    this.setData({ passwordStrength: strength });
  },

  // 检查密码规则
  checkPasswordRules(password) {
    const isValidLength = password.length >= 6 && password.length <= 20;
    const hasLetter = /[a-zA-Z]/.test(password);
    const hasNumber = /\d/.test(password);
    const isValidComplexity = hasLetter && hasNumber;
    
    this.setData({
      isValidPasswordLength: isValidLength,
      isValidPasswordComplexity: isValidComplexity
    });
  },

  // 检查密码是否匹配
  checkPasswordMatch() {
    const { new_password, confirm_password } = this.data.formData;
    
    if (confirm_password && new_password !== confirm_password) {
      this.setData({
        'formErrors.confirm_password': '两次输入的密码不一致'
      });
    } else if (this.data.formErrors.confirm_password) {
      this.setData({
        'formErrors.confirm_password': ''
      });
    }
  },

  // 更新表单有效性状态
  updateFormValid() {
    const { old_password, new_password, confirm_password } = this.data.formData;
    const { formErrors, isValidPasswordLength, isValidPasswordComplexity } = this.data;
    
    // 基本检查
    let isValid = true;
    if (!old_password || !new_password || !confirm_password) isValid = false;
    if (Object.values(formErrors).some(error => error)) isValid = false;
    
    // 密码规则检查
    if (!isValidPasswordLength || !isValidPasswordComplexity) isValid = false;
    if (new_password !== confirm_password) isValid = false;
    
    this.setData({ isFormValid: isValid });
  },

  // 验证表单
  validateForm() {
    const { old_password, new_password, confirm_password } = this.data.formData;
    const errors = {};
    let isValid = true;
    
    // 验证当前密码
    if (!old_password.trim()) {
      errors.old_password = '请输入当前密码';
      isValid = false;
    } else if (old_password.length < 6) {
      errors.old_password = '密码长度不少于6位';
      isValid = false;
    }
    
    // 验证新密码
    if (!new_password.trim()) {
      errors.new_password = '请输入新密码';
      isValid = false;
    } else if (new_password.length < 6) {
      errors.new_password = '新密码长度不少于6位';
      isValid = false;
    } else if (new_password.length > 20) {
      errors.new_password = '新密码长度不超过20位';
      isValid = false;
    } else if (!/^(?=.*[a-zA-Z])(?=.*\d)/.test(new_password)) {
      errors.new_password = '新密码需包含字母和数字';
      isValid = false;
    }
    
    // 验证确认密码
    if (!confirm_password.trim()) {
      errors.confirm_password = '请确认新密码';
      isValid = false;
    } else if (new_password !== confirm_password) {
      errors.confirm_password = '两次输入的密码不一致';
      isValid = false;
    }
    
    // 检查新密码是否与旧密码相同
    if (old_password && new_password && old_password === new_password) {
      errors.new_password = '新密码不能与当前密码相同';
      isValid = false;
    }
    
    this.setData({ formErrors: errors });
    return isValid;
  },

  // 忘记密码
  onForgotPassword() {
    wx.showModal({
      title: '忘记密码',
      content: '如果您忘记了密码，请联系管理员重置。\n\n管理员电话：0573-82099982\n工作时间：周一至周五 9:00-18:00',
      confirmText: '知道了',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          // 可以跳转到联系客服页面
          // wx.navigateTo({ url: '/pages/help/contact' });
        }
      }
    });
  },

  // 取消修改
  onCancel() {
    wx.showModal({
      title: '确认取消',
      content: '确定要放弃修改密码吗？',
      confirmText: '放弃',
      cancelText: '继续修改',
      success: (res) => {
        if (res.confirm) {
          wx.navigateBack();
        }
      }
    });
  },

  // 提交修改
  async onSubmit() {
    // 验证表单
    if (!this.validateForm()) {
      wx.showToast({
        title: '请检查表单',
        icon: 'none',
        duration: 2000
      });
      return;
    }
    
    this.setData({ submitting: true });
    
    try {
      // 调用修改密码API
      const res = await jhzyRequest.post('change_password.php', {
        old_password: this.data.formData.old_password,
        new_password: this.data.formData.new_password,
        confirm_password: this.data.formData.confirm_password
      });
      
      console.log('修改密码响应:', res);
      
      if (res.code === 0 || res.code === 200) {
        // 修改成功
        wx.showToast({
          title: '密码修改成功',
          icon: 'success',
          duration: 2000
        });
        
        // 清除本地token（强制重新登录）
        setTimeout(() => {
          wx.removeStorageSync('access_token');
          wx.removeStorageSync('userInfo');
          wx.removeStorageSync('isLoggedIn');
          
          wx.reLaunch({
            url: '/pages/profile/login/login'
          });
        }, 1500);
        
      } else {
        // 修改失败
        let errorMessage = res.msg || '修改密码失败';
        
        // 处理特定错误
        if (errorMessage.includes('当前密码') || errorMessage.includes('old password')) {
          this.setData({
            'formErrors.old_password': '当前密码错误'
          });
        } else if (errorMessage.includes('新密码') || errorMessage.includes('new password')) {
          this.setData({
            'formErrors.new_password': errorMessage
          });
        }
        
        wx.showToast({
          title: errorMessage,
          icon: 'none',
          duration: 2000
        });
      }
      
    } catch (error) {
      console.error('修改密码请求失败详情:', error);
      console.error('请求URL:', 'change_password.php');
      console.error('请求数据:', {
        old_password: this.data.formData.old_password,
        new_password: this.data.formData.new_password,
        confirm_password: this.data.formData.confirm_password
      });
      
      wx.showToast({
        title: '网络请求失败，请重试',
        icon: 'none',
        duration: 2000
      });
      
    } finally {
      this.setData({ submitting: false });
    }
  }
});