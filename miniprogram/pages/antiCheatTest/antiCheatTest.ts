// pages/antiCheatTest/antiCheatTest.ts
import checkinService from '../../services/checkinService';
import deviceFingerprint from '../../utils/device';
import { antiCheatDebugger } from '../../utils/debug';
import { TIMING_CONFIG, ERROR_CODES } from '../../config/api';

Page({
  data: {
    deviceInfo: null,
    debugInfo: null,
    testResults: [] as Array<{ name: string; status: string; message: string }>,
    isTesting: false,
    location: null,
    warnings: [] as Array<{ type: string; message: string; time: string }>
  },

  onLoad() {
    console.log('防作弊测试页面加载');
    this.loadDeviceInfo();
    antiCheatDebugger.setDebugMode(true);
  },

  /**
   * 加载设备信息
   */
  async loadDeviceInfo() {
    try {
      const info = await deviceFingerprint.getDeviceInfo();
      this.setData({
        deviceInfo: info
      });
      console.log('设备信息:', info);
    } catch (error) {
      console.error('加载设备信息失败:', error);
    }
  },

  /**
   * 运行设备信息测试
   */
  async testDeviceInfo() {
    this.addTestResult('设备信息收集', '测试中', '正在收集设备信息...');
    
    try {
      const deviceInfo = await deviceFingerprint.getDeviceInfo();
      
      if (deviceInfo && deviceInfo.device_fingerprint) {
        this.addTestResult('设备信息收集', '成功', `设备指纹: ${deviceInfo.device_fingerprint}`);
      } else {
        this.addTestResult('设备信息收集', '失败', '无法获取设备指纹');
      }
    } catch (error) {
      this.addTestResult('设备信息收集', '错误', error.message);
    }
  },

  /**
   * 运行位置测试
   */
  async testLocation() {
    this.addTestResult('位置获取', '测试中', '正在获取位置...');
    
    try {
      const location = await this.getCurrentLocation();
      
      if (location) {
        this.setData({ location });
        this.addTestResult('位置获取', '成功', 
          `纬度: ${location.latitude}, 经度: ${location.longitude}, 精度: ${location.accuracy}m`);
      } else {
        this.addTestResult('位置获取', '失败', '无法获取位置');
      }
    } catch (error) {
      this.addTestResult('位置获取', '错误', error.message);
    }
  },

  /**
   * 获取当前位置
   */
  getCurrentLocation(): Promise<any> {
    return new Promise((resolve, reject) => {
      wx.getLocation({
        type: 'gcj02',
        success: (res) => {
          resolve({
            latitude: res.latitude,
            longitude: res.longitude,
            accuracy: res.accuracy
          });
        },
        fail: (err) => {
          reject(err);
        }
      });
    });
  },

  /**
   * 运行防作弊警告测试
   */
  async testWarnings() {
    this.addTestResult('警告系统', '测试中', '正在测试警告系统...');
    
    try {
      // 模拟各种警告
      const warningTests = [
        { type: 'location_out_of_range', message: '位置超出范围测试' },
        { type: 'multiple_devices', message: '多设备登录测试' },
        { type: 'pattern_abnormal', message: '行为异常测试' }
      ];

      for (const test of warningTests) {
        const warning = {
          type: test.type,
          message: test.message,
          time: new Date().toLocaleTimeString()
        };

        const warnings = this.data.warnings;
        warnings.push(warning);
        this.setData({ warnings });

        // 添加到测试结果
        this.addTestResult(`警告: ${test.type}`, '模拟', test.message);
        
        // 延迟
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      this.addTestResult('警告系统', '成功', '模拟警告测试完成');
    } catch (error) {
      this.addTestResult('警告系统', '错误', error.message);
    }
  },

  /**
   * 运行调试工具测试
   */
  async testDebugTools() {
    this.addTestResult('调试工具', '测试中', '正在测试调试工具...');
    
    try {
      await antiCheatDebugger.runAllDebugTests();
      
      const report = antiCheatDebugger.getDebugReport();
      this.setData({
        debugInfo: report
      });
      
      this.addTestResult('调试工具', '成功', `调试完成，日志数: ${report.总日志数}`);
    } catch (error) {
      this.addTestResult('调试工具', '错误', error.message);
    }
  },

  /**
   * 运行全面测试
   */
  async runAllTests() {
    if (this.data.isTesting) return;

    this.setData({
      isTesting: true,
      testResults: [],
      warnings: []
    });

    console.log('开始全面防作弊测试');

    // 运行所有测试
    await this.testDeviceInfo();
    await this.testLocation();
    await this.testWarnings();
    await this.testDebugTools();

    this.setData({ isTesting: false });
    
    wx.showToast({
      title: '测试完成',
      icon: 'success'
    });
  },

  /**
   * 添加测试结果
   */
  addTestResult(name: string, status: string, message: string) {
    const result = {
      name,
      status,
      message,
      time: new Date().toLocaleTimeString()
    };

    const testResults = this.data.testResults;
    testResults.push(result);
    this.setData({ testResults });

    console.log(`测试结果: ${name} - ${status} - ${message}`);
  },

  /**
   * 查看设备详情
   */
  viewDeviceDetail() {
    if (this.data.deviceInfo) {
      const info = this.data.deviceInfo;
      const detail = `
设备指纹: ${info.device_fingerprint}
设备型号: ${info.device_model}
系统版本: ${info.os_version}
屏幕分辨率: ${info.screen_resolution}
电池电量: ${info.battery_level}%
网络类型: ${info.network_type}
充电状态: ${info.is_charging ? '充电中' : '未充电'}
微信版本: ${info.wechat_version}
      `.trim();

      wx.showModal({
        title: '设备详情',
        content: detail,
        showCancel: false,
        confirmText: '知道了'
      });
    }
  },

  /**
   * 查看调试信息
   */
  viewDebugInfo() {
    if (this.data.debugInfo) {
      const info = this.data.debugInfo;
      const content = `
总日志数: ${info.总日志数}
调试模式: ${info.调试模式 ? '开启' : '关闭'}
系统平台: ${info.系统信息.platform}
微信版本: ${info.系统信息.version}
      `.trim();

      wx.showModal({
        title: '调试信息',
        content: content,
        showCancel: false,
        confirmText: '知道了'
      });
    }
  },

  /**
   * 清除测试数据
   */
  clearTestData() {
    this.setData({
      testResults: [],
      warnings: [],
      debugInfo: null
    });
    
    antiCheatDebugger.clearLogs();
    
    wx.showToast({
      title: '已清除',
      icon: 'success'
    });
  },

  /**
   * 导出测试报告
   */
  exportTestReport() {
    const report = {
      测试时间: new Date().toISOString(),
      设备信息: this.data.deviceInfo,
      测试结果: this.data.testResults,
      警告记录: this.data.warnings,
      调试日志: antiCheatDebugger.exportLogs()
    };

    const reportStr = JSON.stringify(report, null, 2);
    
    // 在实际应用中，这里可以保存到文件或发送到服务器
    console.log('测试报告:', reportStr);
    
    wx.showModal({
      title: '测试报告',
      content: '报告已生成，请在控制台查看',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  /**
   * 跳转到防作弊说明
   */
  goToGuide() {
    wx.navigateTo({
      url: '/pages/antiCheatGuide/antiCheatGuide'
    });
  }
});
