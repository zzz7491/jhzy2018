// pages/ai/index.ts —— 嘉禾 AI V1 会话列表 + 新建会话（P36-C4）
import aiApi, {
  hasActiveTeam,
  validateMessageInput,
  friendlyMessage,
  AI_MAX_MESSAGE_LENGTH,
} from '../../utils/aiApi';

const EXAMPLE_QUESTIONS = [
  '最近有哪些适合参加的活动？',
  '我的志愿服务记录怎么样？',
  '我的积分和成长情况如何？',
  '最近有哪些学习内容？',
  '我的证书情况怎么样？',
];

Page({
  data: {
    hasTeam: true,
    loading: true,
    error: '',
    list: [] as any[],
    page: 1,
    pageSize: 20,
    totalPages: 1,
    hasMore: false,
    creating: false,
    inputValue: '',
    exampleQuestions: EXAMPLE_QUESTIONS,
    maxLength: AI_MAX_MESSAGE_LENGTH,
  },

  onShow() {
    const team = hasActiveTeam();
    this.setData({ hasTeam: team });
    if (team) {
      this.loadList(true);
    } else {
      this.setData({ loading: false, list: [], error: '' });
    }
  },

  onPullDownRefresh() {
    if (this.data.hasTeam) {
      this.loadList(true).finally(() => wx.stopPullDownRefresh());
    } else {
      wx.stopPullDownRefresh();
    }
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading && !this.data.creating) {
      this.loadList(false);
    }
  },

  loadList(reset: boolean): Promise<void> {
    if (!this.data.hasTeam) return Promise.resolve();
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '' });
    return aiApi
      .listConversations(page, this.data.pageSize)
      .then((res) => {
        const items = (res.items || []).map((it: any) => ({
          ...it,
          timeText: this.formatTime(it.updated_at || it.created_at),
        }));
        const merged = reset ? items : this.data.list.concat(items);
        const pagination = res.pagination || { page, page_size: this.data.pageSize, total: merged.length, total_pages: 1 };
        this.setData({
          list: merged,
          page: pagination.page,
          totalPages: pagination.total_pages,
          hasMore: pagination.page < pagination.total_pages,
          loading: false,
        });
      })
      .catch((err: any) => {
        this.handleError(err, reset);
      });
  },

  handleError(err: any, reset: boolean) {
    if (err && err.status === 401) {
      this.setData({ loading: false });
      this.promptLogin();
      return;
    }
    if (err && err.status === 403 && err.code === 'TEAM_SCOPE_REQUIRED') {
      this.setData({ hasTeam: false, loading: false, list: [], error: '' });
      return;
    }
    this.setData({
      loading: false,
      error: friendlyMessage(err),
      list: reset ? [] : this.data.list,
    });
  },

  onInput(e: any) {
    this.setData({ inputValue: e.detail.value });
  },

  onTapExample(e: any) {
    const q = e.currentTarget.dataset.q;
    this.setData({ inputValue: q });
  },

  onCreateOrSend() {
    if (!this.data.hasTeam) {
      wx.showToast({ title: '请先选择服务团队', icon: 'none' });
      return;
    }
    const v = this.data.inputValue;
    const check = validateMessageInput(v);
    if (!check.ok) {
      wx.showToast({
        title: check.reason === 'too_long' ? `最多输入 ${AI_MAX_MESSAGE_LENGTH} 字` : '请输入您的问题',
        icon: 'none',
      });
      return;
    }
    if (this.data.creating) return; // 单会话单次 in-flight lock（列表页新建锁）
    this.setData({ creating: true, error: '' });
    aiApi
      .createConversation(check.value)
      .then((detail) => {
        wx.navigateTo({ url: `/pages/ai/chat?publicId=${detail.public_id}` });
        this.setData({ creating: false, inputValue: '' });
      })
      .catch((err: any) => {
        this.setData({ creating: false });
        if (err && err.status === 401) {
          this.promptLogin();
          return;
        }
        if (err && err.status === 403 && err.code === 'TEAM_SCOPE_REQUIRED') {
          this.setData({ hasTeam: false, list: [], error: '' });
          return;
        }
        wx.showToast({ title: friendlyMessage(err), icon: 'none' });
      });
  },

  onRetry() {
    this.loadList(true);
  },

  goToChat(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/ai/chat?publicId=${id}` });
  },

  goToTeams() {
    wx.navigateTo({ url: '/pages/teams/select/select' });
  },

  promptLogin() {
    wx.showModal({
      title: '需要登录',
      content: '使用嘉禾 AI 需要先登录',
      confirmText: '去登录',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          wx.navigateTo({ url: '/pages/login/index' });
        }
      },
    });
  },

  formatTime(ts: number): string {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const now = new Date();
    const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
    const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}天前`;
    return `${d.getMonth() + 1}-${pad(d.getDate())}`;
  },
});
