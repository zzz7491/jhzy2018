/**
 * 签到服务模块
 * 处理活动的签到、签退、位置检测等逻辑
 */

const API_BASE = 'https://api.jhzyfw.com/api';

// 请求封装
const request = (url, options = {}) => {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync('access_token');
    console.log('checkinService请求token:', token); // 添加这行
    
    wx.request({
      url: API_BASE + url,
      method: options.method || 'GET',
      data: options.data || {},
      header: {
        'Content-Type': 'application/json',
        'Authorization': token ? `Bearer ${token}` : ''
      },
      success: (res) => {
        console.log('checkinService响应:', res); // 添加这行
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

// 计算两点距离（米）
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  if (!lat1 || !lng1 || !lat2 || !lng2) return 99999;
  
  const R = 6371000;
  const toRad = (value) => (value * Math.PI) / 180;
  
  const radLat1 = toRad(lat1);
  const radLat2 = toRad(lat2);
  const deltaLat = toRad(lat2 - lat1);
  const deltaLng = toRad(lng2 - lng1);
  
  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
            Math.cos(radLat1) * Math.cos(radLat2) *
            Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  
  return Math.round(R * c);
};

// 签到
const checkIn = async (params) => {
  try {
    // 先获取最新位置
    const location = await getCurrentLocation();
    
    const res = await request('/attendance_checkin.php', {
      method: 'POST',
      data: {
        activity_id: params.activity_id,
        lat: location.latitude,
        lng: location.longitude,
        device_info: params.device_info
      }
    });
    
    if (res.success) {
      // 签到成功，启动定时器
      startLocationTimer(res.data.record_id);
      
      // 保存当前签到记录
      wx.setStorageSync('current_attendance', {
        record_id: res.data.record_id,
        activity_id: params.activity_id,
        checkin_time: res.data.checkin_time,
        status: 'active'
      });
    }
    
    return res;
  } catch (error) {
    console.error('签到失败:', error);
    return { success: false, message: error.message || '签到失败' };
  }
};

// 签退
const checkOut = async (params) => {
  try {
    const current = wx.getStorageSync('current_attendance');
    if (!current || !current.record_id) {
      return { success: false, message: '没有进行中的签到' };
    }
    
    const res = await request('/attendance_checkout.php', {
      method: 'POST',
      data: {
        record_id: current.record_id,
        force: params.force || false
      }
    });
    
    if (res.success) {
      // 清除定时器和缓存
      stopLocationTimer();
      wx.removeStorageSync('current_attendance');
      
      // 记录本次签到历史
      const history = wx.getStorageSync('attendance_history') || [];
      history.unshift({
        ...res.data,
        activity_title: params.activity_title,
        checkin_time: current.checkin_time
      });
      wx.setStorageSync('attendance_history', history.slice(0, 50));
    }
    
    return res;
  } catch (error) {
    console.error('签退失败:', error);
    return { success: false, message: error.message || '签退失败' };
  }
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

// 位置检测定时器
let locationTimer = null;
let violationCount = 0;

// 启动位置检测定时器（每5分钟检测一次）
const startLocationTimer = (recordId) => {
  stopLocationTimer();
  
  locationTimer = setInterval(async () => {
    try {
      const location = await getCurrentLocation();
      
      const res = await request('/attendance_check_location.php', {
        method: 'POST',
        data: {
          record_id: recordId,
          lat: location.latitude,
          lng: location.longitude
        }
      });
      
      if (res.success) {
        if (res.force_checkout) {
          // 被强制签退
          wx.showModal({
            title: '强制签退',
            content: res.message || '因多次离开活动范围，已被强制签退',
            showCancel: false,
            success: () => {
              stopLocationTimer();
              wx.removeStorageSync('current_attendance');
              // 刷新页面
              const pages = getCurrentPages();
              const currentPage = pages[pages.length - 1];
              if (currentPage && currentPage.refreshData) {
                currentPage.refreshData();
              }
            }
          });
        } else if (res.warning_level > 0) {
          // 显示警告
          wx.showToast({
            title: res.message,
            icon: 'none',
            duration: 3000
          });
          
          // 触发页面更新距离警告
          const pages = getCurrentPages();
          const currentPage = pages[pages.length - 1];
          if (currentPage && currentPage.updateDistanceWarning) {
            currentPage.updateDistanceWarning(res.distance, 800, res.warning_level);
          }
        }
      }
    } catch (error) {
      console.error('位置检测失败:', error);
    }
  }, 5 * 60 * 1000); // 5分钟
};

// 停止位置检测定时器
const stopLocationTimer = () => {
  if (locationTimer) {
    clearInterval(locationTimer);
    locationTimer = null;
  }
  violationCount = 0;
};

// 获取进行中的签到
const getActiveAttendance = async () => {
  try {
    const res = await request('/attendance_active.php');
    if (res.success && res.data && res.data.length > 0) {
      const active = res.data[0];
      // 更新缓存
      wx.setStorageSync('current_attendance', {
        record_id: active.id,
        activity_id: active.activity_id,
        checkin_time: active.checkin_time,
        status: 'active'
      });
      return active;
    }
    return null;
  } catch (error) {
    console.error('获取进行中签到失败:', error);
    return null;
  }
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

// 检查活动签到状态
const checkActivityStatus = async (activityId, userLocation, activityLocation, radius) => {
  try {
    // 计算距离
    const distance = calculateDistance(
      userLocation.latitude,
      userLocation.longitude,
      activityLocation.lat,
      activityLocation.lng
    );
    
    const isWithinRange = distance <= radius;
    
    // 检查是否有进行中的签到
    const current = wx.getStorageSync('current_attendance');
    const hasActiveSign = current && current.activity_id == activityId;
    
    return {
      canSignIn: isWithinRange && !hasActiveSign,
      canSignOut: hasActiveSign,
      isWithinRange,
      distance,
      hasActiveSign
    };
  } catch (error) {
    console.error('检查活动状态失败:', error);
    return {
      canSignIn: false,
      canSignOut: false,
      isWithinRange: false,
      distance: 99999,
      hasActiveSign: false
    };
  }
};

module.exports = {
  checkIn,
  checkOut,
  getCurrentLocation,
  getActiveAttendance,
  getAttendanceHistory,
  checkActivityStatus,
  calculateDistance,
  startLocationTimer,
  stopLocationTimer
};