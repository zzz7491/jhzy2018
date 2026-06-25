// trainings.ts
Page({
  data: {
    loading: true,
    hasExam: false,
    isPassed: false,
    certificate: null as any,
    examUrl: 'https://exam.jhzyfw.com/index.html'  // 考试网页地址
  },

  onLoad() {
    this.loadTrainingStatus();
  },

  // 获取用户培训状态
  loadTrainingStatus() {
    const userInfo = wx.getStorageSync('userInfo');
    const phone = userInfo?.phone;
    const name = userInfo?.real_name || userInfo?.username;

    if (!phone || !name) {
      wx.showToast({
        title: '请先登录',
        icon: 'none'
      });
      this.setData({ loading: false });
      return;
    }

    wx.request({
      url: 'https://exam.jhzyfw.com/api_get_training_status.php',
      method: 'GET',
      data: { 
        name: name,
        phone: phone 
      },
      success: (res: any) => {
        console.log('培训状态接口返回:', res.data);
        
        if (res.data && res.data.code === 0) {
          const data = res.data.data;
          
          if (data.has_exam) {
            if (data.is_passed) {
              this.setData({
                hasExam: true,
                isPassed: true,
                certificate: data.certificate,
                loading: false
              });
            } else {
              this.setData({
                hasExam: true,
                isPassed: false,
                loading: false
              });
            }
          } else {
            this.setData({
              hasExam: false,
              isPassed: false,
              loading: false
            });
          }
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

  // 去考试（先获取当前可用场次，再打开web-view）
  goToExam() {
    wx.showLoading({ title: '加载中...' });
    
    // 先获取当前可用的培训场次
    wx.request({
      url: 'https://exam.jhzyfw.com/api_get_active_session.php',
      method: 'GET',
      success: (res: any) => {
        wx.hideLoading();
        
        if (res.data && res.data.code === 0 && res.data.data) {
          const sessionId = res.data.data.session_id;
          // 加时间戳强制刷新，避免小程序 webview 缓存
          const timestamp = Date.now();
          const examUrl = `https://exam.jhzyfw.com/index.html?session_id=${sessionId}&t=${timestamp}`;
          wx.navigateTo({
            url: `/pages/webview/webview?url=${encodeURIComponent(examUrl)}`
          });
        } else {
          wx.showModal({
            title: '提示',
            content: res.data?.msg || '当前没有进行中的培训考试',
            showCancel: false,
            confirmText: '知道了'
          });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({
          title: '网络错误，请稍后重试',
          icon: 'none'
        });
      }
    });
  },

  // 查看证书 - 使用 wx.openDocument 直接打开PDF（更快）
  viewCertificate() {
    const cert = this.data.certificate;
    if (cert && cert.pdf_url) {
      const pdfUrl = `https://exam.jhzyfw.com${cert.pdf_url}`;
      
      wx.showLoading({ title: '加载中...' });
      
      wx.downloadFile({
        url: pdfUrl,
        success: (res) => {
          wx.hideLoading();
          if (res.statusCode === 200) {
            wx.openDocument({
              filePath: res.tempFilePath,
              success: () => {
                console.log('打开文档成功');
              },
              fail: (err) => {
                console.error('打开文档失败:', err);
                wx.showToast({
                  title: '打开失败',
                  icon: 'none'
                });
              }
            });
          } else {
            wx.hideLoading();
            wx.showToast({
              title: '加载失败',
              icon: 'none'
            });
          }
        },
        fail: (err) => {
          wx.hideLoading();
          console.error('下载失败:', err);
          wx.showToast({
            title: '网络错误',
            icon: 'none'
          });
        }
      });
    } else {
      wx.showToast({
        title: '证书暂不可用',
        icon: 'none'
      });
    }
  }
});