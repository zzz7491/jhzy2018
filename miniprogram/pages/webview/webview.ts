// pages/webview/webview.js
Page({
  data: {
    url: ''
  },

  onLoad(options) {
    let url = options.url;
    if (url) {
      // 解码URL
      url = decodeURIComponent(url);
      this.setData({ url });
    }
  },

  // 分享当前页面
  onShareAppMessage() {
    return {
      title: '培训考试',
      path: 'pages/webview/webview'
    };
  }
});