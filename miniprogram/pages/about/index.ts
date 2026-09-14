// pages/about/index.ts
Page({
  callHotline() {
    wx.makePhoneCall({
      phoneNumber: '0573-82099982',
      fail() {
        // 用户取消或不支持时静默忽略
      }
    });
  }
});
