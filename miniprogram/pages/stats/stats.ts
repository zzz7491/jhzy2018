// stats.ts
Page({
  data: {
    loading: true,
    statsData: null,
    currentYear: new Date().getFullYear(),
    yearRange: [],
    selectedYear: new Date().getFullYear(),
    chartData: {},
    achievedCount: 0,
    maxHours: 0,
    userInfo: null
  },

  onLoad() {
    this.generateYearRange();
    this.loadStats();
    // 获取用户信息
    const userInfo = wx.getStorageSync('userInfo');
    this.setData({ userInfo });
  },

  generateYearRange() {
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let i = 0; i < 5; i++) {
      years.push(currentYear - i);
    }
    this.setData({ yearRange: years });
  },

  onYearChange(e) {
    const year = e.currentTarget.dataset.year;
    this.setData({ selectedYear: year, loading: true });
    this.loadStats(year);
  },

  loadStats(year = this.data.selectedYear) {
    const token = wx.getStorageSync('access_token');
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/user_stats.php',
      method: 'GET',
      data: { year: year, token: token },
      success: (res) => {
        if (res.data && res.data.code === 0) {
          const stats = res.data.data;
          const achievedCount = stats.achievements ? stats.achievements.filter(a => a.achieved).length : 0;
          
          // 计算最大小时数用于进度条
          let maxHours = 0;
          if (stats.categoryStats && stats.categoryStats.length > 0) {
            maxHours = Math.max(...stats.categoryStats.map(item => item.hours || 0));
          }
          
          // 计算总活动次数
          const totalActivities = stats.chartData?.activities?.reduce((a, b) => a + b, 0) || 0;
          if (stats.basicStats) {
            stats.basicStats.totalActivities = totalActivities;
          }
          
          this.setData({
            statsData: stats,
            chartData: stats.chartData || {},
            achievedCount: achievedCount,
            maxHours: maxHours,
            loading: false
          });
        } else {
          wx.showToast({
            title: res.data?.msg || '加载失败',
            icon: 'none'
          });
          this.setData({ loading: false });
        }
      },
      fail: () => {
        wx.showToast({
          title: '网络错误',
          icon: 'none'
        });
        this.setData({ loading: false });
      }
    });
  },

  viewAchievementDetail(e) {
    const achievement = e.currentTarget.dataset.item;
    wx.showModal({
      title: achievement.name,
      content: achievement.desc + (achievement.achieved ? `\n获得日期：${achievement.date}` : '\n尚未达成'),
      showCancel: false
    });
  },

  // 分享功能
  shareStats() {
    wx.showActionSheet({
      itemList: ['生成分享海报', '分享给好友'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.generatePoster();
        } else if (res.tapIndex === 1) {
          this.shareToFriend();
        }
      }
    });
  },

  // 生成分享海报
  generatePoster() {
    wx.showLoading({ title: '生成海报中...' });
    
    // 创建画布上下文
    const query = wx.createSelectorQuery();
    query.select('#posterCanvas').node(res => {
      const canvas = res.node;
      const ctx = canvas.getContext('2d');
      
      // 设置画布尺寸
      const width = 300; // 单位：px
      const height = 500;
      canvas.width = width;
      canvas.height = height;
      
      // 绘制背景
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      
      // 绘制标题
      ctx.fillStyle = '#07c160';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText('我的服务报告', 20, 50);
      
      // 绘制年份
      ctx.fillStyle = '#666666';
      ctx.font = '14px sans-serif';
      ctx.fillText(this.data.selectedYear + '年度', 20, 80);
      
      // 绘制核心数据
      ctx.fillStyle = '#333333';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText('服务数据', 20, 120);
      
      const stats = this.data.statsData?.basicStats || {};
      const startY = 150;
      const colWidth = 100;
      
      ctx.font = '14px sans-serif';
      ctx.fillStyle = '#07c160';
      ctx.fillText('服务时长', 20, startY);
      ctx.fillStyle = '#333333';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText(stats.totalHours + '小时', 20, startY + 25);
      
      ctx.fillStyle = '#07c160';
      ctx.font = '14px sans-serif';
      ctx.fillText('累计积分', 20 + colWidth, startY);
      ctx.fillStyle = '#333333';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText(stats.totalPoints + '分', 20 + colWidth, startY + 25);
      
      ctx.fillStyle = '#07c160';
      ctx.font = '14px sans-serif';
      ctx.fillText('参与活动', 20 + colWidth * 2, startY);
      ctx.fillStyle = '#333333';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText((stats.totalActivities || '0') + '次', 20 + colWidth * 2, startY + 25);
      
      // 绘制分类数据
      ctx.fillStyle = '#333333';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText('服务分类', 20, 260);
      
      const categories = this.data.statsData?.categoryStats || [];
      let catY = 290;
      categories.slice(0, 5).forEach((cat, index) => {
        ctx.fillStyle = '#666666';
        ctx.font = '12px sans-serif';
        ctx.fillText(cat.name, 20, catY);
        
        ctx.fillStyle = '#07c160';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(cat.hours + '小时', 150, catY);
        
        catY += 25;
      });
      
      // 绘制成就
      if (this.data.achievedCount > 0) {
        ctx.fillStyle = '#333333';
        ctx.font = 'bold 16px sans-serif';
        ctx.fillText('已获成就', 20, catY + 20);
        
        ctx.fillStyle = '#f5a623';
        ctx.font = 'bold 24px sans-serif';
        ctx.fillText('🏆 x' + this.data.achievedCount, 20, catY + 55);
      }
      
      // 生成图片
      wx.canvasToTempFilePath({
        canvas: canvas,
        width: width,
        height: height,
        destWidth: width * 2,
        destHeight: height * 2,
        success: (res) => {
          wx.hideLoading();
          this.saveOrSharePoster(res.tempFilePath);
        },
        fail: (err) => {
          wx.hideLoading();
          wx.showToast({ title: '生成失败', icon: 'none' });
        }
      });
    }).exec();
  },

  // 保存或分享海报
  saveOrSharePoster(filePath) {
    wx.showActionSheet({
      itemList: ['保存到相册', '分享给好友'],
      success: (res) => {
        if (res.tapIndex === 0) {
          // 保存到相册
          wx.saveImageToPhotosAlbum({
            filePath: filePath,
            success: () => {
              wx.showToast({ title: '保存成功', icon: 'success' });
            },
            fail: () => {
              wx.showToast({ title: '保存失败', icon: 'none' });
            }
          });
        } else if (res.tapIndex === 1) {
          // 分享给好友
          this.sharePosterToFriend(filePath);
        }
      }
    });
  },

  // 分享给好友
  shareToFriend() {
    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage', 'shareTimeline']
    });
  },

  // 分享海报给好友
  sharePosterToFriend(filePath) {
    // 这里可以使用 wx.shareFileMessage 或引导用户先保存再分享
    wx.showModal({
      title: '提示',
      content: '请先保存海报到相册，然后通过微信发送给好友',
      success: (res) => {
        if (res.confirm) {
          wx.saveImageToPhotosAlbum({
            filePath: filePath,
            success: () => {
              wx.showToast({ title: '已保存到相册', icon: 'success' });
            }
          });
        }
      }
    });
  },

  // 页面分享配置
  onShareAppMessage() {
    return {
      title: '我的志愿服务报告',
      path: 'pages/stats/stats',
      imageUrl: '/images/share_default.png'
    };
  },

  onShareTimeline() {
    return {
      title: '我的志愿服务报告',
      query: ''
    };
  }
});