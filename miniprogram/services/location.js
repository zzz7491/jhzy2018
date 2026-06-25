/**
 * 位置服务 - 防作弊位置监控
 */

// 存储当前监控的定时器
const monitors = {};

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

// 获取当前位置
const getCurrentLocation = () => {
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: 'wgs84',
      success: resolve,
      fail: (err) => {
        if (err.errMsg.includes('auth deny')) {
          reject(new Error('请开启定位权限'));
        } else {
          reject(err);
        }
      }
    });
  });
};

// 开始位置监控
const startMonitoring = (activityId, startLat, startLng) => {
  // 停止现有监控
  stopMonitoring(activityId);
  
  console.log(`开始位置监控，活动ID: ${activityId}`);
  
  // 每5分钟检查一次
  const timer = setInterval(async () => {
    try {
      const location = await getCurrentLocation();
      const distance = calculateDistance(
        location.latitude,
        location.longitude,
        startLat,
        startLng
      );
      
      console.log(`位置检查: 距离${distance}米`);
      
      // 上报到后端
      try {
        const token = wx.getStorageSync('access_token') || '';
        wx.request({
          url: 'https://api.jhzyfw.com/api/location_monitor.php',
          method: 'POST',
          header: { 
            'Authorization': token ? 'Bearer ' + token : '', 
            'Content-Type': 'application/json'
          },
          data: {
            activity_id: activityId,
            latitude: location.latitude,
            longitude: location.longitude,
            distance: distance
          }
        });
      } catch (reportError) {
        console.error('上报位置失败:', reportError);
      }
      
      // 触发页面更新
      const pages = getCurrentPages();
      const currentPage = pages[pages.length - 1];
      if (currentPage && currentPage.updateLocationStatus) {
        currentPage.updateLocationStatus(distance);
      }
      
    } catch (error) {
      console.error('位置监控失败:', error);
    }
  }, 5 * 60 * 1000); // 5分钟
  
  monitors[activityId] = timer;
  return true;
};

// 停止位置监控
const stopMonitoring = (activityId) => {
  if (monitors[activityId]) {
    clearInterval(monitors[activityId]);
    delete monitors[activityId];
    console.log(`停止位置监控，活动ID: ${activityId}`);
    return true;
  }
  return false;
};

// 停止所有监控
const stopAllMonitoring = () => {
  Object.keys(monitors).forEach(activityId => {
    clearInterval(monitors[activityId]);
    delete monitors[activityId];
  });
  console.log('停止所有位置监控');
};

module.exports = {
  startMonitoring,
  stopMonitoring,
  stopAllMonitoring,
  getCurrentLocation,
  calculateDistance
};