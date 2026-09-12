// pages/subscribe/subscribe.ts
// N0-C 微信订阅授权页（WECHAT_SUBSCRIBE 授权基础）。
//
// 纪律：
// - 授权必须由【用户主动点击】触发：绝不在 onLoad/onShow 自动弹窗、绝不循环骚扰、绝不自动重试。
// - 模板目录来自 V2 后端（不再把前端硬编码 template id 当长期 SSOT）。
// - 只上报 template_key / template_id / state；【不上报 openid】。
// - 使用 V2 subscriptionApi；不调用任何 legacy PHP（get_subscribe_status.php / save_subscribe_status.php）。
// - requestSubscribeMessage 调用成功 ≠ 授权成功：结果以微信真实返回（accept/reject/ban）为准。

import subscriptionApi from '../../utils/subscriptionApi';
import type { ConsentState, ConsentTemplateItem } from '../../utils/subscriptionApi';

interface TemplateVM {
  key: string;
  templateId: string;
  name: string;
  state: ConsentState | null;
  stateLabel: string;
}

const STATE_LABEL: Record<ConsentState, string> = {
  ACCEPT: '已授权',
  REJECT: '已拒绝',
  BAN: '已屏蔽',
};

function labelFor(state: ConsentState | null): string {
  return state ? STATE_LABEL[state] : '未授权';
}

Page({
  data: {
    loading: false,
    error: false,
    ready: false,
    templates: [] as TemplateVM[],
    requesting: '', // 正在请求授权的 template key（防重复点击）
  },

  onLoad() {
    this.loadStatus();
  },

  async loadStatus() {
    this.setData({ loading: true, error: false });
    try {
      const res = await subscriptionApi.status();
      const itemMap: Record<string, ConsentState> = {};
      (res.items || []).forEach((it) => {
        itemMap[it.template_key] = it.consent_state;
      });
      const templates: TemplateVM[] = (res.templates || []).map((t: ConsentTemplateItem) => {
        const state = itemMap[t.template_key] || null;
        return {
          key: t.template_key,
          templateId: t.template_id,
          name: t.title || t.template_key,
          state,
          stateLabel: labelFor(state),
        };
      });
      this.setData({ templates, ready: !!res.delivery_identity_ready, loading: false });
    } catch (e) {
      this.setData({ loading: false, error: true });
    }
  },

  onRetry() {
    this.loadStatus();
  },

  // 用户主动点击「申请订阅」→ 仅该模板的微信授权弹窗（一次一模板，不循环、不自动重试）
  onRequestConsent(e: any) {
    const key: string = e.currentTarget.dataset.key;
    const templateId: string = e.currentTarget.dataset.id;
    if (!key || !templateId) return;
    if (this.data.requesting) return; // 防抖：一次只处理一个授权请求

    this.setData({ requesting: key });
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: (res: any) => {
        const raw = res ? res[templateId] : undefined;
        // 微信真实返回：'accept' | 'reject' | 'ban'（'filter' 等其他值不构成授权结果，不上报）
        let state: ConsentState | null = null;
        if (raw === 'accept') state = 'ACCEPT';
        else if (raw === 'reject') state = 'REJECT';
        else if (raw === 'ban') state = 'BAN';

        if (state == null) {
          this.setData({ requesting: '' });
          wx.showToast({ title: '未获得授权结果', icon: 'none' });
          return;
        }
        const finalState: ConsentState = state;
        subscriptionApi
          .recordConsent({ templateKey: key, templateId, state: finalState })
          .then(() => {
            this.applyState(key, finalState);
            const title = finalState === 'ACCEPT' ? '授权成功' : finalState === 'REJECT' ? '已拒绝' : '已屏蔽';
            wx.showToast({ title, icon: finalState === 'ACCEPT' ? 'success' : 'none' });
          })
          .catch(() => {
            wx.showToast({ title: '保存失败，请重试', icon: 'none' });
          })
          .then(() => {
            this.setData({ requesting: '' });
          });
      },
      fail: () => {
        this.setData({ requesting: '' });
        wx.showToast({ title: '订阅请求失败', icon: 'none' });
      },
    });
  },

  applyState(key: string, state: ConsentState) {
    const templates = this.data.templates.map((t) =>
      t.key === key ? { ...t, state, stateLabel: labelFor(state) } : t,
    );
    this.setData({ templates });
  },
});
