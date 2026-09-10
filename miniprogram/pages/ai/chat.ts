// pages/ai/chat.ts —— 嘉禾 AI V1 会话详情 + 发送消息（P36-C4）
import aiApi, {
  hasActiveTeam,
  validateMessageInput,
  friendlyMessage,
  AI_MAX_MESSAGE_LENGTH,
} from '../../utils/aiApi';

interface RenderMessage {
  role: 'user' | 'assistant';
  content: string;
  isUser: boolean;
  sourceText: string;
}

function toRender(messages: any[]): RenderMessage[] {
  return (messages || []).map((m) => ({
    role: m.role,
    content: m.content,
    isUser: m.role === 'user',
    sourceText:
      m.role === 'assistant' && Array.isArray(m.source_labels) && m.source_labels.length > 0
        ? '参考：' + m.source_labels.join(' · ')
        : '',
  }));
}

Page({
  data: {
    publicId: '',
    title: '',
    messages: [] as RenderMessage[],
    loading: true,
    sending: false,
    error: '',
    notFound: false,
    stale: false,
    hasTeam: true,
    inputValue: '',
    scrollIntoView: '',
    maxLength: AI_MAX_MESSAGE_LENGTH,
    bottomAnchor: 'ai-bottom-anchor',
  },

  onLoad(options: any) {
    const publicId = options && options.publicId ? options.publicId : '';
    const team = hasActiveTeam();
    this.setData({ publicId, hasTeam: team });
    if (!publicId) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    if (!team) {
      this.setData({ loading: false, hasTeam: false });
      return;
    }
    this.loadDetail();
  },

  loadDetail(): Promise<void> {
    if (!this.data.hasTeam) return Promise.resolve();
    this.setData({ loading: true, error: '', notFound: false, stale: false });
    return aiApi
      .getConversation(this.data.publicId)
      .then((detail) => {
        this.setData({
          title: detail.title || '嘉禾 AI 对话',
          messages: toRender(detail.messages),
          loading: false,
        });
        this.scrollToBottom();
      })
      .catch((err: any) => this.handleError(err));
  },

  handleError(err: any) {
    this.setData({ sending: false });
    if (err && err.status === 401) {
      this.setData({ loading: false });
      this.promptLogin();
      return;
    }
    if (err && err.status === 403 && err.code === 'TEAM_SCOPE_REQUIRED') {
      this.setData({ hasTeam: false, loading: false });
      return;
    }
    if (err && err.status === 404) {
      this.setData({ loading: false, notFound: true, error: '' });
      return;
    }
    if (err && err.status === 409) {
      // CAS stale：保留已有消息，提示重新加载；不自动重试。
      this.setData({ loading: false, stale: true, sending: false });
      return;
    }
    this.setData({ loading: false, error: friendlyMessage(err) });
  },

  onInput(e: any) {
    this.setData({ inputValue: e.detail.value });
  },

  onSend() {
    if (!this.data.hasTeam) {
      wx.showToast({ title: '请先选择服务团队', icon: 'none' });
      return;
    }
    const v = this.data.inputValue;
    const check = validateMessageInput(v);
    if (!check.ok) {
      wx.showToast({
        title: check.reason === 'too_long' ? `最多输入 ${AI_MAX_MESSAGE_LENGTH} 字` : '请输入内容',
        icon: 'none',
      });
      return;
    }
    if (this.data.sending) return; // 单会话单次 in-flight lock
    if (this.data.stale) {
      wx.showToast({ title: '请先重新加载会话', icon: 'none' });
      return;
    }
    this.setData({ sending: true, error: '' });
    aiApi
      .sendMessage(this.data.publicId, check.value)
      .then((detail) => {
        // 服务端返回完整消息（含历史），前端以服务器为准，绝不本地伪造 assistant 答案。
        this.setData({
          messages: toRender(detail.messages),
          inputValue: '',
          sending: false,
          stale: false,
        });
        this.scrollToBottom();
      })
      .catch((err: any) => {
        this.setData({ sending: false });
        if (err && err.status === 401) {
          this.promptLogin();
          return;
        }
        if (err && err.status === 403 && err.code === 'TEAM_SCOPE_REQUIRED') {
          this.setData({ hasTeam: false });
          return;
        }
        if (err && err.status === 409) {
          this.setData({ stale: true });
          return;
        }
        wx.showToast({ title: friendlyMessage(err), icon: 'none' });
      });
  },

  onReload() {
    this.loadDetail();
  },

  scrollToBottom() {
    // 下一帧再滚动，确保渲染完成
    setTimeout(() => {
      this.setData({ scrollIntoView: this.data.bottomAnchor });
    }, 60);
  },

  goToTeams() {
    wx.navigateTo({ url: '/pages/teams/select/select' });
  },

  promptLogin() {
    wx.showModal({
      title: '需要登录',
      content: '继续对话需要先登录',
      confirmText: '去登录',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          wx.navigateTo({ url: '/pages/login/index' });
        }
      },
    });
  },
});
