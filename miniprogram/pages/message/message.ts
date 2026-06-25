Page({
  data: {
    notifications: [],
    page: 1,
    limit: 20,
    hasMore: true,
    loading: false,
    userId: null
  },

  onLoad() {
    this.getUserId()
  },

  onShow() {
    // 每次显示时刷新列表
    if (this.data.userId) {
      this.setData({ notifications: [], page: 1, hasMore: true })
      this.loadNotifications()
    }
  },

  onUnload() {
    // 页面卸载时刷新个人页面的未读数量
    const pages = getCurrentPages();
    const minePage = pages.find(p => p.route === 'pages/mine/mine');
    if (minePage && minePage.loadUnreadCount) {
      minePage.loadUnreadCount();
    }
  },

  getUserId() {
    const userInfo = wx.getStorageSync('userInfo')
    const userId = userInfo?.id || userInfo?.user_id
    if (userId) {
      this.setData({ userId })
      this.loadNotifications()
    } else {
      wx.showToast({ title: '请先登录', icon: 'none' })
    }
  },

  loadNotifications() {
    if (this.data.loading || !this.data.hasMore) return
    
    this.setData({ loading: true })
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/get_notifications.php',
      data: {
        user_id: this.data.userId,
        page: this.data.page,
        limit: this.data.limit
      },
      success: (res) => {
        if (res.data.success) {
          const newList = res.data.data
          this.setData({
            notifications: [...this.data.notifications, ...newList],
            hasMore: newList.length === this.data.limit,
            page: this.data.page + 1
          })
        }
      },
      complete: () => {
        this.setData({ loading: false })
      }
    })
  },

  onReachBottom() {
    this.loadNotifications()
  },

  markAsRead(e) {
    const id = e.currentTarget.dataset.id
    const index = e.currentTarget.dataset.index
    const item = this.data.notifications[index]
    
    // 如果已经已读，不再请求
    if (item.is_read === 1) {
      return
    }
    
    const that = this
    wx.request({
      url: 'https://api.jhzyfw.com/api/mark_notification_read.php',
      method: 'POST',
      data: {
        notification_id: id,
        user_id: this.data.userId
      },
      success: () => {
        // 更新本地列表
        const list = that.data.notifications
        list[index].is_read = 1
        that.setData({ notifications: list })
        
        // 通知个人页面重新加载未读数量
        const pages = getCurrentPages();
        const minePage = pages.find(p => p.route === 'pages/mine/mine');
        if (minePage && minePage.loadUnreadCount) {
          minePage.loadUnreadCount();
        }
        
        wx.showToast({ title: '已标记为已读', icon: 'success', duration: 1000 })
      },
      fail: () => {
        wx.showToast({ title: '操作失败', icon: 'none' })
      }
    })
  }
})