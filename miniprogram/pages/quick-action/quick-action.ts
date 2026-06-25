// pages/quick-action/quick-action.js
const app = getApp();

Page({
  data: {
    // 用户信息
    userInfo: null,
    isLoggedIn: false,
    
    // 今日积分相关
    todayPoints: 0,
    maxPointsPerDay: 5,
    progressPercent: 0,
    
    // 显示控制
    seniorMode: false,
    vibrationEnabled: true,
    
    // 公益行动列表
    actions: [
      {
        id: 1,
        type: 'bike_tidy',
        name: '整理共享单车',
        points: 1,
        icon: '🚲',
        description: '将乱放的共享单车摆放整齐',
        example: '下班路上看到共享单车倒了，花2分钟扶起来摆好',
        time: 2
      },
      {
        id: 2,
        type: 'trash_pick',
        name: '捡拾垃圾',
        points: 1,
        icon: '🗑️',
        description: '清理路上的可见垃圾',
        example: '散步时捡起路上的塑料瓶扔进垃圾桶',
        time: 2
      },
      {
        id: 3,
        type: 'help_elder',
        name: '帮助老人',
        points: 1,
        icon: '👴',
        description: '帮助需要帮助的老年人',
        example: '扶老人过马路，帮老人提重物',
        time: 5
      },
      {
        id: 4,
        type: 'traffic_guide',
        name: '交通引导',
        points: 1,
        icon: '🚦',
        description: '在拥堵路口引导交通',
        example: '在学校门口帮忙维持交通秩序',
        time: 5
      },
      {
        id: 5,
        type: 'community_clean',
        name: '社区清洁',
        points: 1,
        icon: '🏘️',
        description: '打扫社区公共区域',
        example: '周末清扫楼道或小区公共区域',
        time: 10
      },
      {
        id: 6,
        type: 'charity_share',
        name: '公益宣传',
        points: 1,
        icon: '📢',
        description: '分享公益信息或活动',
        example: '在朋友圈分享公益活动信息',
        time: 1
      }
    ],
    
    // 记录相关
    quickRecords: [],
    showCameraModal: false,
    currentAction: {},
    photoPath: '',
    actionDescription: '',
    descriptionLength: 0,
    
    // 定位相关
    location: null,
    locationName: '',
    isGettingLocation: false,
    showLocationPicker: false,
    manualLocationInput: '',
    
    // 分页相关
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false
  },

  onLoad() {
    console.log('随手公益页面加载');
    
    // 加载本地设置
    const seniorMode = wx.getStorageSync('seniorMode') || false;
    const vibrationEnabled = wx.getStorageSync('vibrationEnabled') !== false;
    
    this.setData({ 
      seniorMode,
      vibrationEnabled
    });
    
    // 初始化页面
    this.initPage();
  },

  onShow() {
    console.log('随手公益页面显示');
    
    // 页面显示时重新检查登录状态
    this.checkLoginStatus();
  },

  // 初始化页面
  initPage() {
    this.checkLoginStatus();
  },

  // 检查登录状态（修正版）
  checkLoginStatus() {
    const token = wx.getStorageSync('access_token');
    const userInfo = wx.getStorageSync('userInfo');
    const isLoggedInStorage = wx.getStorageSync('isLoggedIn');
    
    console.log('登录检查详细信息:');
    console.log('1. token存在:', !!token);
    console.log('2. token值:', token ? token.substring(0, 20) + '...' : '无token');
    console.log('3. userInfo存在:', !!userInfo);
    console.log('4. userInfo内容:', userInfo);
    console.log('5. isLoggedInStorage:', isLoggedInStorage);
    
    // 使用更宽松的检查：只要有userInfo和token就认为是已登录
    const isLoggedIn = !!(userInfo && token);
    
    console.log('最终登录状态判断:', isLoggedIn);
    
    if (isLoggedIn) {
      this.setData({ 
        isLoggedIn: true,
        userInfo: userInfo
      });
      
      // 加载数据
      this.loadTodayPoints();
      this.loadQuickRecords();
      
      return true;
    } else {
      this.setData({ 
        isLoggedIn: false,
        userInfo: null
      });
      
      // 未登录，显示登录提示 - 使用统一弹窗方法
      setTimeout(() => {
        if (!this.data.isLoggedIn) {
          app.showLoginRegisterModal('使用随手公益功能');
        }
      }, 500);
      
      return false;
    }
  },

  // 返回上一页
  goBack() {
    this.vibrateFeedback('light');
    
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({
        url: '/pages/index/index'
      });
    }
  },

  // 切换显示模式
  switchDisplayMode() {
    this.vibrateFeedback('medium');
    
    const newMode = !this.data.seniorMode;
    
    this.setData({ seniorMode: newMode });
    wx.setStorageSync('seniorMode', newMode);
    
    wx.showToast({
      title: `已切换到${newMode ? '老年版' : '普通版'}`,
      icon: 'success',
      duration: 1500,
      mask: true
    });
  },

  // 加载今日积分（对接真实API）
  loadTodayPoints() {
    if (!this.data.isLoggedIn || !this.data.userInfo) return;
    
    const that = this;
    const token = wx.getStorageSync('access_token');
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/quick_actions.php?action=stats',
      method: 'GET',
      header: {
        'Authorization': `Bearer ${token}`
      },
      success(res) {
        console.log('今日积分响应:', res.data);
        
        if (res.data && res.data.code === 0) {
          const data = res.data.data;
          const todayPoints = data.today_points || 0;
          const maxPointsPerDay = data.max_daily_points || 5;
          const percent = (todayPoints / maxPointsPerDay) * 100;
          
          that.setData({
            todayPoints: todayPoints,
            maxPointsPerDay: maxPointsPerDay,
            progressPercent: percent > 100 ? 100 : Math.round(percent)
          });
        } else {
          console.log('获取今日积分失败:', res.data?.msg);
          that.showErrorToast(res.data?.msg || '获取积分失败');
        }
      },
      fail(err) {
        console.error('获取今日积分请求失败:', err);
        that.showErrorToast('网络请求失败');
      }
    });
  },

  // 加载随手公益记录（对接真实API）
  loadQuickRecords(page = 1, isLoadMore = false) {
    if (!this.data.isLoggedIn || !this.data.userInfo) return;
    
    const that = this;
    const token = wx.getStorageSync('access_token');
    
    this.setData({ loading: true });
    
    wx.request({
      url: `https://api.jhzyfw.com/api/quick_actions.php?action=list&page=${page}&limit=${this.data.pageSize}`,
      method: 'GET',
      header: {
        'Authorization': `Bearer ${token}`
      },
      success(res) {
        console.log('随手公益记录响应:', res.data);
        
        if (res.data && res.data.code === 0) {
          const data = res.data.data;
          const records = data.records || [];
          const pagination = data.pagination || {};
          
          // 格式化记录
          const formattedRecords = records.map(record => ({
            id: record.id,
            action_name: record.title || record.type || '公益行为',
            description: record.description || '',
            create_time: record.created_at,
            points: record.points || 1,
            status: record.status == 1 ? 'approved' : record.status == 0 ? 'pending' : 'rejected',
            status_text: record.status === 1 ? '已通过' : record.status === 0 ? '审核中' : '已拒绝',
            type: record.type,
            location: record.location || '未记录位置',
            images: record.images || ''
          }));
          
          const hasMore = pagination.page < pagination.pages;
          
          if (isLoadMore) {
            that.setData({
              quickRecords: that.data.quickRecords.concat(formattedRecords),
              page: page,
              hasMore: hasMore,
              loading: false
            });
          } else {
            that.setData({
              quickRecords: formattedRecords,
              page: 1,
              hasMore: hasMore,
              loading: false
            });
          }
        } else {
          console.log('获取记录失败:', res.data?.msg);
          that.showErrorToast(res.data?.msg || '获取记录失败');
          that.setData({ loading: false });
        }
      },
      fail(err) {
        console.error('获取记录请求失败:', err);
        that.showErrorToast('网络请求失败');
        that.setData({ loading: false });
      }
    });
  },

  // 开始记录公益行为
  startAction(e) {
    this.vibrateFeedback('medium');
    
    // 检查登录
    if (!this.data.isLoggedIn) {
      // 使用统一的弹窗方法
      app.showLoginRegisterModal('记录公益行为');
      return;
    }
    
    // 检查今日积分是否已达上限
    if (this.data.todayPoints >= this.data.maxPointsPerDay) {
      wx.showModal({
        title: '今日积分已达上限',
        content: `今日已获得${this.data.todayPoints}积分（上限${this.data.maxPointsPerDay}积分）`,
        showCancel: false,
        confirmText: '知道了',
        confirmColor: '#1677ff'
      });
      return;
    }
    
    const actionType = e.currentTarget.dataset.type;
    const action = this.data.actions.find(item => item.type === actionType);
    
    if (!action) return;
    
    // 自动获取位置
    this.getLocation();
    
    this.setData({
      showCameraModal: true,
      currentAction: action,
      photoPath: '',
      actionDescription: '',
      descriptionLength: 0,
      location: null,
      locationName: ''
    });
  },

  // 获取当前位置
  getLocation() {
    this.vibrateFeedback('light');
    
    this.setData({ isGettingLocation: true });
    
    wx.getLocation({
      type: 'gcj02',
      altitude: true,
      success: (res) => {
        console.log('获取位置成功:', res);
        
        // 获取详细地址信息
        wx.request({
          url: `https://apis.map.qq.com/ws/geocoder/v1/?location=${res.latitude},${res.longitude}&key=6AXBZ-BS5LN-BA7F3-SDEHY-D7GR2-RZBXT`,
          success: (geoRes) => {
            const locationData = {
              latitude: res.latitude,
              longitude: res.longitude,
              speed: res.speed,
              accuracy: res.accuracy,
              altitude: res.altitude,
              address: geoRes.data?.result?.address || '',
              formatted_addresses: geoRes.data?.result?.formatted_addresses || {},
              address_component: geoRes.data?.result?.address_component || {}
            };
            
            let locationName = '';
            if (geoRes.data?.result?.formatted_addresses?.recommend) {
              locationName = geoRes.data.result.formatted_addresses.recommend;
            } else if (geoRes.data?.result?.address) {
              locationName = geoRes.data.result.address;
            } else {
              locationName = '当前位置';
            }
            
            this.setData({
              location: locationData,
              locationName: locationName,
              isGettingLocation: false
            });
            
            wx.showToast({
              title: '位置获取成功',
              icon: 'success',
              duration: 1500
            });
          },
          fail: (geoErr) => {
            console.error('逆地理编码失败:', geoErr);
            // 如果逆地理编码失败，至少保存坐标信息
            const locationData = {
              latitude: res.latitude,
              longitude: res.longitude,
              speed: res.speed,
              accuracy: res.accuracy,
              altitude: res.altitude
            };
            
            this.setData({
              location: locationData,
              locationName: `纬度: ${res.latitude.toFixed(6)}, 经度: ${res.longitude.toFixed(6)}`,
              isGettingLocation: false
            });
            
            wx.showToast({
              title: '获取坐标成功',
              icon: 'success',
              duration: 1500
            });
          }
        });
      },
      fail: (err) => {
        console.error('获取位置失败:', err);
        this.setData({ isGettingLocation: false });
        
        wx.showModal({
          title: '获取位置失败',
          content: '请授权位置权限，或手动输入位置信息',
          showCancel: false,
          confirmText: '确定'
        });
      }
    });
  },

  // 打开手动位置输入
  openLocationPicker() {
    this.vibrateFeedback('light');
    
    wx.showModal({
      title: '手动输入位置',
      content: '请输入大致位置信息',
      editable: true,
      placeholderText: '例如：xx小区门口、xx路xx号附近',
      success: (res) => {
        if (res.confirm && res.content) {
          this.setData({
            location: { name: res.content },
            locationName: res.content
          });
          
          wx.showToast({
            title: '位置已设置',
            icon: 'success',
            duration: 1500
          });
        }
      }
    });
  },

  // 打开相机/选择照片
  openCamera() {
    this.vibrateFeedback('light');
    
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.takePhoto();
        } else {
          this.choosePhoto();
        }
      }
    });
  },

  // 拍照
  takePhoto() {
    const that = this;
    
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera'],
      camera: 'back',
      success(res) {
        const tempFilePath = res.tempFiles[0].tempFilePath;
        that.setData({
          photoPath: tempFilePath
        });
        
        wx.showToast({
          title: '照片已保存',
          icon: 'success',
          duration: 1500
        });
      },
      fail(err) {
        console.error('拍照失败:', err);
        wx.showToast({
          title: '拍照失败，请重试',
          icon: 'error'
        });
      }
    });
  },

  // 从相册选择
  choosePhoto() {
    const that = this;
    
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album'],
      success(res) {
        const tempFilePath = res.tempFiles[0].tempFilePath;
        that.setData({
          photoPath: tempFilePath
        });
        
        wx.showToast({
          title: '照片已选择',
          icon: 'success',
          duration: 1500
        });
      },
      fail(err) {
        console.error('选择照片失败:', err);
        wx.showToast({
          title: '选择照片失败',
          icon: 'error'
        });
      }
    });
  },

  // 重拍照片
  retakePhoto() {
    this.vibrateFeedback('light');
    this.openCamera();
  },

  // 关闭拍照弹窗
  closeCameraModal() {
    this.vibrateFeedback('light');
    this.setData({
      showCameraModal: false,
      currentAction: {},
      photoPath: '',
      actionDescription: '',
      descriptionLength: 0,
      location: null,
      locationName: ''
    });
  },

  // 描述输入
  onDescriptionInput(e) {
    const value = e.detail.value;
    this.setData({
      actionDescription: value,
      descriptionLength: value.length
    });
  },

  // 上传图片到服务器（真实上传逻辑）
  uploadImage(filePath) {
    return new Promise((resolve, reject) => {
      const token = wx.getStorageSync('access_token');
      
      // 使用微信上传文件API，调用新的简单上传接口
      wx.uploadFile({
        url: 'https://api.jhzyfw.com/api/upload_quick_action.php',
        filePath: filePath,
        name: 'file',
        formData: {
          type: 'quick_action'
        },
        header: {
          'Authorization': `Bearer ${token}`
        },
        success(res) {
          try {
            const data = JSON.parse(res.data);
            if (data.code === 0) {
              const fileInfo = data.data;
              // 使用完整的URL
              resolve(fileInfo.full_url);
            } else {
              reject(new Error(data.msg || '上传失败'));
            }
          } catch (error) {
            console.error('上传响应解析失败:', error, res.data);
            reject(new Error('上传响应解析失败'));
          }
        },
        fail(err) {
          console.error('上传请求失败:', err);
          reject(new Error('上传请求失败'));
        }
      });
    });
  },

  // 提交记录（对接真实API）
  async submitAction() {
    this.vibrateFeedback('medium');
    
    // 检查登录
    if (!this.data.isLoggedIn) {
      // 使用统一的弹窗方法
      app.showLoginRegisterModal('提交记录');
      return;
    }
    
    // 表单验证
    if (!this.data.photoPath) {
      wx.showToast({
        title: '请上传照片凭证',
        icon: 'none',
        duration: 2000
      });
      return;
    }
    
    if (this.data.descriptionLength < 10) {
      wx.showToast({
        title: '请至少输入10个字的描述',
        icon: 'none',
        duration: 2000
      });
      return;
    }
    
    if (!this.data.location) {
      wx.showToast({
        title: '请获取或输入位置信息',
        icon: 'none',
        duration: 2000
      });
      return;
    }
    
    const that = this;
    
    wx.showLoading({
      title: '提交中...',
      mask: true
    });
    
    try {
      // 1. 上传图片到服务器
      const imageUrl = await this.uploadImage(this.data.photoPath);
      console.log('图片上传成功:', imageUrl);
      
      // 2. 构建位置信息字符串
      let locationStr = '';
      if (this.data.location.address) {
        locationStr = this.data.location.address;
      } else if (this.data.locationName) {
        locationStr = this.data.locationName;
      } else if (this.data.location.latitude && this.data.location.longitude) {
        locationStr = `纬度: ${this.data.location.latitude.toFixed(6)}, 经度: ${this.data.location.longitude.toFixed(6)}`;
      } else if (this.data.location.name) {
        locationStr = this.data.location.name;
      } else {
        locationStr = '位置信息';
      }
      
      // 3. 构建提交数据
      const submitData = {
        type: this.data.currentAction.type,
        title: this.data.currentAction.name,
        description: this.data.actionDescription,
        images: imageUrl,
        location: locationStr,
        points: this.data.currentAction.points
      };
      
      console.log('提交数据:', submitData);
      
      // 4. 调用后端API - 使用新的统一API
      const token = wx.getStorageSync('access_token');
      
      wx.request({
        url: 'https://api.jhzyfw.com/api/quick_actions.php?action=submit',
        method: 'POST',
        header: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        data: submitData,
        success(res) {
          wx.hideLoading();
          console.log('提交响应:', res.data);
          
          if (res.data && res.data.code === 0) {
            // 提交成功
            const resultData = res.data.data;
            
            // 刷新数据
            that.loadTodayPoints();
            that.loadQuickRecords();
            
            // 重置表单
            that.setData({
              showCameraModal: false,
              currentAction: {},
              photoPath: '',
              actionDescription: '',
              descriptionLength: 0,
              location: null,
              locationName: ''
            });
            
            // 显示成功提示
            wx.showModal({
              title: '记录提交成功',
              content: `你完成了"${that.data.currentAction.name}"\n提交成功，等待审核\n审核通过后将获得${that.data.currentAction.points}积分`,
              showCancel: false,
              confirmText: '继续做公益',
              confirmColor: '#1677ff',
              success: () => {
                that.vibrateFeedback('heavy');
              }
            });
            
          } else {
            // 提交失败
            let errorMsg = '提交失败，请重试';
            if (res.data) {
              if (res.data.message?.includes('已达上限')) {
                errorMsg = res.data.message;
              } else if (res.data.code === 400) {
                errorMsg = res.data.message || '提交失败';
              } else {
                errorMsg = res.data.message || '提交失败';
              }
            }
            
            wx.showModal({
              title: '提交失败',
              content: errorMsg,
              showCancel: false,
              confirmText: '知道了'
            });
          }
        },
        fail(err) {
          wx.hideLoading();
          console.error('提交请求失败:', err);
          
          wx.showModal({
            title: '网络错误',
            content: '提交失败，请检查网络后重试',
            showCancel: false,
            confirmText: '知道了'
          });
        }
      });
      
    } catch (error) {
      wx.hideLoading();
      console.error('提交过程出错:', error);
      wx.showToast({
        title: error.message || '图片上传失败',
        icon: 'none',
        duration: 2000
      });
    }
  },

  // 加载更多记录
  loadMoreRecords() {
    if (!this.data.hasMore || this.data.loading) return;
    
    const nextPage = this.data.page + 1;
    this.loadQuickRecords(nextPage, true);
  },

  // 上拉加载更多
  onReachBottom() {
    console.log('加载更多记录');
    this.loadMoreRecords();
  },

  // 下拉刷新
  onPullDownRefresh() {
    if (!this.data.isLoggedIn) {
      wx.stopPullDownRefresh();
      return;
    }
    
    // 并行加载数据
    Promise.all([
      new Promise(resolve => {
        this.loadTodayPoints();
        setTimeout(resolve, 300);
      }),
      new Promise(resolve => {
        this.loadQuickRecords();
        setTimeout(resolve, 300);
      })
    ]).then(() => {
      wx.stopPullDownRefresh();
      wx.showToast({
        title: '刷新成功',
        icon: 'success',
        duration: 1500
      });
    }).catch(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 震动反馈
  vibrateFeedback(type = 'medium') {
    if (!this.data.vibrationEnabled) return;
    
    if (!wx.vibrateShort) return;
    
    try {
      switch(type) {
        case 'light':
          wx.vibrateShort({ type: 'light' });
          break;
        case 'medium':
          wx.vibrateShort();
          break;
        case 'heavy':
          wx.vibrateShort({ type: 'heavy' });
          break;
        default:
          wx.vibrateShort();
      }
    } catch (err) {
      console.log('震动反馈失败:', err);
    }
  },

  // 显示错误提示
  showErrorToast(message) {
    wx.showToast({
      title: message,
      icon: 'none',
      duration: 2000
    });
  },

  // 分享功能
  onShareAppMessage() {
    const shareTitle = this.data.todayPoints > 0 
      ? `我今天做了${this.data.todayPoints}分公益，一起让世界更美好！`
      : '随手做公益，让爱传递，让世界更温暖';
    
    return {
      title: shareTitle,
      path: 'pages/quick-action/quick-action',
      imageUrl: '/images/share-quick-action.jpg'
    };
  },

  // 分享到朋友圈
  onShareTimeline() {
    return {
      title: '随手公益 | 点滴善意，汇聚大爱',
      query: `id=${this.data.activityId}`,
      imageUrl: '/images/share-quick-action.jpg'
    };
  },

  // 错误处理
  onError(error) {
    console.error('页面发生错误:', error);
    
    wx.showToast({
      title: '页面加载失败',
      icon: 'error',
      duration: 2000
    });
  },
  
  // 格式化时间
  formatTime(timeString) {
    if (!timeString) return '';
    try {
      const time = new Date(timeString);
      const now = new Date();
      const diff = now - time;
      
      // 如果是今天，显示时间
      if (time.toDateString() === now.toDateString()) {
        return `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
      }
      // 如果是昨天
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      if (time.toDateString() === yesterday.toDateString()) {
        return '昨天';
      }
      // 其他情况显示日期
      return `${time.getMonth() + 1}月${time.getDate()}日`;
    } catch (e) {
      return timeString;
    }
  }
});