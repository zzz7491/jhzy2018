// pages/community/index/index.ts - 公益社区一级入口（志愿者端 Feed，P33-P4B）
// 说明：community/index 是正式 tabBar 页，直接承载社区 Feed（即为公益社区落地页，无占位态）。
// 逻辑与 pages/community/feed 同源；feed 子页仍保留为可复用实现，未删除。
import { contentApi } from '../../../utils/contentApi';

function formatDateText(input: string | number | null): string {
  if (input == null) return '';
  const d = typeof input === 'number' ? new Date(input * (input < 1e12 ? 1000 : 1)) : new Date(input as string);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / 86400000);
  const p = (n: number) => (n < 10 ? '0' + n : '' + n);
  if (days <= 0) return `今天 ${p(d.getHours())}:${p(d.getMinutes())}`;
  if (days === 1) return `昨天 ${p(d.getHours())}:${p(d.getMinutes())}`;
  if (days < 7) return `${days}天前`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function downloadAuthImage(filePublicId: string): Promise<string | null> {
  const token = wx.getStorageSync('access_token') || wx.getStorageSync('token') || '';
  const teamId = wx.getStorageSync('activeTeamPublicId') || '';
  const header: Record<string, string> = {};
  if (token) header['Authorization'] = `Bearer ${token}`;
  if (teamId) header['X-Team-Id'] = teamId;
  return new Promise((resolve) => {
    wx.downloadFile({
      url: 'https://api.jhzyfw.com/api/v2/files/' + encodeURIComponent(filePublicId),
      header,
      success: (res: any) => {
        if (res.statusCode === 200 && res.tempFilePath) resolve(res.tempFilePath);
        else resolve(null);
      },
      fail: () => resolve(null),
    });
  });
}

Page({
  data: {
    articles: [] as any[],
    loading: true,
    refreshing: false,
    error: false,
    errMsg: '',
    page: 1,
    pageSize: 10,
    hasMore: true,
    total: 0,
    needTeam: false,
  },

  onLoad() {
    this.checkTeamAndLoad();
  },

  onPullDownRefresh() {
    if (this.data.needTeam) {
      wx.stopPullDownRefresh();
      return;
    }
    this.refresh();
  },

  onReachBottom() {
    if (this.data.needTeam) return;
    if (this.data.loading || !this.data.hasMore) return;
    this.loadMore();
  },

  checkTeamAndLoad() {
    const teamId = wx.getStorageSync('activeTeamPublicId') || '';
    if (!teamId) {
      this.setData({ needTeam: true, loading: false });
      return;
    }
    this.setData({ needTeam: false });
    this.refresh();
  },

  goSelectTeam() {
    wx.navigateTo({ url: '/pages/teams/select/select' });
  },

  refresh() {
    this.setData({ refreshing: true, page: 1, hasMore: true });
    this.fetchPage(1, true);
  },

  loadMore() {
    const next = this.data.page + 1;
    this.setData({ page: next });
    this.fetchPage(next, false);
  },

  fetchPage(page: number, reset: boolean) {
    this.setData({ loading: true, error: false });
    contentApi
      .getFeed(page, this.data.pageSize)
      .then((res) => {
        const items = (res.items || []).map((a: any) => ({
          ...a,
          createdText: formatDateText(a.created_at),
          bodyPreview: a.body ? a.body.replace(/\s+/g, ' ').slice(0, 80) : '',
          attachments: (a.attachments || []).map((at: any) => ({ ...at, localUrl: '' })),
        }));
        const articles = reset ? items : this.data.articles.concat(items);
        this.setData({
          articles,
          total: res.pagination ? res.pagination.total : 0,
          hasMore: res.pagination ? page < res.pagination.total_pages : false,
          loading: false,
          refreshing: false,
        });
        wx.stopPullDownRefresh();
        this.downloadAllImages(articles);
      })
      .catch((err: any) => {
        this.setData({
          loading: false,
          refreshing: false,
          error: true,
          errMsg: err && err.message ? err.message : '加载失败',
        });
        wx.stopPullDownRefresh();
      });
  },

  downloadAllImages(articles: any[]) {
    articles.forEach((art, ai) => {
      (art.attachments || []).forEach((at: any, xi: number) => {
        downloadAuthImage(at.file_public_id).then((localUrl) => {
          if (localUrl) {
            this.setData({ [`articles[${ai}].attachments[${xi}].localUrl`]: localUrl });
          }
        });
      });
    });
  },

  goDetail(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/community/article-detail/article-detail?articlePublicId=' + id });
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/community/article-edit/article-edit' });
  },
});
