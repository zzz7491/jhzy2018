// pages/goods-detail/goods-detail.js
Page({
  data: {
    goodsId: '',
    goodsData: {
      id: 0,
      name: '',
      description: '',
      points_cost: 0,
      stock: 0,
      cover: '',
      source: '',
      create_time: '',
      status: 'available'
    },
    goodsImages: [],
    userPoints: 0,
    showExchangeModal: false,
    showSuccessModal: false,
    exchangeCode: '',
    successMessage: '',
    currentTime: '',
    exchangeRules: [
      '兑换后积分将立即扣除，不可退还',
      '实物商品需联系管理员领取，领取时间：工作日9:00-17:00',
      '电子商品兑换码将在兑换后立即显示，请及时保存',
      '兑换记录可在个人中心查看',
      '如有问题，请及时联系客服'
    ]
  },

  onLoad(options) {
    console.log('商品详情页面加载，参数:', options);
    
    if (options && options.id) {
      this.setData({
        goodsId: options.id
      });
      this.loadGoodsDetail(options.id);
    } else {
      wx.showToast({
        title: '参数错误',
        icon: 'error',
        duration: 2000
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
    }
    
    this.loadUserPoints();
  },

  onShow() {
    console.log('商品详情页面显示');
  },

  loadGoodsDetail(goodsId) {
    const that = this;
    
    wx.showLoading({
      title: '加载中...',
      mask: true
    });

    wx.request({
      url: 'https://api.jhzyfw.com/api/get_goods_detail.php',
      data: {
        id: goodsId
      },
      method: 'GET',
      success: function(res) {
        wx.hideLoading();
        console.log('商品详情API响应:', res.data);
        
        if (res.data.code === 0 && res.data.data) {
          let goodsData = res.data.data;
          
          // 如果返回的数据是products格式（列表接口的单个商品）
          if (goodsData.products && Array.isArray(goodsData.products) && goodsData.products.length > 0) {
            goodsData = goodsData.products[0];
          }
          
          // 格式化商品数据
          const formattedData = {
            id: goodsData.product_id || goodsData.id || 0,
            name: goodsData.product_name || goodsData.name || '未知商品',
            description: goodsData.description || '暂无描述',
            points_cost: goodsData.points_required || goodsData.points_cost || 0,
            stock: goodsData.stock || 0,
            cover: goodsData.image_url || goodsData.cover || '',
            source: goodsData.source || '',
            create_time: goodsData.created_at || goodsData.create_time || '',
            status: goodsData.status || 'available',
            type: goodsData.type || 'service'
          };

          // 构建图片数组 - 修复图片URL问题
          const images = [];
          let imageUrl = '';

          console.log('原始cover数据:', formattedData.cover);
          console.log('完整商品数据:', goodsData);
          console.log('cover类型:', typeof formattedData.cover);

          if (formattedData.cover) {
            // 先处理可能的转义字符
            let processedCover = formattedData.cover;
            
            // 如果是字符串，替换转义的正斜杠
            if (typeof processedCover === 'string') {
              // 替换JSON转义的正斜杠
              processedCover = processedCover.replace(/\\\//g, '/');
              console.log('处理后的cover:', processedCover);
            }
            
            // 检查是否已经是完整URL
            if (processedCover.startsWith('http')) {
              imageUrl = processedCover;
            } else if (processedCover.startsWith('/')) {
              // 相对路径，添加域名
              imageUrl = 'https://api.jhzyfw.com' + processedCover;
            } else {
              // 其他情况
              imageUrl = 'https://api.jhzyfw.com/' + processedCover;
            }
            
            console.log('最终图片URL:', imageUrl);
            images.push(imageUrl);
          } else {
            console.log('没有cover数据，使用默认图片');
            images.push('/images/default-goods.png');
          }

          that.setData({
            goodsData: formattedData,
            goodsImages: images
          });

          console.log('商品详情加载成功，图片URL:', images);
        } else {
          wx.showToast({
            title: res.data.msg || '加载失败',
            icon: 'error',
            duration: 2000
          });
          setTimeout(() => {
            wx.navigateBack();
          }, 1500);
        }
      },
      fail: function(err) {
        wx.hideLoading();
        console.error('请求商品详情失败:', err);
        wx.showToast({
          title: '网络错误',
          icon: 'error',
          duration: 2000
        });
      }
    });
  },

  loadUserPoints() {
    const that = this;
    
    // 先检查本地存储的用户积分
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo && userInfo.current_points !== undefined) {
      that.setData({
        userPoints: userInfo.current_points || 0
      });
      return;
    }
    
    // 如果没有本地积分信息，从API获取
    const token = wx.getStorageSync('access_token');
    if (!token) {
      return;
    }

    wx.request({
      url: 'https://api.jhzyfw.com/api/points.php',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      data: {},
      success: function(res) {
        if (res.data.code === 0 && res.data.data) {
          const points = res.data.data.points || 0;
          that.setData({
            userPoints: points
          });
          
          // 更新本地用户信息中的积分
          const userInfo = wx.getStorageSync('userInfo');
          if (userInfo) {
            userInfo.current_points = points;
            wx.setStorageSync('userInfo', userInfo);
          }
        }
      },
      fail: function(err) {
        console.error('加载用户积分失败:', err);
      }
    });
  },

  // 预览图片
  previewImage(e) {
    const index = e.currentTarget.dataset.index;
    if (this.data.goodsImages.length > 0) {
      wx.previewImage({
        current: this.data.goodsImages[index],
        urls: this.data.goodsImages
      });
    }
  },

  // 兑换商品
  exchangeGoods() {
    // 检查登录状态
    const token = wx.getStorageSync('access_token');
    const userInfo = wx.getStorageSync('userInfo');
    
    if (!token || !userInfo) {
      wx.showToast({
        title: '请先登录',
        icon: 'error',
        duration: 1500
      });
      setTimeout(() => {
        wx.navigateTo({
          url: '/pages/profile/login/login'
        });
      }, 1500);
      return;
    }
    
    // 检查库存
    if (this.data.goodsData.stock <= 0) {
      wx.showToast({
        title: '商品已兑完',
        icon: 'error',
        duration: 2000
      });
      return;
    }
    
    // 检查积分是否足够
    if (this.data.userPoints < this.data.goodsData.points_cost) {
      wx.showToast({
        title: '积分不足',
        icon: 'error',
        duration: 2000
      });
      return;
    }
    
    this.setData({
      showExchangeModal: true
    });
  },

  // 关闭兑换确认弹窗
  closeExchangeModal() {
    this.setData({
      showExchangeModal: false
    });
  },

  // 确认兑换（修复版）
  confirmExchange() {
    const that = this;
    const goodsId = this.data.goodsId;
    const token = wx.getStorageSync('access_token');
    const userInfo = wx.getStorageSync('userInfo');
    
    if (!token || !userInfo) {
      wx.showToast({
        title: '请先登录',
        icon: 'error',
        duration: 2000
      });
      return;
    }
    
    wx.showLoading({
      title: '兑换中...',
      mask: true
    });

    // 使用兑换接口
    wx.request({
      url: 'https://api.jhzyfw.com/api/exchange.php',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      data: {
        goods_id: goodsId
        // 不传 user_id，后端从 token 获取
      },
      success: function(res) {
        wx.hideLoading();
        console.log('兑换API响应:', res.data);
        
        if (res.data.code === 200) {
          // 兑换成功
          const newPoints = that.data.userPoints - that.data.goodsData.points_cost;
          const now = new Date();
          
          // 更新用户积分
          if (userInfo) {
            userInfo.current_points = newPoints;
            wx.setStorageSync('userInfo', userInfo);
          }
          
          // 更新库存
          const newStock = Math.max(0, that.data.goodsData.stock - 1);
          
          that.setData({
            userPoints: newPoints,
            'goodsData.stock': newStock,
            showExchangeModal: false,
            showSuccessModal: true,
            exchangeCode: res.data.data?.exchange_code || '无兑换码',
            successMessage: res.data.data?.message || res.data.message || '兑换成功！请凭兑换码联系管理员领取物品',
            currentTime: now.toISOString()
          });
          
          // 显示成功提示
          wx.showToast({
            title: '兑换成功',
            icon: 'success',
            duration: 2000
          });
        } else {
          // 修复：正确获取后端返回的错误信息
          const errorMsg = res.data.message || res.data.msg || '兑换失败，请稍后重试';
          wx.showToast({
            title: errorMsg,
            icon: 'none',
            duration: 3000
          });
        }
      },
      fail: function(err) {
        wx.hideLoading();
        console.error('兑换请求失败:', err);
        wx.showToast({
          title: '网络错误，请重试',
          icon: 'error',
          duration: 2000
        });
      }
    });
  },

  // 关闭成功弹窗
  closeSuccessModal() {
    this.setData({
      showSuccessModal: false
    });
  },

  // 复制兑换码
  copyExchangeCode() {
    wx.setClipboardData({
      data: this.data.exchangeCode,
      success: function() {
        wx.showToast({
          title: '复制成功',
          icon: 'success'
        });
      }
    });
  },

  // 查看兑换记录
  viewExchangeRecords() {
    this.closeSuccessModal();
    wx.navigateTo({
      url: '/pages/exchange-records/exchange-records'
    });
  },

  // 查看积分明细
  viewPointsDetail() {
    wx.navigateTo({
      url: '/pages/points/points'
    });
  },

  // 联系客服
  contactService() {
    wx.showModal({
      title: '联系客服',
      content: '客服电话：18072213357\n服务时间：工作日9:00-17:00\n或前往嘉兴市嘉禾志愿服务中心咨询',
      showCancel: false,
      confirmText: '我知道了',
      confirmColor: '#07c160'
    });
  },

  // 格式化时间
  formatTime(timeString) {
    if (!timeString) return '';
    const date = new Date(timeString);
    return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  },

  // 分享功能
  onShareAppMessage() {
    return {
      title: `嘉禾志愿 - ${this.data.goodsData.name}`,
      path: `/pages/goods-detail/goods-detail?id=${this.data.goodsId}`,
      imageUrl: this.data.goodsImages.length > 0 ? this.data.goodsImages[0] : ''
    };
  },

  onShareTimeline() {
    return {
      title: `嘉禾志愿 - ${this.data.goodsData.name}`,
      query: `id=${this.data.goodsId}`
    };
  }
});