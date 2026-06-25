Page({
  data: {
    certificate: null,
    loading: true,
    id: null
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ id: options.id });
      this.loadDetail(options.id);
    }
  },

  loadDetail(id) {
    const token = wx.getStorageSync('access_token') || wx.getStorageSync('token');
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/certificate_detail.php?token=' + token + '&id=' + id,
      method: 'GET',
      success: (res) => {
        if (res.data && res.data.code === 0) {
          this.setData({
            certificate: res.data.data,
            loading: false
          });
        } else {
          wx.showToast({
            title: res.data?.msg || '加载失败',
            icon: 'none'
          });
          setTimeout(() => {
            wx.navigateBack();
          }, 1500);
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

  // 预览PDF（强化装甲版）
  previewPDF() {
    let pdfUrl = this.data.certificate?.pdf_url || this.data.certificate?.certificate_url;
    
    if (!pdfUrl) {
      wx.showToast({
        title: '暂无证书文件',
        icon: 'none'
      });
      return;
    }
    
    // 1. 修复可能存在的相对路径或不规范路径
    if (pdfUrl.startsWith('/')) {
      pdfUrl = 'https://api.jhzyfw.com' + pdfUrl;
    } else if (!pdfUrl.startsWith('http')) {
      pdfUrl = 'https://api.jhzyfw.com/' + pdfUrl;
    }
    // 强制使用 https
    pdfUrl = pdfUrl.replace(/^http:/, 'https:');
    
    wx.showLoading({ title: '获取证书中...' });
    
    wx.downloadFile({
      url: pdfUrl,
      success: (res) => {
        wx.hideLoading();
        // 2. 检查下载状态
        if (res.statusCode === 200) {
          wx.openDocument({
            filePath: res.tempFilePath,
            fileType: 'pdf', // 【关键补丁】：强制告诉微信这是PDF，防止因为假文件崩溃
            showMenu: true,  // 允许用户转发或保存
            success: () => {
              console.log('打开文档成功');
            },
            fail: (err) => {
              console.error('打开文档失败:', err);
              // 【人性化提示】：如果还是打不开，大概率是旧服务器遗失的文件
              wx.showModal({
                title: '无法打开',
                content: '这份早期的证书文件可能已在服务器迁移中遗失，或者文件已损坏。',
                showCancel: false
              });
            }
          });
        } else {
          wx.showToast({
            title: '证书不存在(404)',
            icon: 'error'
          });
        }
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('下载失败:', err);
        wx.showToast({
          title: '下载失败',
          icon: 'none'
        });
      }
    });
  },

  // 右上角分享
  onShareAppMessage() {
    const cert = this.data.certificate;
    return {
      title: cert?.certificate_name || cert?.activity_title || '我的志愿服务证书',
      path: 'pages/certificates/detail/detail?id=' + this.data.id,
      imageUrl: '/images/share-cert.png'
    };
  }
});