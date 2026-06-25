// pages/feedback/feedback.js
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
    uploadedImages: [],
    
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
  selectType(e) {
    const type = e.currentTarget.dataset.value
    this.setData({
      'formData.type': type,
      'formErrors.type': ''
    })
    this.validateForm()
  },

  // 内容输入变化
  onContentChange(e) {
    const content = e.detail.value
    this.setData({
      'formData.content': content,
      'formErrors.content': ''
    })
    this.validateForm()
  },

  // 联系方式输入变化
  onContactChange(e) {
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
      success: (res) => {
        // 检查图片大小
        const tempFiles = res.tempFiles
        const validFiles = tempFiles.filter(file => file.size <= 2 * 1024 * 1024) // 2MB限制
        
        if (validFiles.length < tempFiles.length) {
          wx.showToast({
            title: '部分图片超过2MB',
            icon: 'none',
            duration: 2000
          })
        }
        
        if (validFiles.length > 0) {
          const newImages = validFiles.map(file => file.path)
          this.setData({
            uploadedImages: [...this.data.uploadedImages, ...newImages].slice(0, 3)
          })
        }
      },
      fail: (err) => {
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
  deleteImage(e) {
    const index = e.currentTarget.dataset.index
    const images = this.data.uploadedImages
    images.splice(index, 1)
    this.setData({ uploadedImages: images })
  },

  // 验证表单
  validateForm() {
    const { type, content } = this.data.formData
    const errors = {}
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

  // 上传图片到服务器
  async uploadImages(images) {
    if (images.length === 0) return []

    // 检查apiBaseUrl配置，确保没有双斜杠
    const apiBaseUrl = app.globalData.apiBaseUrl || 'https://api.jhzyfw.com/api'
    const uploadUrl = `${apiBaseUrl.replace(/\/$/, '')}/upload_feedback_image.php`
    
    console.log('上传图片到:', uploadUrl)

    const uploadTasks = images.map(imagePath => {
      return new Promise((resolve, reject) => {
        wx.uploadFile({
          url: uploadUrl,
          filePath: imagePath,
          name: 'file',
          header: {
            'Authorization': `Bearer ${wx.getStorageSync('access_token')}`
          },
          success: (res) => {
            try {
              const result = JSON.parse(res.data)
              if (result.code === 200) {
                resolve(result.data.url)
              } else {
                reject(new Error(result.message || '上传失败'))
              }
            } catch (err) {
              console.error('解析响应失败:', res.data)
              reject(new Error('服务器响应异常'))
            }
          },
          fail: (err) => {
            console.error('上传请求失败:', err)
            reject(new Error('网络请求失败'))
          }
        })
      })
    })

    try {
      const imageUrls = await Promise.all(uploadTasks)
      return imageUrls
    } catch (err) {
      console.error('图片上传失败:', err)
      throw err // 直接抛出错误，让上层处理
    }
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
      let imageUrls = []
      
      // 如果有图片，先上传图片
      if (this.data.uploadedImages.length > 0) {
        try {
          imageUrls = await this.uploadImages(this.data.uploadedImages)
          console.log('图片上传成功:', imageUrls)
        } catch (uploadErr) {
          console.error('图片上传失败:', uploadErr)
          wx.showModal({
            title: '图片上传失败',
            content: '是否继续提交反馈（不含图片）？',
            confirmText: '继续提交',
            cancelText: '取消',
            success: (modalRes) => {
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
        title: err.message || '提交失败，请重试',
        icon: 'none',
        duration: 3000
      })
      this.setData({ submitting: false, loading: false })
    }
  },

  // 提交反馈到后端
  async submitFeedback(imageUrls) {
    const { type, content, contact } = this.data.formData
    const token = wx.getStorageSync('access_token')
    
    if (!token) {
      wx.showToast({
        title: '请先登录',
        icon: 'none',
        duration: 2000
      })
      this.setData({ submitting: false, loading: false })
      return
    }

    // 检查apiBaseUrl配置，确保没有双斜杠
    const apiBaseUrl = app.globalData.apiBaseUrl || 'https://api.jhzyfw.com/api'
    const submitUrl = `${apiBaseUrl.replace(/\/$/, '')}/feedback_submit.php`
    
    console.log('提交反馈到:', submitUrl)

    // 构造请求数据
    const requestData = {
      type,
      content,
      contact: contact || '',
      images: imageUrls,
      timestamp: Date.now()
    }

    console.log('提交数据:', requestData)

    try {
      // 发送请求
      const result = await new Promise((resolve, reject) => {
        wx.request({
          url: submitUrl,
          method: 'POST',
          header: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          data: requestData,
          success: (res) => {
            console.log('API响应:', res.data)
            if (res.statusCode === 200) {
              resolve(res.data)
            } else {
              reject(new Error(`网络请求失败，状态码: ${res.statusCode}`))
            }
          },
          fail: (err) => {
            console.error('请求失败:', err)
            reject(new Error('网络连接失败'))
          }
        })
      })

      console.log('处理结果:', result)
      
      // 处理响应
      if (result.code === 200) {
        // 先重置加载状态
        this.setData({ 
          submitting: false, 
          loading: false 
        })
        
        // 显示成功提示
        wx.showToast({
          title: '反馈提交成功',
          icon: 'success',
          duration: 2000
        })
        
        // 延迟1.5秒后返回上一页
        setTimeout(() => {
          wx.navigateBack({ delta: 1 })
        }, 1500)
      } else {
        throw new Error(result.message || '提交失败')
      }
      
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
      success: (res) => {
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