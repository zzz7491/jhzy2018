// pages/admin/qrVerify/qrVerify.ts
// Beta-B1：将扫码核销接到 V2（POST /api/v2/mall/admin/orders/verify）。
//
// 纪律（与 Beta-B1 任务书一致）：
// - 仅对接 /api/v2/mall；绝不调用 legacy PHP 端点（redeem.php / verifier_stats.php / admin_stats.php）。
// - 使用项目统一 mallApi 客户端；Bearer 与 X-Team-Id 由 mallApi 统一注入，不得自行实现鉴权。
// - 不暴露 numeric internal id；不客户端提交 team_id / user_id / order_no。
// - 不做自动重试；核销请求进行中锁定提交（防双提交）。
// - 附属单人核销统计无 V2 等价端点，按任务 §7 移除 legacy stats 请求与非核心展示。

import { mallApi } from '../../../utils/mallApi';

Page({
  data: {
    adminName: '',
    adminRole: '',
    currentTime: '',
    showManualInput: false,
    manualCode: '',
    isLoading: false,
    showResultModal: false,
    verifySuccess: false,
    verifyMessage: '',
  },

  onLoad() {
    this.checkLogin();
    this.getAdminInfo();
    this.startTimeUpdate();
  },

  // onShow 不再拉取 legacy stats（已移除，见文件头说明）。

  // 检查登录状态（不限制角色，所有管理员均可进入）
  checkLogin() {
    const token = wx.getStorageSync('access_token');
    const adminInfo = wx.getStorageSync('adminInfo');

    if (!token || !adminInfo) {
      wx.redirectTo({ url: '/pages/login-unified/index?role=admin' });
      return;
    }
  },

  getAdminInfo() {
    const adminInfo = wx.getStorageSync('adminInfo');
    if (adminInfo) {
      this.setData({
        adminName: adminInfo.real_name || adminInfo.username || '管理员',
        adminRole: adminInfo.role || '',
      });
    }
  },

  startTimeUpdate() {
    this.updateCurrentTime();
    setInterval(() => { this.updateCurrentTime(); }, 1000);
  },

  updateCurrentTime() {
    const now = new Date();
    const timeStr = now.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    this.setData({ currentTime: timeStr });
  },

  toggleManualInput() {
    this.setData({ showManualInput: !this.data.showManualInput, manualCode: '' });
  },

  onManualInput(e: any) {
    this.setData({ manualCode: e.detail.value });
  },

  startScan() {
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: (res) => { this.doVerify(res.result); },
      fail: () => { wx.showToast({ title: '扫码失败', icon: 'none' }); },
    });
  },

  verifyManualCode() {
    const code = this.data.manualCode.trim();
    if (!code) {
      wx.showToast({ title: '请输入兑换码', icon: 'error' });
      return;
    }
    this.doVerify(code);
    this.setData({ manualCode: '' });
  },

  // 核销主路径：仅把扫码/手输内容作为 exchange_code 提交给 V2 verify 端点。
  // 不发送 numeric internal id / team_id / user_id / order_no（由 mallApi + 后端权威处理）。
  async doVerify(rawCode: string) {
    if (this.data.isLoading) return; // 双提交锁：进行中直接丢弃后续请求
    this.setData({ isLoading: true });

    try {
      const result = await mallApi.adminVerify(rawCode);
      const order = result.order || ({} as any);
      const now = new Date();
      const timeStr = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;
      const header = result.status === 'already_verified' ? '该兑换码已核销' : '核销成功';
      const points = mallApi.formatPoints(order.points_units);
      this.setData({
        showResultModal: true,
        verifySuccess: true,
        verifyMessage: `${header}\n兑换物品：${order.product_title || '商品'}\n扣除积分：${points}分\n核销时间：${timeStr}`,
      });
    } catch (err: any) {
      this.setData({
        showResultModal: true,
        verifySuccess: false,
        verifyMessage: this.mapVerifyError(err),
      });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  // V2 verify 错误语义映射（与 workers/src/routes/mall.ts 后端合约一致）：
  //   400 非法兑换码 / 401 未认证 / 403 无权限或缺失团队上下文 /
  //   404 不存在或跨团队 / 409 RESERVED 不可核销 / 5xx(0) 服务端或网络失败。
  mapVerifyError(err: any): string {
    const status = err && err.status;
    switch (status) {
      case 400: return '兑换码格式无效，请确认二维码';
      case 401: return '登录已过期，请重新登录';
      case 403: return '无核销权限或未选择团队';
      case 404: return '兑换码不存在或不属于当前团队';
      case 409: return '该订单当前不可核销';
      case 0: return '网络错误，请重试';
      default: return (err && err.message) || '核销失败，请重试';
    }
  },

  closeResultModal() {
    this.setData({ showResultModal: false });
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('adminInfo');
          wx.removeStorageSync('access_token');
          wx.removeStorageSync('userInfo');
          wx.removeStorageSync('isLoggedIn');
          wx.redirectTo({ url: '/pages/login-unified/index?role=admin' });
        }
      },
    });
  },
});
