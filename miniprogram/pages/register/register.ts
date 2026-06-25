// pages/profile/register/register.js
const app = getApp();

Page({
  data: {
    // 显示模式
    isSeniorMode: false,
    
    // 表单数据
    formData: {
      real_name: '',      // 真实姓名
      id_card: '',        // 身份证号
      phone: '',          // 手机号
      password: '',       // 密码
      confirm_password: '', // 确认密码
      emergency_contact: '', // 紧急联系人
      emergency_phone: ''    // 紧急联系人电话
    },
    
    // 表单验证
    validation: {
      real_name: true,
      id_card: true,
      phone: true,
      password: true,
      confirm_password: true,
      emergency_contact: true,
      emergency_phone: true
    },
    
    // 显示/隐藏密码
    showPassword: false,
    showConfirmPassword: false,
    
    // 加载状态
    loading: false,
    
    // 用户协议
    agreeProtocol: false,
    
    // 老年版：简化模式
    simpleMode: false,
    
    // openid
    openid: '',
    hasOpenid: false,
    wxLoginLoading: false,
    
    // 协议弹窗
    showProtocolModal: false,
    protocolContent: `《嘉禾志愿用户服务协议》

欢迎使用嘉禾志愿服务平台！为明确双方权利和义务，规范双方行为，本着诚实信用原则，根据《中华人民共和国民法典》《中华人民共和国网络安全法》《中华人民共和国个人信息保护法》等相关法律法规的规定，特制定本协议。

一、总则
1.1 本协议是您与嘉禾志愿平台之间就使用志愿服务相关服务订立的协议。
1.2 您在使用嘉禾志愿服务前，应当仔细阅读本协议，并同意遵守本协议及所有平台规则。
1.3 您点击"同意"按钮即视为您已阅读、理解并同意接受本协议全部条款的约束。

二、服务内容
2.1 嘉禾志愿平台提供志愿服务信息发布、志愿者注册管理、志愿服务时长记录、积分激励兑换等服务。
2.2 平台有权根据实际情况调整服务内容，并通过公告等形式通知用户。
2.3 平台仅提供信息服务，具体志愿服务活动由活动组织方负责实施。

三、用户注册与账号
3.1 您注册时需提供真实、准确、完整的个人信息，包括但不限于姓名、身份证号、手机号等。
3.2 您有义务维护账号安全，不得将账号转让、出借或与他人共享。
3.3 如发现账号被盗用，应立即通知平台，平台将协助您采取措施。

四、用户权利与义务
4.1 您有权参与平台发布的志愿服务活动，并获取相应志愿服务时长记录。
4.2 您有义务遵守国家法律法规，不得利用本平台从事任何违法活动。
4.3 您应按时参加已报名的志愿服务活动，如无法参加应及时取消报名。
4.4 您应尊重活动组织方的管理，遵守活动现场秩序。

五、志愿服务规范
5.1 志愿服务时长以平台系统记录为准，组织方应在活动结束后及时确认。
5.2 志愿服务积分可用于兑换平台提供的激励物品，具体规则详见积分商城。
5.3 平台鼓励诚信参与志愿服务，严禁虚假签到、冒名顶替等行为。

六、个人信息收集与保护

6.1 手机号码的收集与使用
6.1.1 收集目的：您的手机号码将用于以下用途：
（1）完成用户注册和登录，建立您的志愿者身份；
（2）接收志愿服务活动通知、报名确认、时长审核等重要信息；
（3）在紧急情况下与您取得联系，保障您的安全和权益；
（4）进行志愿者身份核验，确保志愿服务记录的真实性；
（5）处理您提出的咨询、投诉或建议时进行身份验证。

6.1.2 收集方式：在您注册账号时，我们会通过以下方式收集您的手机号码：
（1）您主动填写的手机号码；
（2）通过微信授权的手机号码（需您单独授权）；
（3）通过短信验证码进行核验，确保手机号码的真实有效。

6.1.3 使用方式：我们将通过短信、平台内通知等方式，使用您的手机号码与您联系。平台不会将您的手机号码用于与志愿服务无关的商业推广。

6.2 其他个人信息的收集
6.2.1 姓名和身份证号：用于实名认证，确保志愿者身份的真实性，符合国家关于志愿服务实名制的要求。
6.2.2 地理位置信息：用于签到签退时的位置验证，确保志愿服务时长的真实性。此信息仅在您使用签到功能时临时获取，不进行持续收集。
6.2.3 微信头像和昵称：用于在平台内展示您的志愿者身份，便于活动组织方识别。

6.3 信息存储与保护
6.3.1 平台将采取符合业界标准的安全防护措施，包括加密存储、访问控制、安全审计等，防止您的个人信息被泄露、篡改或丢失。
6.3.2 您的个人信息仅在本平台使用，未经您单独同意，平台不会向任何第三方共享、转让或公开披露您的个人信息，但法律法规另有规定或司法行政机关要求的情形除外。
6.3.3 当您注销账号时，平台将依法删除或匿名化处理您的个人信息。

6.4 您的个人信息权利
6.4.1 您有权查阅、复制、更正您的个人信息，可在"个人中心"进行操作或联系客服处理。
6.4.2 您有权撤回同意，撤回后可能影响您正常使用平台服务。
6.4.3 如您对个人信息保护有任何疑问，可通过客服邮箱【请填写邮箱】与我们联系。

七、免责声明
7.1 因不可抗力（如自然灾害、政府行为等）导致服务中断，平台不承担责任。
7.2 因您自身原因（如操作不当、设备故障等）造成的损失，由您自行承担。
7.3 平台作为信息发布方，不对第三方组织方的行为承担连带责任。

八、协议修改与终止
8.1 平台有权根据法律法规变化或业务调整修改本协议，修改后的协议将公示。
8.2 如您不同意修改后的协议，可停止使用平台服务。
8.3 平台有权对违反协议的用户暂停或终止服务。

九、争议解决
9.1 本协议的订立、执行和解释均适用中华人民共和国法律。
9.2 如发生争议，双方应友好协商解决；协商不成的，可向平台所在地人民法院提起诉讼。

十、其他
10.1 本协议自您点击同意之日起生效。
10.2 本协议条款部分无效不影响其他条款的效力。
10.3 平台拥有对本协议的最终解释权。

感谢您阅读本协议！点击"同意"表示您已充分理解并接受全部条款。`
  },

  onLoad(options) {
    console.log('注册页面加载', options);
    this.initDisplayMode();
    
    // 接收openid参数
    if (options.openid) {
      this.setData({
        openid: options.openid,
        hasOpenid: true
      });
      console.log('从登录页传递openid:', options.openid);
    }
    
    // 接收手机号参数
    if (options.phone) {
      this.setData({
        'formData.phone': options.phone
      });
    }
    
    // 如果没有openid，自动进行微信登录
    if (!options.openid) {
      this.wxLoginForOpenid();
    }
  },

  // 新增：供app.js调用的启动协议弹窗
  showLaunchProtocolModal() {
    // 检查是否已经同意过协议
    const hasAgreedProtocol = wx.getStorageSync('hasAgreedProtocol');
    const hasAgreedPrivacy = wx.getStorageSync('hasAgreedPrivacy');
    
    // 如果还没有同意过，显示协议弹窗
    if (!hasAgreedProtocol || !hasAgreedPrivacy) {
      this.setData({
        showProtocolModal: true
      });
    }
  },

  onShow() {
    this.initDisplayMode();
  },

  // 初始化显示模式
  initDisplayMode() {
    const displayMode = app.globalData.displayMode;
    const isSeniorMode = displayMode === 'senior';
    
    this.setData({
      isSeniorMode: isSeniorMode,
      simpleMode: isSeniorMode // 老年版使用简化模式
    });
    
    console.log('当前显示模式:', displayMode);
  },

  // 微信登录获取openid
  wxLoginForOpenid() {
    if (this.data.wxLoginLoading) return;
    
    this.setData({ wxLoginLoading: true });
    
    console.log('开始微信登录获取openid...');
    
    wx.login({
      success: (res) => {
        if (res.code) {
          console.log('获取微信code成功:', res.code);
          
          // 调用微信登录接口获取openid
          wx.request({
            url: app.globalData.apiBaseUrl + 'wxlogin.php',
            method: 'POST',
            header: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            data: { code: res.code },
            success: (wxRes) => {
              console.log('微信登录接口响应:', wxRes.data);
              
              if (wxRes.data.code === 0) {
                // 已注册用户，但仍允许注册流程继续
                const openid = wxRes.data.data.openid;
                console.log('用户已注册，openid:', openid);
                
                this.setData({
                  openid: openid,
                  hasOpenid: true,
                  wxLoginLoading: false
                });
                
                wx.showToast({
                  title: '微信验证成功',
                  icon: 'success',
                  duration: 1500
                });
              } else if (wxRes.data.code === 1) {
                // 未注册用户，获取到openid
                const openid = wxRes.data.data.openid;
                console.log('获取openid成功:', openid);
                
                this.setData({
                  openid: openid,
                  hasOpenid: true,
                  wxLoginLoading: false
                });
                
                wx.showToast({
                  title: '微信验证成功',
                  icon: 'success',
                  duration: 1500
                });
                
              } else {
                console.error('微信登录失败:', wxRes.data.msg);
                wx.showToast({
                  title: wxRes.data.msg || '微信登录失败',
                  icon: 'none',
                  duration: 3000
                });
                this.setData({ wxLoginLoading: false });
              }
            },
            fail: (err) => {
              console.error('调用微信登录接口失败:', err);
              wx.showToast({
                title: '网络错误',
                icon: 'none'
              });
              this.setData({ wxLoginLoading: false });
            }
          });
        } else {
          console.error('获取微信code失败:', res.errMsg);
          wx.showToast({
            title: '微信登录失败',
            icon: 'none'
          });
          this.setData({ wxLoginLoading: false });
        }
      },
      fail: (err) => {
        console.error('微信登录失败:', err);
        wx.showToast({
          title: '微信登录失败',
          icon: 'none'
        });
        this.setData({ wxLoginLoading: false });
      }
    });
  },

  // 重新进行微信登录
  retryWxLogin() {
    this.wxLoginForOpenid();
  },

  // 输入框变化
  onInputChange(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    
    this.setData({
      [`formData.${field}`]: value
    });
    
    // 实时验证
    this.validateField(field, value);
  },

  // 验证单个字段
  validateField(field, value) {
    let isValid = true;
    
    switch(field) {
      case 'real_name':
        isValid = value.trim().length >= 2 && value.trim().length <= 10;
        break;
      case 'id_card':
        isValid = /^\d{17}[\dXx]$/.test(value);
        break;
      case 'phone':
        isValid = /^1[3-9]\d{9}$/.test(value);
        break;
      case 'password':
        isValid = value.length >= 6 && value.length <= 20;
        // 如果确认密码已填写，需要重新验证确认密码
        if (this.data.formData.confirm_password) {
          this.validateField('confirm_password', this.data.formData.confirm_password);
        }
        break;
      case 'confirm_password':
        isValid = value === this.data.formData.password && value.length >= 6;
        break;
      case 'emergency_contact':
        isValid = this.data.simpleMode || (value.trim().length >= 2 && value.trim().length <= 10);
        break;
      case 'emergency_phone':
        isValid = this.data.simpleMode || /^1[3-9]\d{9}$/.test(value) || /^\d{7,}$/.test(value);
        break;
      default:
        isValid = true;
    }
    
    this.setData({
      [`validation.${field}`]: isValid
    });
    
    return isValid;
  },

  // 切换密码显示
  togglePassword() {
    this.setData({
      showPassword: !this.data.showPassword
    });
  },

  // 切换确认密码显示
  toggleConfirmPassword() {
    this.setData({
      showConfirmPassword: !this.data.showConfirmPassword
    });
  },

  // 切换协议同意状态
  toggleProtocol() {
    const agree = !this.data.agreeProtocol;
    if (agree) {
      // 如果点击同意，显示协议弹窗
      this.showProtocolModal();
    } else {
      this.setData({
        agreeProtocol: false
      });
    }
  },

  // 显示用户协议弹窗
  showProtocolModal() {
    this.setData({
      showProtocolModal: true
    });
  },

  // 隐藏用户协议弹窗
  hideProtocolModal() {
    this.setData({
      showProtocolModal: false
    });
  },

  // 同意协议
  agreeProtocol() {
    this.setData({
      agreeProtocol: true,
      showProtocolModal: false
    });
    
    // 存储协议同意状态
    wx.setStorageSync('hasAgreedProtocol', true);
    wx.setStorageSync('hasAgreedPrivacy', true);
    
    wx.showToast({
      title: '已同意协议',
      icon: 'success',
      duration: 1500
    });
  },

  // 查看用户协议
  viewUserProtocol() {
    wx.navigateTo({
      url: '/pages/settings/terms/terms'
    });
  },

  // 查看隐私政策
  viewPrivacyPolicy() {
    wx.navigateTo({
      url: '/pages/privacy/privacy'
    });
  },

  // 验证整个表单
  validateForm() {
    const { formData, simpleMode, hasOpenid } = this.data;
    let isValid = true;
    
    // 检查openid
    if (!hasOpenid) {
      wx.showToast({
        title: '请先完成微信验证',
        icon: 'none'
      });
      return false;
    }
    
    // 验证必填字段
    const requiredFields = ['real_name', 'id_card', 'phone', 'password', 'confirm_password'];
    if (!simpleMode) {
      requiredFields.push('emergency_contact', 'emergency_phone');
    }
    
    requiredFields.forEach(field => {
      const fieldValid = this.validateField(field, formData[field]);
      if (!fieldValid) {
        isValid = false;
      }
    });
    
    // 检查协议
    if (!this.data.agreeProtocol) {
      wx.showToast({
        title: '请阅读并同意用户协议和隐私政策',
        icon: 'none'
      });
      return false;
    }
    
    return isValid;
  },

  // 提交注册
  onSubmit() {
    if (this.data.loading) return;
    
    // 检查openid
    if (!this.data.hasOpenid) {
      wx.showToast({
        title: '请先完成微信验证',
        icon: 'none'
      });
      this.retryWxLogin();
      return;
    }
    
    // 验证表单
    if (!this.validateForm()) {
      wx.showToast({
        title: '请检查表单信息',
        icon: 'none'
      });
      return;
    }
    
    this.setData({ loading: true });
    
    const that = this;
    const { formData, simpleMode, openid } = this.data;
    
    // 准备注册数据 - 使用register.php接口
    const registerData = {
      openid: openid,
      real_name: formData.real_name,
      id_card: formData.id_card,
      phone: formData.phone,
      password: formData.password
    };
    
    // 添加可选字段
    if (!simpleMode && formData.emergency_contact) {
      registerData.emergency_contact = formData.emergency_contact;
    }
    
    if (!simpleMode && formData.emergency_phone) {
      registerData.emergency_phone = formData.emergency_phone;
    }
    
    console.log('提交注册数据:', registerData);
    
    // 显示加载提示
    wx.showLoading({
      title: '注册中...',
      mask: true
    });
    
    // 使用register.php接口
    wx.request({
      url: app.globalData.apiBaseUrl + 'register.php',
      method: 'POST',
      header: {
        'content-type': 'application/x-www-form-urlencoded'
      },
      data: registerData,
      success(res) {
        console.log('注册API响应:', res.data);
        wx.hideLoading();
        
        if (res.data.code === 0) {
          // 注册成功，等待审核
          const responseData = res.data.data || {};
          
          // 保存临时token和审核状态
          if (responseData.temp_token) {
            wx.setStorageSync('access_token', responseData.temp_token);
            wx.setStorageSync('token_expire', responseData.token_expire);
            
            const pendingUserInfo = {
              real_name: formData.real_name,
              phone: formData.phone,
              status: 'pending',
              temp_token: responseData.temp_token,
              token_expire: responseData.token_expire,
              message: responseData.message || '请等待管理员审核'
            };
            
            wx.setStorageSync('userInfo', pendingUserInfo);
            wx.setStorageSync('isLoggedIn', false); // 未激活，不能登录
            wx.setStorageSync('pendingApproval', true); // 标记为待审核状态
            app.globalData.userInfo = pendingUserInfo;
            app.globalData.pendingApproval = true;
          }
          
          // 显示审核提示
          wx.showModal({
            title: '注册成功',
            content: '您的注册申请已提交！\n\n请等待管理员审核，审核通过后您将收到通知并可以开始使用全部功能。\n\n审核状态：待审核',
            showCancel: false,
            confirmText: '我知道了',
            success() {
              // 跳转到审核状态页面或首页
              const pages = getCurrentPages();
              if (pages.length > 1) {
                wx.navigateBack({
                  delta: 1
                });
              } else {
                wx.switchTab({
                  url: '/pages/index/index'
                });
              }
            }
          });
          
        } else if (res.data.code === -6) {
          // 用户已存在
          wx.showModal({
            title: '提示',
            content: '该身份证或手机号已注册，是否前往登录？',
            confirmText: '去登录',
            cancelText: '重新填写',
            success(modalRes) {
              if (modalRes.confirm) {
                wx.navigateTo({
                  url: '/pages/profile/login/login?phone=' + encodeURIComponent(formData.phone)
                });
              }
            }
          });
        } else if (res.data.code === -8) {
          // 申请正在审核中
          wx.showModal({
            title: '提示',
            content: '您的申请正在审核中，请耐心等待。审核通过后您将收到通知。',
            showCancel: false,
            confirmText: '我知道了',
            success() {
              wx.navigateBack();
            }
          });
        } else {
          // 其他错误
          let errorMsg = res.data.msg || '注册失败';
          
          // 简化错误信息显示
          if (errorMsg.includes('SQL') || errorMsg.includes('database')) {
            errorMsg = '系统繁忙，请稍后重试';
          }
          
          wx.showToast({
            title: errorMsg,
            icon: 'none',
            duration: 3000
          });
        }
      },
      fail(err) {
        console.error('注册请求失败:', err);
        wx.hideLoading();
        wx.showToast({
          title: '网络错误，请检查网络连接',
          icon: 'none',
          duration: 3000
        });
      },
      complete() {
        that.setData({ loading: false });
      }
    });
  },

  // 跳转到登录
  goToLogin() {
    wx.navigateTo({
      url: '/pages/profile/login/login'
    });
  },

  // 返回上一页
  goBack() {
    wx.navigateBack();
  }
});