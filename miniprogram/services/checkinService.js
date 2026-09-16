/**
 * 签到服务模块
 *
 * P2-A / L8（Core Infrastructure Cleanup）后仅保留被 V2 签到流程（pages/sign/*）
 * 之外的少数页面仍在使用的辅助能力：
 *   - getCurrentLocation：定位缓存（pages/mine 使用）
 *   - stopLocationTimer：停止定位定时器状态（pages/mine 使用）
 *   - getAttendanceHistory：从 legacy PHP 端点拉取签到历史（pages/attendance/history 使用）
 *
 * P2-C Legacy API Retirement & V2 Migration：
 *   - 已移除本模块自带的私有 request() 与 API_BASE 常量，以及直接读取
 *     wx.getStorageSync('access_token') 的逻辑；传输层统一经 utils/request
 *     （legacy PHP transport，唯一遗留请求出口），令牌读取与登出统一走 Session Manager。
 *   - 自此 utils / services 层不再有任何直接读 access_token 的传输代码。
 *
 * V2 签到真源为 GET /api/v2/attendance-sessions/me（pages/sign/*），
 * 本模块不再承担签到状态职责。
 */

const jhzyRequest = require('../utils/request');

// 获取当前位置
const getCurrentLocation = () => {
  return new Promise((resolve, reject) => {
    // 先尝试获取缓存
    const cached = wx.getStorageSync('cached_location');
    const cachedTime = wx.getStorageSync('cached_location_time');

    if (cached && cachedTime && Date.now() - cachedTime < 120000) {
      resolve(cached);
      return;
    }

    wx.getLocation({
      type: 'wgs84',
      success: (res) => {
        const location = {
          latitude: res.latitude,
          longitude: res.longitude
        };
        // 缓存2分钟
        wx.setStorageSync('cached_location', location);
        wx.setStorageSync('cached_location_time', Date.now());
        resolve(location);
      },
      fail: (err) => {
        if (cached) {
          // 有缓存但过期了，仍然使用
          resolve(cached);
        } else {
          reject(new Error('获取位置失败，请开启定位权限'));
        }
      }
    });
  });
};

// 位置检测定时器状态（仅 stopLocationTimer 使用）
let locationTimer = null;
let violationCount = 0;

// 停止位置检测定时器
const stopLocationTimer = () => {
  if (locationTimer) {
    clearInterval(locationTimer);
    locationTimer = null;
  }
  violationCount = 0;
};

// 获取签到历史（legacy PHP 端点；传输经 utils/request，契约与历史实现一致）
const getAttendanceHistory = async (page = 1, limit = 20) => {
  try {
    const res = await jhzyRequest({
      url: `/attendance_history.php?page=${page}&limit=${limit}`,
      method: 'GET'
    });
    return res;
  } catch (error) {
    console.error('获取签到历史失败:', error);
    return { success: false, data: { list: [], total: 0 } };
  }
};

module.exports = {
  getCurrentLocation,
  getAttendanceHistory,
  stopLocationTimer
};
