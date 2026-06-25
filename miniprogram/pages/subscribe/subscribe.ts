// pages/subscribe/subscribe.js
Page({
  data: {
    templates: [
      { id: '_x9D2d6Ae7wuiewEp4XTPVsSd061O4lPaLreJdZQwM4', name: '报名结果提醒', key: 'signup' },
      { id: 'eu4viO-Ex0YqXnVfXsRAAPOIFsZc_AC7LsVVW4ug8Yw', name: '实名认证通知', key: 'certify' },
      { id: 'wQtwe8L7l-u6YFzMtHRbXNrXvZVRacbPGEZMgVTHMZ8', name: '活动变更通知', key: 'change' },
      { id: 'JRKyGhoWQ9XNxt7_bAQxMgj8IoJTgs4qiQKo2vqhBa8', name: '活动培训提醒', key: 'training' },
      { id: 'sGepFsMsjkIGL-ph7mjCNHb9aKG11sh89J55qB3bEok', name: '积分变动提醒', key: 'points' },
      { id: 'PcOdV5nYPj89BY-b_C5n1FNjmq7G9mqQQBlQU1pEE9A', name: '核销成功通知', key: 'verify' },
      { id: 'k6azwIXNr-D-u322U91vZXQet_MUtaLpqxtqDL6NG-A', name: '审核通过提醒', key: 'audit' },
      { id: 'SrFXViQy2FVmi34qEtJmcbMPOR_cqNHn74zo0eA4eSA', name: '活动开始通知', key: 'start' },
      { id: 'QVakhEJ7nDaB6seNZWBzPcn2HD4oL3Gdp8-VUw7UZTY', name: '签到提醒', key: 'checkin' },
      { id: 'Lx4Vpm2T7TTdzXjy2XJS8-Uc6jnxan7vNlewfJSmTqk', name: '预约通知', key: 'book' },
      { id: 'Pq6jAdefsEM5kRG6tFryCmA-ddWBwC8Gybe33DOpHFw', name: '新活动发布提醒', key: 'newActivity' }
    ],
    subscribed: {}
  },

  onLoad() {
    this.loadSubscribedStatus()
  },

  // 从服务器加载订阅状态
  loadSubscribedStatus() {
    const token = wx.getStorageSync('access_token')
    if (!token) {
      const subscribed = wx.getStorageSync('subscribe_templates') || {}
      this.setData({ subscribed })
      return
    }
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/get_subscribe_status.php',
      method: 'GET',
      header: { 'Authorization': `Bearer ${token}` },
      success: (res) => {
        if (res.data && res.data.success) {
          const serverSubscribed = res.data.subscribed || {}
          const localSubscribed = wx.getStorageSync('subscribe_templates') || {}
          // 合并：服务器数据优先，但保留本地新开启的
          const merged = { ...serverSubscribed, ...localSubscribed }
          this.setData({ subscribed: merged })
          wx.setStorageSync('subscribe_templates', merged)
        } else {
          const subscribed = wx.getStorageSync('subscribe_templates') || {}
          this.setData({ subscribed })
        }
      },
      fail: () => {
        const subscribed = wx.getStorageSync('subscribe_templates') || {}
        this.setData({ subscribed })
      }
    })
  },

  // 保存订阅状态到服务器
  saveSubscribedStatus() {
    const subscribed = this.data.subscribed
    wx.setStorageSync('subscribe_templates', subscribed)
    
    const token = wx.getStorageSync('access_token')
    if (token) {
      wx.request({
        url: 'https://api.jhzyfw.com/api/save_subscribe_status.php',
        method: 'POST',
        header: { 'Authorization': `Bearer ${token}` },
        data: { subscribed: subscribed },
        success: () => {
          console.log('订阅状态已同步到服务器')
        },
        fail: () => {
          console.log('同步失败，已保存到本地')
        }
      })
    }
  },

  onSwitchChange(e) {
    const key = e.currentTarget.dataset.key
    const templateId = e.currentTarget.dataset.id
    const isChecked = e.detail.value
    
    if (isChecked) {
      wx.requestSubscribeMessage({
        tmplIds: [templateId],
        success: (res) => {
          if (res[templateId] === 'accept') {
            const subscribed = this.data.subscribed
            subscribed[key] = true
            this.setData({ subscribed })
            this.saveSubscribedStatus()
            wx.showToast({ title: '订阅成功', icon: 'success' })
          } else {
            wx.showToast({ title: '您拒绝了订阅', icon: 'none' })
          }
        },
        fail: () => {
          wx.showToast({ title: '订阅失败', icon: 'none' })
        }
      })
    } else {
      const subscribed = this.data.subscribed
      delete subscribed[key]
      this.setData({ subscribed })
      this.saveSubscribedStatus()
      wx.showToast({ title: '已取消订阅', icon: 'success' })
    }
  }
})