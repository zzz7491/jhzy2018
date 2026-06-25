// 订阅消息工具类

// 模板ID常量 - 使用最新的模板ID
const TEMPLATE_IDS = {
  SIGNUP_RESULT: '_x9D2d6Ae7wuiewEp4XTPVsSd061O4lPaLreJdZQwM4',  // 报名结果提醒
  POINTS_CHANGE: 'sGepFsMsjkIGL-ph7mjCNHb9aKG11sh89J55qB3bEok',  // 积分变动提醒
  ACTIVITY_START: 'SrFXViQy2FVmi34qEtJmcbMPOR_cqNHn74zo0eA4eSA'   // 活动开始提醒
}

/**
 * 请求订阅消息授权
 * @param {Array} tmplIds 模板ID数组
 * @returns {Promise} 返回用户授权结果
 */
function requestSubscribe(tmplIds) {
  return new Promise((resolve, reject) => {
    if (!tmplIds || tmplIds.length === 0) {
      resolve({})
      return
    }

    wx.requestSubscribeMessage({
      tmplIds: tmplIds,
      success: (res) => {
        console.log('订阅消息授权返回:', res)
        // 检查用户是否授权
        const acceptAll = tmplIds.every(id => res[id] === 'accept')
        if (acceptAll) {
          resolve(res)
        } else {
          reject({ errMsg: '用户拒绝订阅' })
        }
      },
      fail: (err) => {
        console.error('订阅消息授权失败:', err)
        reject(err)
      }
    })
  })
}

/**
 * 报名时订阅消息（积分变动、报名结果、活动开始）
 */
function subscribeAfterSignup() {
  return requestSubscribe([
    TEMPLATE_IDS.POINTS_CHANGE,
    TEMPLATE_IDS.SIGNUP_RESULT,
    TEMPLATE_IDS.ACTIVITY_START
  ])
}

module.exports = {
  subscribeAfterSignup
}