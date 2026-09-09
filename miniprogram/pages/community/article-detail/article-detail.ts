// pages/community/article-detail/article-detail.ts - 社区文章详情（志愿者端，P33-R2B 只读化）
import { contentApi } from '../../../utils/contentApi';

function formatDateText(input: string | number | null): string {
  if (input == null) return '';
  const d = typeof input === 'number' ? new Date(input * (input < 1e12 ? 1000 : 1)) : new Date(input as string);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

interface DetailPageData {
  articlePublicId: string;
  article: any;
  loading: boolean;
  error: boolean;
  errMsg: string;
  needTeam: boolean;
  imgCache: Record<string, string>;
}

Page<DetailPageData>({
  data: {
    articlePublicId: '',
    article: null,
    loading: true,
    error: false,
    errMsg: '',
    needTeam: false,
    imgCache: {},
  },

  onLoad(options: any) {
    const id = options && options.articlePublicId ? options.articlePublicId : '';
    this.setData({ articlePublicId: id });
    if (!id) {
      this.setData({ loading: false, error: true, errMsg: '缺少文章参数' });
      return;
    }
    this.checkTeamAndLoad();
  },

  checkTeamAndLoad() {
    const teamId = wx.getStorageSync('activeTeamPublicId') || '';
    if (!teamId) {
      this.setData({ needTeam: true, loading: false });
      return;
    }
    this.setData({ needTeam: false });
    this.loadAll();
  },

  goSelectTeam() {
    wx.navigateTo({ url: '/pages/teams/select/select' });
  },

  loadAll() {
    this.setData({ loading: true, error: false });
    this.loadArticle(false)
      .then(() => this.setData({ loading: false }))
      .catch((err: any) => {
        this.setData({ loading: false, error: true, errMsg: err && err.message ? err.message : '加载失败' });
      });
  },

  loadArticle(download: boolean): Promise<void> {
    const id = this.data.articlePublicId;
    return contentApi.getArticle(id).then((art: any) => {
      const cache = this.data.imgCache;
      const attachments = (art.attachments || []).map((at: any) => ({
        ...at,
        localUrl: cache[at.file_public_id] || '',
      }));
      const article = { ...art, attachments, createdText: formatDateText(art.created_at) };
      this.setData({ article });
      if (download) this.downloadImages(attachments);
    });
  },

  downloadImages(attachments: any[]) {
    attachments.forEach((at: any) => {
      if (this.data.imgCache[at.file_public_id]) return;
      downloadAuthImage(at.file_public_id).then((localUrl) => {
        if (localUrl) {
          const cache = this.data.imgCache;
          cache[at.file_public_id] = localUrl;
          this.setData({ imgCache: cache });
          // 更新 article 内对应附件
          const list = (this.data.article.attachments || []).map((x: any) =>
            x.file_public_id === at.file_public_id ? { ...x, localUrl } : x,
          );
          this.setData({ 'article.attachments': list });
        }
      });
    });
  },

  previewImage(e: any) {
    const url = e.currentTarget.dataset.url;
    const urls = (this.data.article.attachments || [])
      .filter((x: any) => x.localUrl)
      .map((x: any) => x.localUrl);
    if (!url || urls.length === 0) return;
    wx.previewImage({ current: url, urls });
  },
});
