// pages/register/register.js
import { userRegister, wxLogin } from '../../utils/request';

Page({
  data: {
    // 表单字段
    realname: "",      // 真实姓名
    id_card: "",       // 身份证号
    phone: "",         // 手机号
    gender: "",        // 性别
    age: "",           // 年龄
    emergency_contact: "", // 紧急联系人
    emergency_phone: "",   // 紧急联系电话
    password: "",      // 密码
    confirmPassword: "", // 确认密码
    
    // 页面状态
    redirectUrl: "",   // 注册后跳转的页面
    redirectParams: {}, // 跳转参数
    isRegistering: false, // 正在注册中
    openid: "", // 微信openid
    isGettingOpenid: false, // 正在获取openid
    
    // 表单验证状态
    validation: {
      realname: true,
      id_card: true,
      phone: true,
      password: true,
      confirmPassword: true,
      age: true,
      emergency_contact: true,
      emergency_phone: true
    },
    
    // 老年版适配
    isElderMode: false, 
    elderConfig: {
      normal: {
        fontSize: '28rpx', btnHeight: '88rpx', btnFontSize: '32rpx',
        inputHeight: '88rpx', inputFontSize: '28rpx', spacing: '20rpx', fontWeight: 'normal'
      },
      elder: {
        fontSize: '36rpx', btnHeight: '120rpx', btnFontSize: '38rpx',
        inputHeight: '100rpx', inputFontSize: '36rpx', spacing: '30rpx', fontWeight: 'bold'
      }
    },
    currentStyle: {
      fontSize: '28rpx', btnHeight: '88rpx', btnFontSize: '32rpx',
      inputHeight: '88rpx', inputFontSize: '28rpx', spacing: '20rpx', fontWeight: 'normal'
    }
  },

  onLoad(options) {
    console.log('注册页面加载，参数:', options);
    
    // 处理跳转参数
    if (options.redirect) {
      this.setData({ redirectUrl: decodeURIComponent(options.redirect) });
    }
    
    // 处理其他参数
    const params = {};
    for (let key in options) {
      if (key !== 'redirect' && key !== 'openid') {
        params[key] = options[key];
      }
    }
    if (Object.keys(params).length > 0) {
      this.setData({ redirectParams: params });
    }
    
    // 如果从微信登录跳转过来，有openid参数
    if (options.openid) {
      this.setData({ openid: options.openid });
      wx.setStorageSync('openid', options.openid);
    }
    
    // 如果从登录页跳转过来，有phone参数
    if (options.phone) {
      this.setData({ phone: options.phone });
    }
    
    this.initElderMode();
    
    // 如果没有openid，尝试获取
    if (!this.data.openid) {
      this.getWxOpenid();
    }
  },

  initElderMode() {
    try {
      const isElder = wx.getStorageSync('isElderMode') || false;
      this.setData({
        isElderMode: isElder,
        currentStyle: isElder ? this.data.elderConfig.elder : this.data.elderConfig.normal
      });
    } catch (e) {
      console.error('初始化老年版失败：', e);
      this.setData({ currentStyle: this.data.elderConfig.normal });
    }
  },

  toggleElderMode() {
    const newMode = !this.data.isElderMode;
    wx.setStorageSync('isElderMode', newMode);
    this.setData({
      isElderMode: newMode,
      currentStyle: newMode ? this.data.elderConfig.elder : this.data.elderConfig.normal
    });
    wx.showToast({ 
      title: newMode ? '已切换到老年版' : '已切换到普通版', 
      icon: 'success',
      duration: 1500
    });
  },

  // 获取微信openid
  async getWxOpenid() {
    if (this.data.isGettingOpenid) return;
    
    this.setData({ isGettingOpenid: true });
    
    try {
      wx.showLoading({ title: '微信验证中...', mask: true });
      
      // 使用统一的微信登录函数
      const res = await wxLogin();
      
      wx.hideLoading();
      
      if (res.code === 1) {
        // 未注册用户，获取到openid
        const openid = res.data.openid;
        this.setData({ openid: openid });
        wx.setStorageSync('openid', openid);
        
        wx.showToast({ 
          title: '微信验证成功', 
          icon: 'success',
          duration: 2000
        });
        
      } else if (res.code === 0) {
        // 已注册用户
        wx.showToast({ 
          title: '您已注册，请直接登录', 
          icon: 'success',
          duration: 2000
        });
        
        setTimeout(() => {
          wx.navigateTo({
            url: '/pages/profile/login/login'
          });
        }, 2000);
        
      } else {
        wx.showToast({ 
          title: res.msg || '微信验证失败', 
          icon: 'none',
          duration: 3000
        });
      }
      
    } catch (error) {
      wx.hideLoading();
      console.error('获取微信openid失败:', error);
      
      wx.showToast({ 
        title: '微信验证失败，请重试', 
        icon: 'none',
        duration: 3000
      });
      
    } finally {
      this.setData({ isGettingOpenid: false });
    }
  },

  // 输入框变化事件
  onInputChange(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    
    this.setData({
      [`${field}`]: value
    });
    
    // 实时验证
    this.validateField(field, value);
  },

  // 验证单个字段
  validateField(field, value) {
    let isValid = true;
    
    switch (field) {
      case 'realname':
        isValid = value.trim().length >= 2 && value.trim().length <= 20;
        break;
        
      case 'id_card':
        // 支持15位和18位身份证
        isValid = /(^\d{15}$)|(^\d{17}([0-9]|X|x)$)/.test(value);
        break;
        
      case 'phone':
        isValid = /^1[3-9]\d{9}$/.test(value);
        break;
        
      case 'password':
        isValid = value.length >= 6 && value.length <= 20;
        break;
        
      case 'confirmPassword':
        isValid = value === this.data.password;
        break;
        
      case 'age':
        const ageNum = parseInt(value);
        isValid = !isNaN(ageNum) && ageNum >= 1 && ageNum <= 120;
        break;
        
      case 'emergency_contact':
        isValid = value.trim().length >= 2;
        break;
        
      case 'emergency_phone':
        isValid = /^1[3-9]\d{9}$/.test(value);
        break;
        
      default:
        isValid = true;
    }
    
    this.setData({
      [`validation.${field}`]: isValid
    });
    
    return isValid;
  },

  // 选择性别
  chooseGender(e) {
    const gender = e.currentTarget.dataset.gender;
    this.setData({ gender: gender });
  },

  // 验证整个表单
  validateForm() {
    const {
      realname,
      id_card,
      phone,
      gender,
      age,
      emergency_contact,
      emergency_phone,
      password,
      confirmPassword,
      openid
    } = this.data;
    
    let isValid = true;
    
    // 验证每个字段
    const fields = [
      { field: 'realname', value: realname, message: '请输入2-20位的真实姓名' },
      { field: 'id_card', value: id_card, message: '请输入正确的身份证号' },
      { field: 'phone', value: phone, message: '请输入正确的手机号' },
      { field: 'password', value: password, message: '密码长度需在6-20位之间' },
      { field: 'confirmPassword', value: confirmPassword, message: '两次输入的密码不一致' },
      { field: 'age', value: age, message: '请输入1-120之间的有效年龄' },
      { field: 'emergency_contact', value: emergency_contact, message: '请输入紧急联系人姓名' },
      { field: 'emergency_phone', value: emergency_phone, message: '请输入正确的紧急联系电话' }
    ];
    
    for (const { field, value, message } of fields) {
      const fieldValid = this.validateField(field, value);
      if (!fieldValid) {
        wx.showToast({
          title: message,
          icon: 'none',
          duration: 3000
        });
        isValid = false;
        break;
      }
    }
    
    if (!gender) {
      wx.showToast({
        title: '请选择性别',
        icon: 'none',
        duration: 3000
      });
      isValid = false;
    }
    
    if (!openid) {
      wx.showToast({
        title: '请先完成微信验证',
        icon: 'none',
        duration: 3000
      });
      
      // 自动触发微信验证
      setTimeout(() => {
        this.getWxOpenid();
      }, 1000);
      
      isValid = false;
    }
    
    return isValid;
  },

  // 提交注册
  async submit() {
    if (this.data.isRegistering) return;
    
    if (!this.validateForm()) return;
    
    this.setData({ isRegistering: true });
    
    try {
      wx.showLoading({ title: '提交注册信息...', mask: true });
      
      // 准备注册数据
      const registerData = {
        openid: this.data.openid,
        real_name: this.data.realname.trim(),
        id_card: this.data.id_card,
        phone: this.data.phone,
        gender: this.data.gender,
        age: parseInt(this.data.age),
        emergency_contact: this.data.emergency_contact.trim(),
        emergency_phone: this.data.emergency_phone,
        password: this.data.password,
        type_code: 'V'
      };
      
      console.log('提交注册数据:', registerData);
      
      // 使用统一的注册函数
      const res = await userRegister(registerData);
      
      wx.hideLoading();
      
      console.log('注册响应:', res);
      
      if (res.code === 0) {
        // 注册成功
        wx.showToast({ 
          title: '注册成功！', 
          icon: 'success', 
          duration: 3000 
        });
        
        // 保存注册的手机号，方便登录
        wx.setStorageSync('lastRegisteredPhone', this.data.phone);
        
        // 延迟跳转到登录页面
        setTimeout(() => {
          // 如果有跳转页面，直接跳转
          if (this.data.redirectUrl) {
            let url = this.data.redirectUrl;
            const params = this.data.redirectParams;
            const queryParams = [];
            
            for (let key in params) {
              queryParams.push(`${key}=${encodeURIComponent(params[key])}`);
            }
            
            if (queryParams.length > 0) {
              url += (url.includes('?') ? '&' : '?') + queryParams.join('&');
            }
            
            wx.navigateTo({
              url: url
            });
          } else {
            // 跳转到登录页，自动填充手机号
            wx.navigateTo({
              url: `/pages/profile/login/login?phone=${this.data.phone}`
            });
          }
        }, 2000);
        
      } else {
        // 注册失败
        let errorMsg = res.msg || '注册失败，请重试';
        
        // 根据错误码提供更友好的提示
        switch (res.code) {
          case -2:
            errorMsg = '请填写完整的信息';
            break;
          case -4:
            errorMsg = '该身份证号已注册';
            // 提供跳转到登录的选项
            wx.showModal({
              title: '提示',
              content: '该身份证号已注册，是否前往登录？',
              confirmText: '去登录',
              cancelText: '取消',
              success: (modalRes) => {
                if (modalRes.confirm) {
                  wx.navigateTo({
                    url: `/pages/profile/login/login?phone=${this.data.phone}`
                  });
                }
              }
            });
            return; // 不显示其他提示
          case -5:
            errorMsg = '注册失败，请稍后重试';
            break;
        }
        
        wx.showToast({
          title: errorMsg,
          icon: 'none',
          duration: 4000
        });
      }
      
    } catch (error) {
      wx.hideLoading();
      console.error('注册请求失败:', error);
      
      let errorMsg = '网络错误，注册失败';
      if (error.message && error.message.includes('网络')) {
        errorMsg = '网络连接失败，请检查网络设置';
      }
      
      wx.showToast({
        title: errorMsg,
        icon: 'none',
        duration: 4000
      });
      
    } finally {
      this.setData({ isRegistering: false });
    }
  },

  // 重新获取微信openid
  retryWxAuth() {
    this.getWxOpenid();
  },

  // 跳转到登录页
  goToLogin() {
    let url = '/pages/profile/login/login';
    if (this.data.phone) {
      url += `?phone=${encodeURIComponent(this.data.phone)}`;
    }
    
    wx.navigateTo({
      url: url
    });
  },

  // 返回上一页
  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({
        url: '/pages/index/index'
      });
    }
  },

  // 清空表单
  clearForm() {
    this.setData({
      realname: "",
      id_card: "",
      phone: "",
      gender: "",
      age: "",
      emergency_contact: "",
      emergency_phone: "",
      password: "",
      confirmPassword: "",
      validation: {
        realname: true,
        id_card: true,
        phone: true,
        password: true,
        confirmPassword: true,
        age: true,
        emergency_contact: true,
        emergency_phone: true
      }
    });
  },

  // 快速测试数据（开发环境使用）
  fillTestData() {
    const app = getApp();
    if (!app.globalData.debugMode) return;
    
    wx.showActionSheet({
      itemList: ['测试数据1', '测试数据2', '清空数据'],
      success: (res) => {
        switch (res.tapIndex) {
          case 0:
            // 测试数据1
            this.setData({
              realname: '测试用户',
              id_card: '110101199001011234',
              phone: '13800138000',
              gender: '男',
              age: '25',
              emergency_contact: '紧急联系人',
              emergency_phone: '13800138001',
              password: 'Test@123',
              confirmPassword: 'Test@123'
            });
            break;
            
          case 1:
            // 测试数据2
            this.setData({
              realname: '测试用户2',
              id_card: '110101199001011235',
              phone: '13800138002',
              gender: '女',
              age: '30',
              emergency_contact: '紧急联系人2',
              emergency_phone: '13800138003',
              password: 'Aa123456',
              confirmPassword: 'Aa123456'
            });
            break;
            
          case 2:
            // 清空数据
            this.clearForm();
            break;
        }
        
        // 验证所有字段
        if (res.tapIndex <= 1) {
          const fields = ['realname', 'id_card', 'phone', 'age', 'password', 'confirmPassword', 'emergency_contact', 'emergency_phone'];
          fields.forEach(field => {
            this.validateField(field, this.data[field]);
          });
        }
      }
    });
  }
});