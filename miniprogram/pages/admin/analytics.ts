// pages/admin/analytics.ts
// P37-C2：数据运营后台 Dashboard（前端）。
// 仅消费 P37-C1 后端 /analytics/{team,platform}/overview；不重算、不拼接第二套统计。
// 权限/作用域：后端 /users/me 的 analytics_capabilities 为 authoritative（不硬编码 role，不靠 403 探测）。
// 并发：_reqSeq 仅接受最新请求结果（快速切 range/scope 时旧请求不得覆盖新请求）。

import analyticsApi, { AnalyticsRange, AnalyticsOverview } from '../../utils/analyticsApi';

interface MetricItem {
  key: string;
  label: string;
  value: string;
  hint?: string;
}

interface MetricGroup {
  title: string;
  items: MetricItem[];
}

interface AnalyticsData {
  loading: boolean;
  loadError: string;
  scope: 'team' | 'platform' | '';
  canTeam: boolean;
  canPlatform: boolean;
  hasTeam: boolean;
  range: AnalyticsRange;
  periodText: string;
  groups: MetricGroup[];
  showNoPermission: boolean;
  showSelectTeam: boolean;
}

type MetricKey = keyof AnalyticsOverview['metrics'];

interface GroupDef {
  title: string;
  items: { key: MetricKey; label: string; hint?: string; isMinutes?: boolean }[];
}

const GROUP_DEFS: GroupDef[] = [
  {
    title: '志愿者',
    items: [
      { key: 'volunteer_count', label: '有效志愿者' },
      { key: 'new_volunteer_count', label: '新增志愿者' },
    ],
  },
  {
    title: '活动',
    items: [
      { key: 'activity_count', label: '活动总数', hint: '未删除且未取消' },
      { key: 'active_activity_count', label: '活跃活动' },
    ],
  },
  {
    title: '志愿服务',
    items: [
      { key: 'service_participation_count', label: '服务人次' },
      { key: 'service_minutes_total', label: '服务总时长', isMinutes: true },
    ],
  },
  {
    title: '待审核',
    items: [
      { key: 'activity_review_pending', label: '活动待审核' },
      { key: 'service_adjustment_pending', label: '服务时长调整待审核' },
      { key: 'community_review_pending', label: '社区内容待审核' },
    ],
  },
  {
    title: '嘉禾 AI',
    items: [
      { key: 'ai_call_count', label: 'AI 调用量' },
      { key: 'ai_active_user_count', label: 'AI 活跃用户' },
    ],
  },
];

function fmtMinutes(m: number): string {
  const v = m || 0;
  if (v < 60) return `${v} 分钟`;
  const h = Math.floor(v / 60);
  const r = v % 60;
  return r === 0 ? `${h} 小时` : `${h} 小时 ${r} 分钟`;
}

function fmtPeriod(start: number, end: number): string {
  const f = (ts: number) => {
    const d = new Date(ts * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return `${f(start)} ~ ${f(end)}`;
}

function buildGroups(metrics: AnalyticsOverview['metrics']): MetricGroup[] {
  return GROUP_DEFS.map((g) => ({
    title: g.title,
    items: g.items.map((it) => {
      const raw = metrics[it.key];
      const value = it.isMinutes ? fmtMinutes(raw) : String(raw || 0);
      return { key: it.key, label: it.label, hint: it.hint, value };
    }),
  }));
}

function friendlyError(err: any): string {
  if (!err) return '请求失败';
  if (err.isNetwork) return '网络异常，请检查网络后重试';
  const s = err.status;
  if (s === 400) return '参数错误，请重试';
  if (s === 401) return '登录失效，请重新登录';
  if (s === 403) return '无权限访问该数据';
  if (s === 429) return '请求过于频繁，请稍后再试';
  if (s >= 500) return '服务暂不可用，请稍后重试';
  return err.message || '请求失败';
}

const initialData: AnalyticsData = {
  loading: true,
  loadError: '',
  scope: '',
  canTeam: false,
  canPlatform: false,
  hasTeam: false,
  range: '7d',
  periodText: '',
  groups: [],
  showNoPermission: false,
  showSelectTeam: false,
};

Page({
  data: initialData,

  // 并发令牌：仅接受最新一次请求的结果
  _reqSeq: 0 as unknown as number,

  onLoad() {
    const token = wx.getStorageSync('access_token') || wx.getStorageSync('token');
    if (!token) {
      wx.redirectTo({ url: '/pages/login-unified/index?role=admin' });
      return;
    }
    (this as any)._reqSeq = 0;
    const hasTeam = !!wx.getStorageSync('activeTeamPublicId');
    this.setData({ hasTeam });
    this.bootstrap();
  },

  onPullDownRefresh() {
    this.reload();
    wx.stopPullDownRefresh();
  },

  /**
   * 拉取 authoritative 能力投影（后端 /users/me 的 analytics_capabilities），
   * 据此决定入口可见性与默认作用域。不依赖 analytics 端点的 403 探测做权限发现。
   * - 两个权限均无 → 无权限，0 次 overview 请求。
   * - 仅 team → TEAM；仅 platform → PLATFORM；两者皆有 → 默认 TEAM 且可切换。
   * - 持有团队权限但未选团队 → TEAM_CONTEXT_MISSING（非 NO_PERMISSION），不发起请求。
   */
  bootstrap() {
    const seq = ((this as any)._reqSeq = ((this as any)._reqSeq || 0) + 1);
    this.setData({ loading: true, loadError: '', showNoPermission: false, showSelectTeam: false });

    analyticsApi.getCapabilities().then((caps) => {
      if (seq !== (this as any)._reqSeq) return; // stale guard
      const canTeam = caps.team_view;
      const canPlatform = caps.platform_view;
      if (!canTeam && !canPlatform) {
        this.setData({ loading: false, canTeam, canPlatform, scope: '', showNoPermission: true });
        return;
      }
      // 冻结默认规则：优先 TEAM；仅 platform 时 PLATFORM
      const scope: 'team' | 'platform' = canTeam ? 'team' : 'platform';
      this.setData({ canTeam, canPlatform, scope });
      if (scope === 'team' && !this.data.hasTeam) {
        // 持有团队权限但未选团队：TEAM_CONTEXT_MISSING（非 NO_PERMISSION），不发起请求
        this.setData({ loading: false, showSelectTeam: true });
        return;
      }
      this.load(scope, this.data.range);
    }).catch(() => {
      if (seq !== (this as any)._reqSeq) return; // stale guard
      this.setData({ loading: false, loadError: '获取权限信息失败，请重试' });
    });
  },

  reload() {
    if (!this.data.scope) {
      this.bootstrap();
      return;
    }
    this.load(this.data.scope, this.data.range);
  },

  /** 加载指定 scope + range 的概览；TEAM 无 active team 时仅提示选团队，不发起请求。 */
  load(scope: 'team' | 'platform', range: AnalyticsRange) {
    if (scope === 'team' && !this.data.hasTeam) {
      this.setData({ showSelectTeam: true, groups: [], loadError: '' });
      return;
    }
    const seq = ((this as any)._reqSeq = ((this as any)._reqSeq || 0) + 1);
    this.setData({ loading: true, loadError: '', showSelectTeam: false });
    const p: Promise<AnalyticsOverview> =
      scope === 'team'
        ? analyticsApi.getTeamOverview(range)
        : analyticsApi.getPlatformOverview(range);
    p.then((res) => {
      if (seq !== (this as any)._reqSeq) return; // stale guard
      this.setData({
        scope,
        periodText: fmtPeriod(res.period.start, res.period.end),
        groups: buildGroups(res.metrics),
        loading: false,
      });
    }).catch((err) => {
      if (seq !== (this as any)._reqSeq) return; // stale guard
      this.setData({ loading: false, loadError: friendlyError(err) });
    });
  },

  switchScope(e: any) {
    const scope = e.currentTarget.dataset.scope as 'team' | 'platform';
    if (scope === this.data.scope) return;
    if (scope === 'team' && !this.data.hasTeam) {
      this.setData({ scope, showSelectTeam: true, groups: [] });
      return;
    }
    this.load(scope, this.data.range);
  },

  switchRange(e: any) {
    const range = e.currentTarget.dataset.range as AnalyticsRange;
    if (range === this.data.range) return;
    this.setData({ range });
    if (this.data.scope) {
      this.load(this.data.scope, range);
    }
  },

  goSelectTeam() {
    wx.navigateTo({ url: '/pages/teams/select/select' });
  },

  retry() {
    this.reload();
  },
});
