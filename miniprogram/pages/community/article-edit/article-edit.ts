// pages/community/article-edit/article-edit.ts - 发布/编辑社区文章（志愿者端，P33-P4B）
// 支持 CREATE（无 articlePublicId）与 EDIT（带 articlePublicId）两种模式。
// 编辑入口在 V1 暂未提供（EDIT_ENTRY = DEFERRED）；页面能力保留。
import { contentApi } from '../../../utils/contentApi';
import { uploadCommunityImage } from '../../../utils/fileApi';

const MAX_IMAGES = 9;

interface ImageItem {
  source: 'existing' | 'new';
  tempFilePath?: string;
  localUrl: string;
  filePublicId: string;
  uploading: boolean;
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

interface EditPageData {
  mode: 'create' | 'edit';
  articlePublicId: string;
  title: string;
  body: string;
  images: ImageItem[];
  submitting: boolean;
  loading: boolean;
  error: boolean;
  errMsg: string;
  needTeam: boolean;
  maxImages: number;
}

Page<EditPageData>({
  data: {
    mode: 'create',
    articlePublicId: '',
    title: '',
    body: '',
    images: [],
    submitting: false,
    loading: true,
    error: false,
    errMsg: '',
    needTeam: false,
    maxImages: MAX_IMAGES,
  },

  onLoad(options: any) {
    const id = options && options.articlePublicId ? options.articlePublicId : '';
    const mode = id ? 'edit' : 'create';
    this.setData({ mode, articlePublicId: id });
    wx.setNavigationBarTitle({ title: mode === 'edit' ? '编辑动态' : '发布动态' });

    const teamId = wx.getStorageSync('activeTeamPublicId') || '';
    if (!teamId) {
      this.setData({ needTeam: true, loading: false });
      return;
    }
    if (mode === 'edit') {
      this.loadForEdit(id);
    } else {
      this.setData({ loading: false });
    }
  },

  goSelectTeam() {
    wx.navigateTo({ url: '/pages/teams/select/select' });
  },

  loadForEdit(id: string) {
    this.setData({ loading: true, error: false });
    contentApi
      .getArticle(id)
      .then((art: any) => {
        const images: ImageItem[] = (art.attachments || []).map((a: any) => ({
          source: 'existing',
          filePublicId: a.file_public_id,
          localUrl: '',
          uploading: false,
        }));
        this.setData({
          title: art.title || '',
          body: art.body || '',
          images,
          loading: false,
        });
        this.resolveExistingImages(images);
      })
      .catch((err: any) => {
        this.setData({ loading: false, error: true, errMsg: (err && err.message) || '加载失败' });
      });
  },

  resolveExistingImages(images: ImageItem[]) {
    images.forEach((img, idx) => {
      if (img.source !== 'existing' || !img.filePublicId) return;
      downloadAuthImage(img.filePublicId).then((localUrl) => {
        if (localUrl) {
          const list = this.data.images.map((it, i) =>
            i === idx ? { ...it, localUrl } : it,
          );
          this.setData({ images: list });
        }
      });
    });
  },

  onTitleInput(e: any) {
    this.setData({ title: e.detail.value });
  },

  onBodyInput(e: any) {
    this.setData({ body: e.detail.value });
  },

  chooseImage() {
    const used = this.data.images.length;
    const remain = MAX_IMAGES - used;
    if (remain <= 0) {
      wx.showToast({ title: `最多 ${MAX_IMAGES} 张图片`, icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res: any) => {
        const picked: ImageItem[] = (res.tempFiles || []).map((f: any) => ({
          source: 'new',
          tempFilePath: f.tempFilePath,
          localUrl: f.tempFilePath,
          filePublicId: '',
          uploading: false,
        }));
        this.setData({ images: this.data.images.concat(picked) });
      },
    });
  },

  removeImage(e: any) {
    const idx = e.currentTarget.dataset.index;
    const images = this.data.images.slice();
    images.splice(idx, 1);
    this.setData({ images });
  },

  submit() {
    const title = (this.data.title || '').trim();
    if (!title) {
      wx.showToast({ title: '请填写标题', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;

    // 先确保新图全部上传得到 file_public_id
    const pending = this.data.images.filter((i) => i.source === 'new' && !i.filePublicId);
    if (pending.length > 0) {
      this.setData({ submitting: true });
      this.uploadAll(pending)
        .then((ok) => {
          if (!ok) {
            this.setData({ submitting: false });
            return;
          }
          this.doSubmit();
        })
        .catch(() => {
          this.setData({ submitting: false });
          wx.showToast({ title: '图片上传失败，请重试', icon: 'none' });
        });
    } else {
      this.setData({ submitting: true });
      this.doSubmit();
    }
  },

  uploadAll(pending: ImageItem[]): Promise<boolean> {
    let chain: Promise<void> = Promise.resolve();
    pending.forEach((img) => {
      chain = chain.then(() => {
        if (!img.tempFilePath) return Promise.resolve();
        return uploadCommunityImage(img.tempFilePath as string).then((view) => {
          // 写入对应 entry 的 filePublicId（按引用定位）
          const images = this.data.images.map((it) => {
            if (it.source === 'new' && it.tempFilePath === img.tempFilePath && !it.filePublicId) {
              return { ...it, filePublicId: view.file_public_id };
            }
            return it;
          });
          this.setData({ images });
        });
      });
    });
    return chain.then(() => true);
  },

  doSubmit() {
    const title = (this.data.title || '').trim();
    const body = this.data.body || '';
    const attachmentIds = this.data.images
      .map((i) => i.filePublicId)
      .filter((x) => !!x) as string[];
    const payload: any = { title, body };
    if (attachmentIds.length > 0) payload.attachment_file_public_ids = attachmentIds;

    const call =
      this.data.mode === 'edit'
        ? contentApi.updateArticle(this.data.articlePublicId, payload)
        : contentApi.createArticle(payload);

    call
      .then((res) => {
        wx.showToast({ title: '提交成功', icon: 'success' });
        const target = '/pages/community/article-detail/article-detail?articlePublicId=' + res.article_public_id;
        setTimeout(() => {
          wx.redirectTo({ url: target });
        }, 600);
      })
      .catch((err: any) => {
        this.setData({ submitting: false });
        const msg = err && err.message ? err.message : '提交失败';
        wx.showToast({ title: msg, icon: 'none' });
      });
  },

  retryLoad() {
    if (this.data.mode === 'edit') this.loadForEdit(this.data.articlePublicId);
    else this.setData({ loading: false, error: false });
  },
});
