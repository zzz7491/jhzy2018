/**
 * 签到服务模块（Legacy 兼容层）
 *
 * P2-A / L8（Core Infrastructure Cleanup）后仅保留被 V2 签到流程
 * （pages/sign/*）之外的少数页面仍在使用的辅助能力：
 *   - getCurrentLocation：定位缓存（pages/mine 使用）
 *   - stopLocationTimer：停止定位定时器状态（pages/mine 使用）
 *   - getAttendanceHistory：从服务端拉取签到历史（pages/attendance/history 使用）
 *
 * 已移除：
 *   - Legacy 签到写缓存 current_attendance 及其全部读取/写入/同步；
 *   - 5 分钟定位上报定时器 startLocationTimer（Legacy 上报已无服务端对应）；
 *   - checkIn / checkOut / getActiveAttendance / checkActivityStatus / calculateDistance
 *     （均为 0 调用者的死方法，且依赖 current_attendance）。
 *
 * V2 签到真源为 GET /api/v2/attendance-sessions/me（pages/sign/*），
 * 本模块不再承担签到状态职责。
 */

const API_BASE = 'https://api.jhzyfw.com/api';

// 请求封装
const request = (url, options = {}) => {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync('access_token');

    wx.request({
      url: API_BASE + url,
      method: options.method || 'GET',
      data: options.data || {},
      header: {
        'Content-Type': 'application/json',
        'Authorization': token ? `Bearer ${token}` : ''
      },
      success: (res) => {
        if (res.statusCode === 200) {
          resolve(res.data);
        } else if (res.statusCode === 401) {
          wx.showToast({ title: '登录已过期', icon: 'none' });
          setTimeout(() => {
            wx.redirectTo({ url: '/pages/login-unified/index' });
          }, 1500);
          reject(new Error('未授权'));
        } else {
          reject(new Error(`请求失败: ${res.statusCode}`));
        }
      },
      fail: (err) => {
        reject(err);
      }
    });
  });
};

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

// 获取签到历史
const getAttendanceHistory = async (page = 1, limit = 20) => {
  try {
    const res = await request(`/attendance_history.php?page=${page}&limit=${limit}`);
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
