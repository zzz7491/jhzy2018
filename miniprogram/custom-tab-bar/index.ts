// custom-tab-bar —— P0-A 全局一级导航（自定义 tabBar）
//
// 为什么需要自定义：native tabBar 不支持中心凸起主按钮，而冻结导航要求
// 「签到/签退」为中心凸起、文案明确可读、senior-friendly。
//
// 纪律：
// - 索引 / 文案 / 顺序全部来自 utils/tabbar.ts（与 app.json tabBar.list 一致），不在此处硬编码。
// - 只做导航，不做业务；不请求任何接口，不缓存任何业务状态。
// - 不引入任何 UI framework。

import { TAB_INDEX, TAB_LIST, refreshServiceActive } from '../utils/tabbar';

Component({
  data: {
    list: TAB_LIST,
    selected: TAB_INDEX.HOME,
    messageIndex: TAB_INDEX.MESSAGE,
    unreadCount: 0,
    unreadText: '',

    // 中心按钮「签到/签退」状态位：真值恒来自 GET /api/v2/attendance-sessions/me（G1）。
    // active=true → 中心显示「签退」；GUEST / NO_ACTIVE / ERROR 一律 false → 中性「签到/签退」。
    // 错误时绝不显示「签退」（见 utils/tabbar.ts::refreshServiceActive）。
    serviceActive: false,
  },

  // 每个 tab 页持有独立的 custom-tab-bar 实例，故在所属页面 show 时刷新一次权威态。
  // refreshServiceActive() 内部：Guest 不发请求（不触发登录），同批次请求自动合并为一次。
  pageLifetimes: {
    show() {
      const self = this as any;
      refreshServiceActive(self).catch(() => {
        // 刷新失败保持中性态；绝不在此伪造服务状态。
      });
    },
  },

  methods: {
    onTabTap(e: any) {
      const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {};
      const index = Number(dataset.index);
      const item = this.data.list[index];
      if (!item) return;
      if (index === this.data.selected) return;
      wx.switchTab({
        url: '/' + item.pagePath,
        fail: () => {
          wx.showToast({ title: '页面打开失败', icon: 'none' });
        },
      });
    },

    // 消息未读徽标（由 pages/mine/mine 调用；见 utils/tabbar.ts::setMessageUnread）
    setUnread(count: number) {
      const raw = Number(count);
      const n = isNaN(raw) || raw <= 0 ? 0 : Math.floor(raw);
      this.setData({
        unreadCount: n,
        unreadText: n > 99 ? '99+' : String(n),
      });
    },

    // G1 接入点：由 utils/tabbar.ts::refreshServiceActive 以权威 API 结果驱动。
    setServiceActive(active: boolean) {
      this.setData({ serviceActive: !!active });
    },
  },
});
