// pages/profile/edit/edit.js
import jhzyRequest from '../../../utils/request';

Page({
  data: {
    loading: true,
    submitting: false,
    
    // 用户信息（分三类）
    userInfo: {
      // 基本信息（管理员管理，只读）
      basicInfo: {
        volunteer_id: '',
        real_name: '',
        id_card: '',
        register_date: ''
      },
      
      // 联系信息（用户可修改）
      contactInfo: {
        phone: '',
        email: '',
        emergency_contact: '',
        emergency_phone: ''
      },
      
      // 个人资料（用户可修改）
      personalInfo: {
        gender: 'unknown',
        birthday: '',
        address: '',
        avatar: '',
        signature: ''
      }
    },
    
    // 性别选项
    genders: [
      { value: 'male', label: '男' },
      { value: 'female', label: '女' },
      { value: 'unknown', label: '保密' }
    ],
    
    // 表单错误
    formErrors: {},
    
    // 临时头像路径
    avatarTempPath: '',
    
    // 修改记录
    modifyHistory: []
  },

  onLoad() {
    this.loadUserProfile();
  },

  // 加载用户资料
  async loadUserProfile() {
    try {
      this.setData({ loading: true });
      
      const res = await jhzyRequest.get('user_profile.php');
      
      if (res.code === 0 && res.data) {
        const profile = res.data;
        
        // 修正头像URL
        let avatarUrl = profile.avatar || '/images/default-avatar.png';
        if (avatarUrl && !avatarUrl.startsWith('http') && !avatarUrl.startsWith('/images')) {
          if (avatarUrl.startsWith('/')) {
            avatarUrl = 'https://api.jhzyfw.com/api' + avatarUrl;
          } else {
            avatarUrl = 'https://api.jhzyfw.com/api/' + avatarUrl;
          }
        }
        
        this.setData({
          userInfo: {
            basicInfo: {
              volunteer_id: profile.volunteer_id || '暂无',
              real_name: profile.real_name || '',
              id_card: profile.id_card ? this.maskIdCard(profile.id_card) : '未填写',
              register_date: profile.register_date || '未知'
            },
            contactInfo: {
              phone: profile.phone || '',
              email: profile.email || '',
              emergency_contact: profile.emergency_contact || '',
              emergency_phone: profile.emergency_phone || ''
            },
            personalInfo: {
              gender: profile.gender === '1' ? 'male' : (profile.gender === '2' ? 'female' : 'unknown'),
              birthday: profile.birthday || '',
              address: profile.address || '',
              avatar: avatarUrl,
              signature: profile.signature || ''
            }
          }
        });
        
        // 如果有修改历史
        if (profile.modify_history) {
          this.setData({ modifyHistory: profile.modify_history });
        }
        
      } else {
        wx.showToast({
          title: res.msg || '加载失败',
          icon: 'none'
        });
      }
      
    } catch (error) {
      console.error('加载用户资料失败:', error);
      wx.showToast({
        title: '网络错误',
        icon: 'none'
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 身份证脱敏处理
  maskIdCard(idCard) {
    if (!idCard || idCard.length < 15) return idCard;
    return idCard.substring(0, 4) + '***********' + idCard.substring(idCard.length - 4);
  },

  // 输入框变化（可修改字段）
  onInputChange(e) {
    const { category, field } = e.currentTarget.dataset;
    const value = e.detail.value;
    
    // 只允许修改 contactInfo 和 personalInfo 中的字段
    if (category === 'contactInfo' || category === 'personalInfo') {
      this.setData({
        [`userInfo.${category}.${field}`]: value,
        [`formErrors.${field}`]: ''  // 清除该字段的错误
      });
    }
  },

  // 性别选择
  onGenderSelect(e) {
    const gender = e.currentTarget.dataset.gender;
    this.setData({
      'userInfo.personalInfo.gender': gender
    });
  },

  // 生日选择
  onBirthdaySelect() {
    const currentDate = this.data.userInfo.personalInfo.birthday || '2000-01-01';
    const maxDate = new Date().toISOString().split('T')[0];
    
    wx.showDatePicker({
      currentDate: currentDate,
      startDate: '1900-01-01',
      endDate: maxDate,
      success: (res) => {
        const date = res.date;
        const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        
        this.setData({
          'userInfo.personalInfo.birthday': formattedDate
        });
      }
    });
  },

  // 选择头像 - 跳转到我的页面进行头像上传
  async chooseAvatar() {
    wx.showModal({
      title: '修改头像',
      content: '请到“我的”页面点击头像进行修改',
      confirmText: '去修改',
      success: (res) => {
        if (res.confirm) {
          wx.switchTab({
            url: '/pages/mine/mine'
          });
        }
      }
    });
  },

  // 表单验证（只验证可修改字段）
  validateForm() {
    const errors = {};
    const { contactInfo } = this.data.userInfo;
    
    // 手机号验证
    if (!contactInfo.phone.trim()) {
      errors.phone = '请输入手机号码';
    } else if (!/^1[3-9]\d{9}$/.test(contactInfo.phone)) {
      errors.phone = '请输入正确的手机号码';
    }
    
    // 邮箱验证
    if (contactInfo.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactInfo.email)) {
      errors.email = '邮箱格式不正确';
    }
    
    // 紧急联系人电话验证
    if (contactInfo.emergency_phone && !/^1[3-9]\d{9}$/.test(contactInfo.emergency_phone)) {
      errors.emergency_phone = '紧急联系人电话格式不正确';
    }
    
    this.setData({ formErrors: errors });
    return Object.keys(errors).length === 0;
  },

  // 提交保存（只提交可修改字段）
  async onSubmit() {
    if (this.data.submitting) return;
    
    // 表单验证
    if (!this.validateForm()) {
      wx.showToast({
        title: '请检查表单错误',
        icon: 'none'
      });
      return;
    }
    
    try {
      this.setData({ submitting: true });
      wx.showLoading({ title: '保存中...', mask: true });
      
      // 准备提交数据（只包含可修改字段）
      const submitData = {
        // 联系信息
        phone: this.data.userInfo.contactInfo.phone,
        emergency_contact: this.data.userInfo.contactInfo.emergency_contact || '',
        emergency_phone: this.data.userInfo.contactInfo.emergency_phone || '',
        
        // 个人资料
        gender: this.data.userInfo.personalInfo.gender === 'male' ? '1' :
                      this.data.userInfo.personalInfo.gender === 'female' ? '2' : '',
        birthday: this.data.userInfo.personalInfo.birthday || null,
        address: this.data.userInfo.personalInfo.address || ''
      };
      
      const res = await jhzyRequest.post('update_profile.php', submitData);
      
      wx.hideLoading();
      
      if (res.code === 0) {
        wx.showToast({
          title: '保存成功',
          icon: 'success',
          duration: 1500
        });
        
        // 更新本地存储的联系信息
        const cachedUser = wx.getStorageSync('userInfo') || {};
        wx.setStorageSync('userInfo', {
          ...cachedUser,
          phone: submitData.phone
        });
        
        // 延迟返回
        setTimeout(() => {
          wx.navigateBack();
        }, 1500);
        
      } else {
        wx.showToast({
          title: res.msg || '保存失败',
          icon: 'none'
        });
      }
      
    } catch (error) {
      console.error('保存资料失败:', error);
      wx.hideLoading();
      wx.showToast({
        title: '网络错误',
        icon: 'none'
      });
    } finally {
      this.setData({ submitting: false });
    }
  },

  // 重置表单（只重置可修改字段）
  onReset() {
    wx.showModal({
      title: '确认重置',
      content: '确定要放弃所有修改吗？',
      confirmText: '重置',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          this.loadUserProfile();
          this.setData({ formErrors: {} });
        }
      }
    });
  },

  // 修改密码
  onChangePassword() {
    wx.navigateTo({
      url: '/pages/profile/change-password/change-password'
    });
  },

  // 查看志愿者证（暂时移除）
  viewVolunteerCard() {
    wx.showToast({
      title: '志愿者证功能开发中',
      icon: 'none',
      duration: 2000
    });
  },

  // 联系管理员修改信息
  contactAdminForModify() {
    const phone = '0573-82099982';
    
    wx.showModal({
      title: '联系管理员',
      content: `如需修改姓名、身份证号等核心信息，请联系管理员：\n\n${phone}\n\n工作时间：周一至周五 9:00-18:00`,
      confirmText: '复制号码',
      cancelText: '知道了',
      success: (res) => {
        if (res.confirm) {
          wx.setClipboardData({
            data: phone,
            success: () => {
              wx.showToast({
                title: '号码已复制',
                icon: 'success'
              });
            }
          });
        }
      }
    });
  },

  // 复制志愿者ID
  copyVolunteerId() {
    const volunteerId = this.data.userInfo.basicInfo.volunteer_id;
    if (!volunteerId) return;
    
    wx.setClipboardData({
      data: volunteerId,
      success: () => {
        wx.showToast({
          title: '已复制志愿者ID',
          icon: 'success'
        });
      }
    });
  },

  // 返回
  goBack() {
    wx.navigateBack();
  }
});