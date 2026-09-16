// pages/feedback/feedback.js
// P3-E Feedback Domain Migration —— 用户端意见反馈页。
//
// 纪律（与 P3-C profileApi / P3-D teamApi 同范式）：
// - 本页面的【全部】网络调用统一经 utils/feedbackApi（唯一 Feedback 接入层）。
// - 禁止 wx.request / wx.uploadFile / wx.getStorageSync('access_token') / 手拼 API URL。
// - 令牌由 Session Manager 提供；错误一律经 classifyFeedbackError 归一为五类。
//
// Backend Authority（P3-E Phase A 审计，禁止猜测）：
// - feedback_submit.php / upload_feedback_image.php 在 V2 均为 NO V2 IMPLEMENTATION
//   （workers/src 无 /api/v2/feedback 路由、无 feedback 表；/api/v2/files 不支持反馈图片）。
// - 因此在统一 wrapper 之下保留 legacy PHP 端点，等待 V2 后端就绪后再切换；本次不伪造 V2 语义。
//
// 行为保全：图片 ≤2MB 过滤、上传失败弹窗询问「是否无图继续提交」、最多 3 张、成功后延迟返回 —— 均保持原样。

import {
  classifyFeedbackError,
  submitFeedback as submitFeedbackToServer,
  uploadFeedbackImage,
} from '../../utils/feedbackApi';

interface DatasetEvent {
  currentTarget: { dataset: Record<string, string> };
}

interface ValueEvent {
  detail: { value: string };
}

interface ChosenImageFile {
  path: string;
  size: number;
}

interface ChooseImageSuccessResult {
  tempFiles: ChosenImageFile[];
}

interface ChooseImageFailResult {
  errMsg: string;
}

interface ShowModalResult {
  confirm: boolean;
}

interface FeedbackFormErrors {
  type: string;
  content: string;
  contact: string;
}

const app = getApp()

Page({
  data: {
    // 表单数据
    formData: {
      type: '',       // 反馈类型
      content: '',    // 问题描述
      contact: ''     // 联系方式
    },

    // 表单错误信息
    formErrors: {
      type: '',
      content: '',
      contact: ''
    },

    // 反馈类型选项
    feedbackTypes: [
      { value: 'bug', label: '功能异常', icon: '🐛' },
      { value: 'suggestion', label: '功能建议', icon: '💡' },
      { value: 'experience', label: '体验问题', icon: '😊' },
      { value: 'other', label: '其他反馈', icon: '📝' }
    ],

    // 上传的图片
    uploadedImages: [] as string[],

    // 页面状态
    submitting: false,
    loading: false,
    isFormValid: false,

    // 老年模式
    isSeniorMode: false
  },

  onLoad() {
    // 检查老年模式
    const isSeniorMode = app.globalData.isSeniorMode || false
    this.setData({ isSeniorMode })

    // 设置页面样式
    if (isSeniorMode) {
      wx.setNavigationBarTitle({ title: '意见反馈' })
    }
  },

  // 返回上一页
  goBack() {
    wx.navigateBack({ delta: 1 })
  },

  // 选择反馈类型
  selectType(e: DatasetEvent) {
    const type = e.currentTarget.dataset.value
    this.setData({
      'formData.type': type,
      'formErrors.type': ''
    })
    this.validateForm()
  },

  // 内容输入变化
  onContentChange(e: ValueEvent) {
    const content = e.detail.value
    this.setData({
      'formData.content': content,
      'formErrors.content': ''
    })
    this.validateForm()
  },

  // 联系方式输入变化
  onContactChange(e: ValueEvent) {
    const contact = e.detail.value
    this.setData({
      'formData.contact': contact,
      'formErrors.contact': ''
    })
  },

  // 选择图片
  chooseImage() {
    const maxCount = 3 - this.data.uploadedImages.length
    if (maxCount <= 0) return

    wx.chooseImage({
      count: maxCount,
      sizeType: ['compressed'], // 压缩图
      sourceType: ['album', 'camera'],
      success: (res: ChooseImageSuccessResult) => {
        // 检查图片大小
        const tempFiles = res.tempFiles
        const validFiles = tempFiles.filter((file: ChosenImageFile) => file.size <= 2 * 1024 * 1024) // 2MB限制

        if (validFiles.length < tempFiles.length) {
          wx.showToast({
            title: '部分图片超过2MB',
            icon: 'none',
            duration: 2000
          })
        }

        if (validFiles.length > 0) {
          const newImages = validFiles.map((file: ChosenImageFile) => file.path)
          this.setData({
            uploadedImages: [...this.data.uploadedImages, ...newImages].slice(0, 3)
          })
        }
      },
      fail: (err: ChooseImageFailResult) => {
        console.error('选择图片失败:', err)
        if (err.errMsg.includes('cancel')) return
        wx.showToast({
          title: '选择图片失败',
          icon: 'none',
          duration: 2000
        })
      }
    })
  },

  // 删除图片
  deleteImage(e: DatasetEvent) {
    const index = Number(e.currentTarget.dataset.index)
    const images = this.data.uploadedImages
    images.splice(index, 1)
    this.setData({ uploadedImages: images })
  },

  // 验证表单
  validateForm() {
    const { type, content } = this.data.formData
    const errors: FeedbackFormErrors = { type: '', content: '', contact: '' }
    let isValid = true

    // 验证反馈类型
    if (!type) {
      errors.type = '请选择反馈类型'
      isValid = false
    }

    // 验证问题描述
    if (!content) {
      errors.content = '请填写问题描述'
      isValid = false
    } else if (content.length < 10) {
      errors.content = '问题描述不能少于10个字'
      isValid = false
    }

    // 验证联系方式（可选，但如果有就需要验证格式）
    if (this.data.formData.contact) {
      const contact = this.data.formData.contact.trim()
      const phoneRegex = /^1[3-9]\d{9}$/
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

      if (!phoneRegex.test(contact) && !emailRegex.test(contact)) {
        errors.contact = '请输入正确的手机号或邮箱'
        isValid = false
      }
    }

    this.setData({
      formErrors: errors,
      isFormValid: isValid
    })

    return isValid
  },

  // 上传图片到服务器（统一经 feedbackApi；成功返回 URL 列表）
  async uploadImages(images: string[]) {
    if (images.length === 0) return []

    const imageUrls = await Promise.all(
      images.map((imagePath: string) => uploadFeedbackImage(imagePath)),
    )
    return imageUrls
  },

  // 提交反馈
  async onSubmit() {
    // 验证表单
    if (!this.validateForm()) {
      wx.showToast({
        title: '请检查表单信息',
        icon: 'none',
        duration: 2000
      })
      return
    }

    // 防止重复提交
    if (this.data.submitting) return
    this.setData({ submitting: true, loading: true })

    try {
      let imageUrls: string[] = []

      // 如果有图片，先上传图片
      if (this.data.uploadedImages.length > 0) {
        try {
          imageUrls = await this.uploadImages(this.data.uploadedImages)
          console.log('图片上传成功:', imageUrls)
        } catch (uploadErr) {
          console.error('图片上传失败:', uploadErr)
          const feedbackError = classifyFeedbackError(uploadErr)
          wx.showModal({
            title: '图片上传失败',
            content: feedbackError.message || '是否继续提交反馈（不含图片）？',
            confirmText: '继续提交',
            cancelText: '取消',
            success: (modalRes: ShowModalResult) => {
              if (modalRes.confirm) {
                // 继续提交，但不包含图片
                this.submitFeedback([])
              } else {
                this.setData({ submitting: false, loading: false })
              }
            }
          })
          return
        }
      }

      // 提交反馈数据
      await this.submitFeedback(imageUrls)

    } catch (err) {
      console.error('提交失败:', err)
      wx.showToast({
        title: classifyFeedbackError(err).message || '提交失败，请重试',
        icon: 'none',
        duration: 3000
      })
      this.setData({ submitting: false, loading: false })
    }
  },

  // 提交反馈到后端
  async submitFeedback(imageUrls: string[]) {
    const { type, content, contact } = this.data.formData

    try {
      await submitFeedbackToServer({
        type,
        content,
        contact: contact || '',
        images: imageUrls,
        timestamp: Date.now(),
      })

      // 提交成功
      this.setData({
        submitting: false,
        loading: false
      })

      wx.showToast({
        title: '反馈提交成功',
        icon: 'success',
        duration: 2000
      })

      // 延迟1.5秒后返回上一页
      setTimeout(() => {
        wx.navigateBack({ delta: 1 })
      }, 1500)

    } catch (err) {
      console.error('提交过程出错:', err)
      this.setData({ submitting: false, loading: false })
      throw err
    }
  },

  // 电话联系
  callPhone() {
    wx.showModal({
      title: '联系我们',
      content: '请拨打服务热线：0573-82099982',
      confirmText: '拨打',
      cancelText: '取消',
      success: (res: ShowModalResult) => {
        if (res.confirm) {
          wx.makePhoneCall({
            phoneNumber: '0573-82099982'
          })
        }
      }
    })
  },

  // 跳转到帮助中心
  goToHelp() {
    wx.navigateTo({
      url: '/pages/help-center/help-center'
    })
  },

  // 页面卸载
  onUnload() {
    // 清理数据
    this.setData({
      formData: { type: '', content: '', contact: '' },
      uploadedImages: [],
      formErrors: {},
      submitting: false,
      loading: false,
      isFormValid: false
    })
  },

  // 分享功能
  onShareAppMessage() {
    return {
      title: '志愿服务的意见反馈',
      path: 'pages/feedback/feedback'
    }
  }
})
