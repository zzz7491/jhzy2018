// 请求封装
const app = getApp();

const request = (options) => {
  return new Promise((resolve, reject) => {
    const baseUrl = 'https://api.jhzyfw.com/api/'
    const token = wx.getStorageSync('access_token') || wx.getStorageSync('token')
    
    // 检查 token 是否过期（如果有过期时间记录）
    const tokenExpire = wx.getStorageSync('token_expire')
    if (tokenExpire && new Date().getTime() > tokenExpire) {
      // token 已过期，清除登录状态
      wx.removeStorageSync('access_token')
      wx.removeStorageSync('token')
      wx.removeStorageSync('userInfo')
      wx.removeStorageSync('isLoggedIn')
      wx.removeStorageSync('token_expire')
      
      wx.showToast({
        title: '登录已过期',
        icon: 'none',
        duration: 1500,
        success: () => {
          setTimeout(() => {
            wx.redirectTo({
              url: '/pages/login-unified/index'
            })
          }, 1500)
        }
      })
      reject({ code: 401, msg: '登录已过期' })
      return
    }
    
    const header = {
      'Content-Type': 'application/json',
      ...options.header
    }
    
    if (token) {
      header['Authorization'] = `Bearer ${token}`
    }
    
    wx.request({
      url: baseUrl + options.url,
      method: options.method || 'GET',
      data: options.data,
      header: header,
      success: (res) => {
        // 处理 HTTP 状态码
        if (res.statusCode === 200) {
          // 检查业务状态码
          if (res.data && (res.data.code === -3 || res.data.code === 401)) {
            // token 无效或过期
            handleTokenExpired()
            reject(res.data)
          } else {
            resolve(res.data)
          }
        } else if (res.statusCode === 401) {
          // 未授权，token 无效或过期
          handleTokenExpired()
          reject(res.data)
        } else {
          // 其他错误
          reject(res.data || { code: res.statusCode, msg: '请求失败' })
        }
      },
      fail: (err) => {
        console.error('请求失败:', err)
        wx.showToast({
          title: '网络错误',
          icon: 'none'
        })
        reject(err)
      }
    })
  })
}

// 处理 token 过期
function handleTokenExpired() {
  // 清除所有登录状态
  wx.removeStorageSync('access_token')
  wx.removeStorageSync('token')
  wx.removeStorageSync('userInfo')
  wx.removeStorageSync('isLoggedIn')
  wx.removeStorageSync('token_expire')
  
  // 更新全局状态
  if (app && app.globalData) {
    app.globalData.userInfo = null
    app.globalData.isLoggedIn = false
  }
  
  // 获取当前页面栈
  const pages = getCurrentPages()
  const currentPage = pages[pages.length - 1]
  const currentRoute = currentPage ? currentPage.route : ''
  
  // 如果不是在登录页，则跳转到登录页
  if (currentRoute !== 'pages/login-unified/index') {
    wx.showToast({
      title: '登录已过期',
      icon: 'none',
      duration: 1500,
      success: () => {
        setTimeout(() => {
          wx.redirectTo({
            url: '/pages/login-unified/index'
          })
        }, 1500)
      }
    })
  }
}

// 添加get方法
request.get = (url, data, options = {}) => {
  return request({
    url: url,
    method: 'GET',
    data: data,
    ...options
  })
}

// 添加post方法
request.post = (url, data, options = {}) => {
  return request({
    url: url,
    method: 'POST',
    data: data,
    ...options
  })
}

// 添加put方法
request.put = (url, data, options = {}) => {
  return request({
    url: url,
    method: 'PUT',
    data: data,
    ...options
  })
}

// 添加delete方法
request.delete = (url, data, options = {}) => {
  return request({
    url: url,
    method: 'DELETE',
    data: data,
    ...options
  })
}

module.exports = request