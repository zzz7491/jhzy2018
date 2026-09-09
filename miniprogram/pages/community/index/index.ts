// pages/community/index/index.ts
// 公益社区临时一级导航占位页（Navigation Integration 阶段）
// 不调用任何 API，不实现 Feed / 发布 / 评论 / 点赞 / 举报 / 管理员功能
Page({
  data: {
    building: true
  },

  onLoad() {
    // 占位页：仅展示建设中说明，无业务逻辑
  },

  // 简单返回：回到首页 tab
  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
