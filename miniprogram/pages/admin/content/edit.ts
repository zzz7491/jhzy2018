// pages/admin/content/edit.ts
// 公益社区内容：create / edit / view 三模式合一。
// - create：新建并提交审核（后端置 DRAFT/PENDING）。
// - view：只读详情 + 审核（通过/驳回）+ 进入编辑。
// - edit：编辑；后端编辑后统一重置为 DRAFT/PENDING。若原已发布，保存前二次确认下线。
// 权限原则：BACKEND-AUTHORITATIVE。前端不复制 RBAC，后端 403 为最终权威。

import adminApi from '../../../utils/adminApi';
import { uploadCommunityImage, downloadAuthImage } from '../../../utils/fileApi';

interface ImgItem {
  file_public_id: string;
  tempFilePath: string;
}

const MAX_IMAGES = 9;
const CONTENT_TYPE = 'post';

function fmtTime(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

Page({
  data: {
    mode: 'view' as 'create' | 'edit' | 'view',
    id: '',
    hasTeam: true,
    loading: true,
    saving: false,

    title: '',
    body: '',
    images: [] as ImgItem[],

    author_nickname: '',
    statusText: '',
    created_at_text: '',
    published_at_text: '',

    originalPublished: false,
  },

  onLoad(options: any) {
    const mode = (options && options.mode) || 'view';
    const id = (options && options.id) || '';
    this.setData({ mode, id, hasTeam: !!wx.getStorageSync('activeTeamPublicId') });
    if (mode !== 'create' && id) {
      this.loadDetail(id);
    } else {
      this.setData({ loading: false });
    }
  },

  loadDetail(id: string) {
    this.setData({ loading: true });
    adminApi
      .getContentArticleDetail(id)
      .then((d: any) => {
        const images: ImgItem[] = (d.attachments || []).map((a: any) => ({
          file_public_id: a.file_public_id,
          tempFilePath: '',
        }));
        const published = d.status === 2 && d.audit_status === 2;
        this.setData({
          loading: false,
          title: d.title || '',
          body: d.body || '',
          author_nickname: d.author_nickname || '未知作者',
          statusText: this.statusTextOf(d.status, d.audit_status),
          created_at_text: fmtTime(d.created_at),
          published_at_text: fmtTime(d.published_at),
          originalPublished: published,
          images,
        });
        images.forEach((img, idx) => {
          downloadAuthImage(img.file_public_id).then((local) => {
            if (local) {
              const patch: any = {};
              patch[`images[${idx}].tempFilePath`] = local;
              this.setData(patch);
            }
          });
        });
      })
      .catch((err: any) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  statusTextOf(status: number, audit: number): string {
    if (status === 1 && audit === 1) return '待审核';
    if (status === 2 && audit === 2) return '已发布';
    if (status === 1 && audit === 3) return '已驳回';
    if (status === 3 && audit === 2) return '已下架';
    return '未知';
  },

  enterEdit() {
    this.setData({ mode: 'edit' });
  },

  cancelEdit() {
    this.setData({ mode: 'view' });
  },

  onTitle(e: any) {
    this.setData({ title: e.detail.value });
  },

  onBody(e: any) {
    this.setData({ body: e.detail.value });
  },

  chooseImage() {
    const remain = MAX_IMAGES - this.data.images.length;
    if (remain <= 0) {
      wx.showToast({ title: `最多 ${MAX_IMAGES} 张图片`, icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res: any) => {
        const files: any[] = res.tempFiles || [];
        files.forEach((f) => {
          if (this.data.images.length >= MAX_IMAGES) return;
          const tp = f.tempFilePath;
          uploadCommunityImage(tp)
            .then((view: any) => {
              const imgs = this.data.images.concat([{ file_public_id: view.file_public_id, tempFilePath: tp }]);
              this.setData({ images: imgs });
            })
            .catch(() => {
              wx.showToast({ title: '图片上传失败', icon: 'none' });
            });
        });
      },
      fail: () => {},
    });
  },

  removeImage(e: any) {
    const idx = e.currentTarget.dataset.idx;
    const imgs = this.data.images.slice();
    imgs.splice(idx, 1);
    this.setData({ images: imgs });
  },

  save() {
    const title = (this.data.title || '').trim();
    const body = this.data.body || '';
    if (!title) {
      wx.showToast({ title: '请填写标题', icon: 'none' });
      return;
    }
    if (this.data.saving) return;

    const doSave = () => {
      this.setData({ saving: true });
      const attachment_file_public_ids = this.data.images.map((i) => i.file_public_id);
      const payload: any = { title, body, attachment_file_public_ids, content_type: CONTENT_TYPE };
      const p =
        this.data.mode === 'create'
          ? adminApi.createContentArticle(payload)
          : adminApi.updateContentArticle(this.data.id, payload);
      p.then(() => {
        this.setData({ saving: false });
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      }).catch((err: any) => {
        this.setData({ saving: false });
        this.handleErr(err);
      });
    };

    if (this.data.mode !== 'create' && this.data.originalPublished) {
      wx.showModal({
        title: '确认编辑',
        content: '编辑已发布内容后，将重新进入审核并暂时从志愿者端下线。',
        success: (r) => {
          if (r.confirm) doSave();
        },
      });
    } else {
      doSave();
    }
  },

  doApprove() {
    this.act((i) => adminApi.approveContentArticle(i), '审核通过并发布');
  },

  doReject() {
    this.act((i) => adminApi.rejectContentArticle(i), '已驳回');
  },

  act(fn: (id: string) => Promise<any>, okMsg: string) {
    if (this.data.saving) return;
    this.setData({ saving: true });
    fn(this.data.id)
      .then(() => {
        this.setData({ saving: false });
        wx.showToast({ title: okMsg, icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch((err: any) => {
        this.setData({ saving: false });
        this.handleErr(err);
      });
  },

  handleErr(err: any) {
    const msg = (err && err.message) || '操作失败';
    if (err && err.status === 403) {
      if (/自己|职责分离|创建者/.test(msg)) {
        wx.showToast({ title: '不能审核自己创建的内容', icon: 'none' });
      } else {
        wx.showToast({ title: '当前账号没有此操作权限', icon: 'none' });
      }
    } else {
      wx.showToast({ title: msg, icon: 'none' });
    }
  },

  noop() {},
});
