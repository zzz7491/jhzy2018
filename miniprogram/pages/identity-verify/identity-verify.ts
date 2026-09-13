// pages/identity-verify/identity-verify.ts
// P0-A 实名认证页（最小 V2 前端闭环）。
//
// 安全纪律（严格遵守）：
// - realName / idCard 仅用于当次提交；成功后立即清空内存中的明文，绝不写入 storage / URL / log。
// - 已认证时仅展示脱敏身份证号（masked_id_card），不展示完整身份证号。
// - 失败态覆盖：MISMATCH / INVALID_INPUT / PROVIDER_ERROR / MANUAL_REVIEW / 429 限流。
// - 不伪造 qualified；资格态由后端资格投影负责（见 qualificationApi）。

import identityApi, { IdentityStatus } from '../../utils/identityApi';

Page({
  data: {
    // 当前后端状态
    status: 'UNVERIFIED' as IdentityStatus,
    maskedIdCard: null as string | null,
    verifiedAt: null as number | null,

    // 表单
    realName: '',
    idCard: '',

    // UI 状态
    loadingStatus: false,
    submitting: false,
    errorMsg: '',

    // 业务结果分支（互斥展示）
    alreadyVerified: false,
    mismatch: false,
    invalidInput: false,
    providerError: false,
    manualReview: false,
  },

  onLoad() {
    this.loadStatus();
  },

  async loadStatus() {
    this.setData({ loadingStatus: true, errorMsg: '' });
    try {
      const st = await identityApi.getStatus();
      this.applyStatus(st.status, st.masked_id_card, st.verified_at);
    } catch (e: any) {
      // 读状态失败不阻断页面（如未登录/无 V2 会话）；仍允许直接提交认证。
      console.warn('读取实名状态失败', e && e.message ? e.message : e);
    } finally {
      this.setData({ loadingStatus: false });
    }
  },

  applyStatus(status: IdentityStatus, maskedIdCard: string | null, verifiedAt: number | null) {
    this.setData({
      status,
      maskedIdCard: maskedIdCard || null,
      verifiedAt: verifiedAt || null,
      alreadyVerified: status === 'VERIFIED',
      mismatch: status === 'MISMATCH',
      invalidInput: status === 'INVALID_INPUT',
      providerError: status === 'PROVIDER_ERROR',
      manualReview: status === 'MANUAL_REVIEW',
    });
  },

  onRealNameInput(e: any) {
    this.setData({ realName: e.detail.value, errorMsg: '' });
  },

  onIdCardInput(e: any) {
    this.setData({ idCard: e.detail.value, errorMsg: '' });
  },

  async onSubmit() {
    const realName = (this.data.realName || '').trim();
    const idCard = (this.data.idCard || '').trim();

    if (!realName) {
      this.setData({ errorMsg: '请输入真实姓名' });
      return;
    }
    if (!idCard) {
      this.setData({ errorMsg: '请输入身份证号' });
      return;
    }

    this.setData({
      submitting: true,
      errorMsg: '',
      mismatch: false,
      invalidInput: false,
      providerError: false,
    });

    try {
      const res = await identityApi.verify(realName, idCard);
      this.applyStatus(res.status, res.masked_id_card, res.verified_at);
      if (res.status === 'VERIFIED') {
        wx.showToast({ title: '认证成功', icon: 'success' });
        // 成功后清空内存中的敏感明文输入（绝不落 storage / URL / log）。
        this.setData({ realName: '', idCard: '' });
      } else if (res.status === 'MANUAL_REVIEW') {
        wx.showToast({ title: '已进入人工复核', icon: 'none' });
      }
    } catch (e2: any) {
      const status = e2 && e2.status ? e2.status : 0;
      if (status === 409) {
        this.setData({ mismatch: true, errorMsg: e2.message || '身份信息不一致，请核对后重试' });
      } else if (status === 400) {
        this.setData({ invalidInput: true, errorMsg: e2.message || '信息格式有误，请检查后重试' });
      } else if (status === 429) {
        this.setData({ errorMsg: e2.message || '操作过于频繁，请稍后重试' });
      } else if (status === 503) {
        this.setData({ providerError: true, errorMsg: e2.message || '认证服务暂不可用，请稍后重试' });
      } else {
        this.setData({ errorMsg: (e2 && e2.message) || '提交失败，请重试' });
      }
      wx.showToast({ title: this.data.errorMsg || '提交失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  goBack() {
    wx.navigateBack({ delta: 1 });
  },
});
