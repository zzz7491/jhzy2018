// 订阅消息工具类

// 模板ID常量 - 使用最新的模板ID
const TEMPLATE_IDS = {
  SIGNUP_RESULT: '_x9D2d6Ae7wuiewEp4XTPVsSd061O4lPaLreJdZQwM4',  // 报名结果提醒（旧 No.620，已退役 status=2，不再用于 signup review）
  POINTS_CHANGE: 'sGepFsMsjkIGL-ph7mjCNHb9aKG11sh89J55qB3bEok',  // 积分变动提醒
  ACTIVITY_START: 'SrFXViQy2FVmi34qEtJmcbMPOR_cqNHn74zo0eA4eSA'   // 活动开始提醒
}

// 注意：活动报名审核结果通知（原 No.4877）不再在业务代码中硬编码 template id，
// 改为从服务端订阅目录（/api/v2/subscriptions/status）动态取得 template_id。
const SIGNUP_REVIEW_TEMPLATE_KEY = 'signupReview'

// 复用 N0-C 官方订阅授权客户端（仅对接 /api/v2/subscriptions/*，绝不上送 openid）。
// 该模块以 TS 编写，构建期编译为同目录 subscriptionApi.js；兼容 default / named 导出。
let subscriptionApi
try {
  const _sa = require('./subscriptionApi')
  subscriptionApi = (_sa && _sa.default)
    ? _sa.default
    : (_sa && _sa.subscriptionApi)
      ? _sa.subscriptionApi
      : _sa
} catch (e) {
  // 极少数构建环境若未产出 subscriptionApi.js，记录并提供安全降级（不影响报名主流程）。
  console.error('[subscribe] subscriptionApi 加载失败（非致命）:', e)
  subscriptionApi = null
}

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

// 将微信订阅授权返回中单个模板的结果映射为后端 consent 状态。
// wx 真实返回：'accept' | 'reject' | 'ban'（其它值如 'filter' 不构成授权结果，不上报）。
function mapWxResultToState(raw) {
  if (raw === 'accept') return 'ACCEPT'
  if (raw === 'reject') return 'REJECT'
  if (raw === 'ban') return 'BAN'
  return null
}

/**
 * 报名成功后请求「活动报名审核结果」订阅（动态模板 ID + 持久化 consent）。
 * 1. 拉取服务端目录，找到 template_key = signupReview 的当前 template_id；
 * 2. wx.requestSubscribeMessage 请求该动态 ID；
 * 3. 以微信真实返回值映射 ACCEPT/REJECT/BAN 并上报后端落库（幂等）。
 * 任何失败（目录缺失 / 用户拒绝 / BAN / wx 异常 / 上报异常）均不向外抛错，
 * 不得影响已经成功的 activity signup。
 */
async function subscribeSignupReview() {
  if (!subscriptionApi) return
  try {
    const status = await subscriptionApi.status()
    const tpl = (status.templates || []).find(t => t.template_key === SIGNUP_REVIEW_TEMPLATE_KEY)
    if (!tpl || !tpl.template_id) {
      // 目录中无 signupReview（理论上不应发生），静默跳过，不影响报名
      console.warn('[subscribe] signupReview template not found in server catalog, skip')
      return
    }
    const res = await new Promise((resolve, reject) => {
      wx.requestSubscribeMessage({
        tmplIds: [tpl.template_id],
        success: (r) => resolve(r),
        fail: (err) => reject(err)
      })
    })
    const state = mapWxResultToState(res ? res[tpl.template_id] : undefined)
    if (state == null) {
      // 未获得有效授权结果（如 filter），不上报，但不影响报名
      return
    }
    await subscriptionApi.recordConsent({
      templateKey: SIGNUP_REVIEW_TEMPLATE_KEY,
      templateId: tpl.template_id,
      state
    })
  } catch (e) {
    // 订阅/上报失败不得影响已经成功的报名
    console.error('[subscribe] signupReview subscribe failed (non-fatal):', e)
  }
}

/**
 * 报名时订阅消息（积分变动、活动开始；活动报名审核结果走动态目录 subscribeSignupReview）。
 * 注：旧 SIGNUP_RESULT（No.620）已退役，不再请求。
 */
function subscribeAfterSignup() {
  // 积分变动 + 活动开始（既有硬编码，保持既有行为）
  const legacy = requestSubscribe([
    TEMPLATE_IDS.POINTS_CHANGE,
    TEMPLATE_IDS.ACTIVITY_START
  ]).catch(() => {})
  // 活动报名审核结果（动态目录 + 持久化 consent）
  const review = subscribeSignupReview()
  return Promise.all([legacy, review]).then(() => {})
}

module.exports = {
  subscribeAfterSignup,
  subscribeSignupReview
}
