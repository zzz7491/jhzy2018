// pages/help/help.js
Page({
  data: {
    // FAQ展开状态
    faqOpen: [false, false, false, false, false]
  },

  onLoad() {
    console.log('帮助中心页面加载');
  },

  onShow() {
    console.log('帮助中心页面显示');
  },

  // 返回上一页
  goBack() {
    wx.navigateBack();
  },

  // 切换FAQ展开状态
  toggleFaq(e) {
    const index = parseInt(e.currentTarget.dataset.index);
    const newFaqOpen = [...this.data.faqOpen];
    newFaqOpen[index] = !newFaqOpen[index];
    
    this.setData({
      faqOpen: newFaqOpen
    });
  },

  // 跳转到意见反馈
  goToFeedback() {
    wx.navigateTo({
      url: '/pages/feedback/feedback'
    });
  },

  // 拨打电话
  callPhone() {
    const phone = '0573-82099982';
    wx.makePhoneCall({
      phoneNumber: phone
    });
  },

  // 复制邮箱
  copyEmail() {
    const email = 'service@jhzyfw.com';
    wx.setClipboardData({
      data: email,
      success: () => {
        wx.showToast({
          title: '邮箱已复制',
          icon: 'success',
          duration: 1500
        });
      }
    });
  }
});