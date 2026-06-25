// pages/training/chapter/chapter.js
const app = getApp();

Page({
  data: {
    courseId: null,
    courseTitle: '',
    chapters: [],
    currentChapter: null,
    currentChapterIndex: 0,
    loading: true,
    startTime: null,
    timer: null,
    remainingSeconds: 0,
    canNext: false,
    signatureImage: null,
    signatureUploaded: false
  },

  onLoad(options) {
    if (options.course_id) {
      this.setData({ courseId: options.course_id });
      this.loadCourseDetail();
    }
  },

  onShow() {
    this.setData({ startTime: Date.now() });
    this.startTimer();
  },

  onHide() {
    this.stopTimer();
    this.recordProgress();
  },

  onUnload() {
    this.stopTimer();
    this.recordProgress();
  },

  startTimer() {
    if (this.data.timer) return;
    
    const minDuration = this.data.currentChapter?.min_duration || 0;
    this.setData({ remainingSeconds: minDuration, canNext: false });
    
    this.data.timer = setInterval(() => {
      let remaining = this.data.remainingSeconds;
      if (remaining > 0) {
        this.setData({ remainingSeconds: remaining - 1 });
      } else if (remaining === 0 && !this.data.canNext) {
        this.setData({ canNext: true });
        this.stopTimer();
      }
    }, 1000);
  },

  stopTimer() {
    if (this.data.timer) {
      clearInterval(this.data.timer);
      this.data.timer = null;
    }
  },

  loadCourseDetail() {
    const token = wx.getStorageSync('access_token');
    wx.request({
      url: 'https://api.jhzyfw.com/api/training/course_detail.php',
      method: 'GET',
      data: {
        token: token,
        course_id: this.data.courseId
      },
      success: (res) => {
        if (res.data.code === 0 && res.data.data) {
          const course = res.data.data;
          this.setData({
            courseTitle: course.title,
            chapters: course.chapters || [],
            loading: false
          });
          
          const firstUncompleted = this.data.chapters.find(c => !c.is_completed);
          if (firstUncompleted) {
            const index = this.data.chapters.findIndex(c => c.id === firstUncompleted.id);
            this.loadChapter(firstUncompleted.id, index);
          } else if (this.data.chapters.length > 0) {
            this.loadChapter(this.data.chapters[0].id, 0);
          }
        } else {
          wx.showToast({ title: '加载失败', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 1500);
        }
      },
      fail: () => {
        wx.showToast({ title: '网络错误', icon: 'none' });
        this.setData({ loading: false });
      }
    });
  },

  loadChapter(chapterId, index) {
    this.stopTimer();
    
    const token = wx.getStorageSync('access_token');
    wx.request({
      url: 'https://api.jhzyfw.com/api/training/chapter.php',
      method: 'GET',
      data: {
        token: token,
        chapter_id: chapterId
      },
      success: (res) => {
        if (res.data.code === 0 && res.data.data) {
          this.setData({
            currentChapter: res.data.data,
            currentChapterIndex: index,
            startTime: Date.now()
          });
          
          if (res.data.data.title === '志愿者宣誓') {
            this.checkSignatureStatus();
          }
          
          if (res.data.data.is_completed) {
            this.setData({ canNext: true, remainingSeconds: 0 });
          } else {
            this.startTimer();
          }
        }
      },
      fail: (err) => {
        console.error('加载章节失败:', err);
      }
    });
  },

  checkSignatureStatus() {
    const token = wx.getStorageSync('access_token');
    wx.request({
      url: 'https://api.jhzyfw.com/api/training/check_signature.php',
      method: 'GET',
      data: {
        token: token,
        course_id: this.data.courseId,
        chapter_id: this.data.currentChapter.id
      },
      success: (res) => {
        if (res.data.code === 0 && res.data.data && res.data.data.has_signature) {
          this.setData({ signatureUploaded: true, canNext: true });
        }
      }
    });
  },

  chooseSignature() {
    const that = this;
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success(res) {
        const tempFilePath = res.tempFilePaths[0];
        that.setData({ signatureImage: tempFilePath, signatureUploaded: false });
        that.uploadSignature(tempFilePath);
      }
    });
  },

  uploadSignature(filePath) {
    const that = this;
    const token = wx.getStorageSync('access_token');
    const chapterId = this.data.currentChapter.id;
    
    wx.uploadFile({
      url: 'https://api.jhzyfw.com/api/training/upload_signature.php',
      filePath: filePath,
      name: 'signature',
      formData: {
        token: token,
        chapter_id: chapterId,
        course_id: this.data.courseId
      },
      success(res) {
        const data = JSON.parse(res.data);
        if (data.code === 0) {
          that.setData({ signatureUploaded: true });
          that.recordProgress();
          wx.showToast({ title: '签名上传成功', icon: 'success' });
        } else {
          wx.showToast({ title: data.msg || '上传失败', icon: 'none' });
        }
      },
      fail() {
        wx.showToast({ title: '上传失败，请重试', icon: 'none' });
      }
    });
  },

  recordProgress() {
    if (!this.data.currentChapter || !this.data.startTime) return;
    
    const duration = Math.floor((Date.now() - this.data.startTime) / 1000);
    const minDuration = this.data.currentChapter.min_duration || 0;
    const recordDuration = Math.min(duration, minDuration + 10);
    
    const token = wx.getStorageSync('access_token');
    wx.request({
      url: 'https://api.jhzyfw.com/api/training/progress.php',
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: {
        token: token,
        chapter_id: this.data.currentChapter.id,
        duration_spent: recordDuration
      }
    });
  },

  goToNextChapter() {
    if (this.data.currentChapter.title === '志愿者宣誓' && !this.data.signatureUploaded) {
      wx.showToast({ title: '请先上传手写签名', icon: 'none' });
      return;
    }
    
    if (!this.data.canNext) {
      const remaining = this.data.remainingSeconds;
      wx.showToast({ 
        title: `请继续学习 ${remaining} 秒`, 
        icon: 'none',
        duration: 2000
      });
      return;
    }
    
    this.recordProgress();
    
    const nextIndex = this.data.currentChapterIndex + 1;
    if (nextIndex < this.data.chapters.length) {
      const nextChapter = this.data.chapters[nextIndex];
      this.loadChapter(nextChapter.id, nextIndex);
    } else {
      wx.showModal({
        title: '恭喜',
        content: '您已完成本课程所有章节！',
        showCancel: false,
        success: () => {
          wx.navigateBack();
        }
      });
    }
  },

  goBack() {
    this.recordProgress();
    wx.navigateBack();
  }
});