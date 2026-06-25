/**
 * 设备指纹工具
 */

// 获取基础设备信息
const getBasicDeviceInfo = () => {
  return new Promise((resolve) => {
    const systemInfo = wx.getSystemInfoSync();
    
    // 生成设备指纹（简化版）
    const deviceFingerprint = [
      systemInfo.brand,
      systemInfo.model,
      systemInfo.system,
      systemInfo.platform
    ].join('|');
    
    const deviceInfo = {
      fingerprint: deviceFingerprint,
      brand: systemInfo.brand,
      model: systemInfo.model,
      system: systemInfo.system,
      platform: systemInfo.platform,
      version: systemInfo.version,
      SDKVersion: systemInfo.SDKVersion,
      screenWidth: systemInfo.screenWidth,
      screenHeight: systemInfo.screenHeight,
      language: systemInfo.language,
      timestamp: Date.now()
    };
    
    resolve(deviceInfo);
  });
};

// 获取网络类型
const getNetworkType = () => {
  return new Promise((resolve) => {
    wx.getNetworkType({
      success: (res) => {
        resolve(res.networkType);
      },
      fail: () => {
        resolve('unknown');
      }
    });
  });
};

// 完整的设备信息（用于签到）
const getFullDeviceInfo = async () => {
  const [basicInfo, networkType] = await Promise.all([
    getBasicDeviceInfo(),
    getNetworkType()
  ]);
  
  return {
    ...basicInfo,
    networkType,
    userAgent: 'wechat-miniprogram'
  };
};

module.exports = {
  getBasicDeviceInfo,
  getFullDeviceInfo,
  getNetworkType
};