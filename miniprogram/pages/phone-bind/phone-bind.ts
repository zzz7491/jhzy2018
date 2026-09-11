// pages/phone-bind/phone-bind.ts
// P0-B 微信可信手机号绑定页（最小 V2 前端接入）。
//
// 交互纪律：
// - 绑定为显式用户动作：仅经 <button open-type="getPhoneNumber"> 触发。
// - 用户拒绝授权 → 保持未绑定（PHONE_UNBOUND），可重试，绝不锁死。
// - 绑定成功 → 仅展示脱敏手机号（phone_mask），不展示完整号码。
// - 无 qualification 门槛、无通知/短信依赖。

import phoneApi from '../../utils/phoneApi';
import type { PhoneStatus } from '../../utils/phoneApi';

Page({
  data: {
    bound: false,
    phone_mask: null as string | null,
    loading: false,
    binding: false,
    errorMsg: '',
    loadingError: false,
  },

  onLoad() {
    this.loadStatus();
  },

  async loadStatus() {
    this.setData({ loading: true, loadingError: false });
    try {
      const st: PhoneStatus = await phoneApi.getStatus();
      this.setData({ bound: st.bound, phone_mask: st.phone_mask });
    } catch (e: any) {
      // 读状态失败（如未登录 / 无 V2 会话）→ 不阻断页面，仍允许尝试绑定。
      this.setData({ loadingError: true });
      console.warn('读取微信手机号状态失败', e);
    } finally {
      this.setData({ loading: false });
    }
  },

  async onGetPhoneNumber(e: any) {
    const detail = e && e.detail ? e.detail : {};
    // 用户拒绝授权：保持未绑定，可重试，不锁。
    if (detail.errMsg && detail.errMsg.indexOf('ok') === -1) {
      wx.showToast({ title: '已取消，可再次尝试', icon: 'none' });
      return;
    }
    const code = detail.code;
    if (!code) {
      wx.showToast({ title: '未获取到授权码', icon: 'none' });
      return;
    }

    this.setData({ binding: true, errorMsg: '' });
    try {
      const st: PhoneStatus = await phoneApi.bind(code);
      this.setData({ bound: st.bound, phone_mask: st.phone_mask, binding: false });
      wx.showToast({ title: '绑定成功', icon: 'success' });
    } catch (e2: any) {
      // 失败保持未绑定（PHONE_UNBOUND），可重试。
      this.setData({ binding: false, errorMsg: (e2 && e2.message) || '绑定失败，请重试' });
      wx.showToast({ title: (e2 && e2.message) || '绑定失败', icon: 'none' });
    }
  },

  goBack() {
    wx.navigateBack({ delta: 1 });
  },
});
