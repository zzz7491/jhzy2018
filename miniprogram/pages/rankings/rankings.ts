// pages/rankings/rankings.ts
// P3-G：Rankings 域统一接入 —— 所有请求经 utils/rankingsApi（唯一接入层）。
//
// 行为保全（P3-G 决策：Behavior Preserving）：
// - 分页追加 / hasMore 判定（返回条数 === limit）、下拉刷新、触底加载、静默加载更多 —— 逐字保留。
// - 网络失败：toast「网络请求失败」+ console.error；Promise 仍 resolve（不改为 reject 链路），
//   因为 onPullDownRefresh 依赖 .finally 关闭下拉动画。
// - complete 语义保留：无论成功失败都要关闭 loading / isMoreLoading（否则全屏 loading 卡死）。
// - 头像 avatar 保持原样直绑 {{item.avatar}}，不做 normalizeAvatarUrl（决策 2=A）。
//
// Backend Authority：GET /api/v2/rankings = NO V2 IMPLEMENTATION（详见 utils/rankingsApi.ts 头部）。
// Legacy endpoint rankings.php 在统一 wrapper 之下保留，且保持【公开端点】语义（不注入任何令牌）。

import { listRankings, classifyRankingsError } from '../../utils/rankingsApi';
import type { RankingRow } from '../../utils/rankingsApi';

Page({
  data: {
    // 排行榜数据
    rankings: [] as RankingRow[],

    // 分页参数
    page: 1,
    limit: 20,
    hasMore: true,

    // 加载状态
    loading: true, // 全屏加载（会重置滚动条）
    isMoreLoading: false, // 静默加载更多（不重置滚动条）
  },

  onLoad() {
    console.log('排行榜页面加载');
    this.loadRankings(true);
  },

  /**
   * 下拉刷新
   */
  onPullDownRefresh() {
    this.loadRankings(true).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * 触底加载更多
   */
  loadMore() {
    // 如果正在加载或者没有更多数据了，直接返回
    if (this.data.isMoreLoading || !this.data.hasMore || this.data.loading) {
      return;
    }

    console.log('触底加载更多，当前页：', this.data.page);
    this.loadRankings(false);
  },

  /**
   * 加载排行榜数据核心逻辑
   * @param reset 是否重置列表（用于首次加载和下拉刷新）
   */
  async loadRankings(reset = false): Promise<void> {
    if (reset) {
      this.setData({ loading: true, page: 1, hasMore: true });
    } else {
      this.setData({ isMoreLoading: true });
    }

    const currentPage = reset ? 1 : this.data.page;

    try {
      const result = await listRankings({ page: currentPage, limit: this.data.limit });
      const rankingsData = result.rows;

      const allRankings = reset ? rankingsData : [...this.data.rankings, ...rankingsData];

      this.setData({
        rankings: allRankings,
        // 如果返回的数据少于每页限制，说明后面没数据了
        hasMore: rankingsData.length === this.data.limit,
        page: currentPage + 1,
      });
    } catch (error) {
      // 与原实现 fail 分支一致：仅 log + toast，不抛出（Promise 保持 resolve）。
      console.error('加载排行榜失败:', classifyRankingsError(error));
      wx.showToast({ title: '网络请求失败', icon: 'none' });
    } finally {
      // 无论成功失败，都关闭加载状态（原 wx.request 的 complete 回调语义）
      this.setData({
        loading: false,
        isMoreLoading: false,
      });
    }
  },

  /**
   * 查看志愿者详情
   */
  viewVolunteerDetail(e: { currentTarget: { dataset: { index: string | number } } }) {
    const index = Number(e.currentTarget.dataset.index);
    const volunteer = this.data.rankings[index];

    if (!volunteer) return;

    wx.vibrateShort();

    // 文案拼接逐字保持原样（不做默认值兜底，避免改变 legacy 缺字段时的展示）。
    wx.showModal({
      title: volunteer.real_name,
      content: `志愿者ID: ${volunteer.volunteer_id}\n总积分: ${volunteer.total_points}\n服务时长: ${volunteer.total_hours}小时`,
      showCancel: false,
      confirmText: '知道了',
    });
  },
});
