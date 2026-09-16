// 请求封装（legacy PHP transport）
// P2-C Legacy API Retirement & V2 Migration：
// - 本文件仅服务 legacy PHP 端点（https://api.jhzyfw.com/api/）；V2 请求一律走 utils/transport。
// - Header 构造统一经 transport.buildHeaders（与 V2 wrapper 同一 Header Builder，消除重复拼装）。
// - token 读取 / 过期判定 / 登出清理统一经 Session Manager（utils/session），不再各自 removeStorage。
// - 4 个页面（activities/my、admin/review-aggregate、profile/change-password、profile/edit）仍依赖
//   本文件的错误契约（reject(res.data) / reject({code,msg}) / redirectTo login），故保留其运行时行为。
const session = require('./session');
const transport = require('./transport');

const request = (options) => {
  return new Promise((resolve, reject) => {
    const baseUrl = 'https://api.jhzyfw.com/api/'
    const token = session.getLegacyToken()

    // 检查 token 是否过期（统一经 Session Manager，Unix 秒基准）
    if (session.isLegacyTokenExpired()) {
      // token 已过期，统一登出出口
      session.clearSession()

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

    // Header 统一经 transport.buildHeaders（与 V2 wrapper 同一 Header Builder，消除重复拼装）。
    // options.header 仍可在其后覆盖（页面级自定义头优先）。
    const header = {
      ...transport.buildHeaders({ token, teamScoped: false }),
      ...options.header
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

// 处理 token 过期（统一登出出口 → Session Manager）
function handleTokenExpired() {
  // 清除所有登录状态 + 重置 globalData（唯一登出实现）
  session.clearSession()

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
