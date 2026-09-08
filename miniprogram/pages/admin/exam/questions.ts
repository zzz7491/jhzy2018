// pages/admin/exam/questions.ts — 题库管理（列表 + 新建/编辑）
// P32-P4：exam.question.manage。public_id 寻址；correct answer 仅管理员可见。
// options 为 [{key,text}]；answer 为正确选项 key（多选以逗号分隔，如 "A,B"）。

import adminApi, { type QuestionOption, type QuestionAdminRow } from '../../../utils/adminApi';

const TYPE_LABELS = ['单选', '多选', '判断'];
const TYPES = ['single', 'multiple', 'judge'];
const STATUS_OPTIONS = ['已发布', '草稿'];
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

interface QState {
  mode: 'list' | 'edit';
  editId: string;
  list: QuestionAdminRow[];
  loading: boolean;
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  // form
  stem: string;
  typeIndex: number;
  options: QuestionOption[];
  answer: string;
  difficulty: number;
  tags: string;
  analysis: string;
  statusIndex: number;
  saving: boolean;
}

Page({
  data: {
    mode: 'list',
    editId: '',
    list: [],
    loading: true,
    page: 1,
    pageSize: 50,
    total: 0,
    hasMore: false,
    stem: '',
    typeIndex: 0,
    options: [{ key: 'A', text: '' }],
    answer: '',
    difficulty: 1,
    tags: '',
    analysis: '',
    statusIndex: 0,
    saving: false,
  } as QState,

  onLoad(query: any) {
    const editId = query && query.publicId ? query.publicId : '';
    if (editId) {
      this.setData({ mode: 'edit', editId });
      this.loadOne(editId);
    } else {
      this.loadList(true);
    }
  },

  onPullDownRefresh() {
    if (this.data.mode === 'list') {
      this.loadList(true).finally(() => wx.stopPullDownRefresh());
    }
  },

  onReachBottom() {
    if (this.data.mode === 'list' && this.data.hasMore && !this.data.loading) {
      this.loadList(false);
    }
  },

  async loadList(reset: boolean) {
    this.setData({ loading: true });
    const page = reset ? 1 : (this.data.page as number) + 1;
    try {
      const res = await adminApi.listQuestions(page, this.data.pageSize as number);
      const items = res.items || [];
      const merged = reset ? items : (this.data.list as QuestionAdminRow[]).concat(items);
      this.setData({
        list: merged,
        page,
        total: res.pagination ? res.pagination.total : merged.length,
        hasMore: merged.length < (res.pagination ? res.pagination.total : merged.length),
        loading: false,
      });
    } catch (e: any) {
      this.setData({ loading: false });
      wx.showToast({ title: e && e.message ? e.message : '加载失败', icon: 'none' });
    }
  },

  async loadOne(editId: string) {
    try {
      // 列表接口已含全部字段；复用 list 接口定位单条。
      const res = await adminApi.listQuestions(1, 200);
      const item = (res.items || []).find((q: QuestionAdminRow) => q.public_id === editId);
      if (!item) {
        wx.showToast({ title: '题目不存在', icon: 'none' });
        return;
      }
      const opts = Array.isArray(item.options) ? item.options : [];
      this.setData({
        stem: item.stem || '',
        typeIndex: Math.max(0, TYPES.indexOf(item.question_type)),
        options: opts.length ? opts : [{ key: 'A', text: '' }],
        answer: item.answer || '',
        difficulty: item.difficulty || 1,
        tags: item.tags || '',
        analysis: item.analysis || '',
        statusIndex: item.status === 2 ? 1 : 0,
      });
    } catch (e: any) {
      wx.showToast({ title: e && e.message ? e.message : '加载失败', icon: 'none' });
    }
  },

  onAddQuestion() {
    wx.navigateTo({ url: `/pages/admin/exam/questions?publicId=` });
  },

  onTapQuestion(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/admin/exam/questions?publicId=${id}` });
  },

  // ===== form =====
  onStemInput(e: any) {
    this.setData({ stem: e.detail.value });
  },
  onTypeChange(e: any) {
    this.setData({ typeIndex: Number(e.detail.value) });
  },
  onAnalysisInput(e: any) {
    this.setData({ analysis: e.detail.value });
  },
  onTagsInput(e: any) {
    this.setData({ tags: e.detail.value });
  },
  onDifficultyInput(e: any) {
    this.setData({ difficulty: Number(e.detail.value) || 1 });
  },
  onAnswerInput(e: any) {
    this.setData({ answer: e.detail.value });
  },
  onStatusChange(e: any) {
    this.setData({ statusIndex: Number(e.detail.value) });
  },

  onOptionTextInput(e: any) {
    const idx = e.currentTarget.dataset.idx;
    const options = (this.data.options as QuestionOption[]).slice();
    options[idx] = { ...options[idx], text: e.detail.value };
    this.setData({ options });
  },

  onAddOption() {
    const options = (this.data.options as QuestionOption[]).slice();
    if (options.length >= LETTERS.length) {
      wx.showToast({ title: '选项已达上限', icon: 'none' });
      return;
    }
    options.push({ key: LETTERS[options.length], text: '' });
    this.setData({ options });
  },

  onRemoveOption(e: any) {
    const idx = e.currentTarget.dataset.idx;
    const options = (this.data.options as QuestionOption[]).slice();
    if (options.length <= 2) {
      wx.showToast({ title: '至少保留 2 个选项', icon: 'none' });
      return;
    }
    options.splice(idx, 1);
    // 重新编号
    const renumbered = options.map((o, i) => ({ key: LETTERS[i], text: o.text }));
    this.setData({ options: renumbered });
  },

  async onSave() {
    const d = this.data as QState;
    if (!d.stem || !d.stem.trim()) {
      wx.showToast({ title: '请填写题干', icon: 'none' });
      return;
    }
    const validOpts = (d.options as QuestionOption[]).filter((o) => o.text && o.text.trim());
    if (validOpts.length < 2) {
      wx.showToast({ title: '请至少填写 2 个有效选项', icon: 'none' });
      return;
    }
    if (!d.answer || !d.answer.trim()) {
      wx.showToast({ title: '请填写正确答案', icon: 'none' });
      return;
    }
    const cmd = {
      question_type: TYPES[d.typeIndex],
      stem: d.stem.trim(),
      options: validOpts,
      answer: d.answer.trim(),
      analysis: d.analysis || null,
      difficulty: d.difficulty,
      tags: d.tags || null,
      status: d.statusIndex === 1 ? 2 : 1,
    };
    this.setData({ saving: true });
    try {
      if (d.mode === 'edit' && d.editId) {
        await adminApi.updateQuestion(d.editId, cmd);
        wx.showToast({ title: '已保存', icon: 'success' });
      } else {
        await adminApi.createQuestion(cmd);
        wx.showToast({ title: '创建成功', icon: 'success' });
      }
      setTimeout(() => {
        if (d.mode === 'edit') wx.navigateBack();
        else wx.redirectTo({ url: `/pages/admin/exam/questions` });
      }, 600);
    } catch (e: any) {
      wx.showToast({ title: e && e.message ? e.message : '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
