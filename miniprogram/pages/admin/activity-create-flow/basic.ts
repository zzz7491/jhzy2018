Page({
  data: {
    formData: {
      title: '',
      category: '',
      description: '',
      cover_image: '',
      location: '',
      location_lat: 0,
      location_lng: 0,
      recurrence_pattern: 'once',
      recurrence_days: [] as string[],
      recurrence_start_date: '',
      recurrence_end_date: '',
      activity_date: '',
      start_time: '',
      end_time: '',
      recruit_unit: '嘉兴市嘉禾志愿服务中心',
      contact_person: '',
      contact_phone: '',
      max_participants: '',
      is_recurring: false,
      enable_certificate: false
    },
    categories: [] as any[],
    categoryIndex: -1,
    currentDate: '',
    minDate: new Date().getTime(),
    recurrenceOptions: ['单次活动', '每天', '每周', '每月'],
    recurrenceIndex: 0,
    
    // 图片相关
    existingImages: [] as any[],
    showImagePicker: false,
    showImageGallery: false,
    
    loading: false,
    submitting: false
  },

  onLoad(options) {
    this.checkAdminLogin()
    this.loadCategories()
    this.loadExistingImages()
    this.initDates()

    // 接收复制传来的老活动ID
    if (options && options.copy_id) {
      this.loadActivityTemplate(options.copy_id)
    }
  },

  checkAdminLogin() {
    const adminInfo = wx.getStorageSync('adminInfo')
    const token = wx.getStorageSync('access_token')
    if (!adminInfo || !token) {
      wx.showToast({ title: '请先登录', icon: 'error' })
      setTimeout(() => wx.redirectTo({ url: '/pages/login-unified/index?role=admin' }), 1500)
      return false
    }
    return true
  },

  initDates() {
    const now = new Date()
    const today = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`
    const nextWeek = new Date(now)
    nextWeek.setDate(now.getDate() + 7)
    const nextWeekDate = `${nextWeek.getFullYear()}-${(nextWeek.getMonth() + 1).toString().padStart(2, '0')}-${nextWeek.getDate().toString().padStart(2, '0')}`
    
    this.setData({
      currentDate: today,
      'formData.activity_date': today,
      'formData.recurrence_start_date': today,
      'formData.recurrence_end_date': nextWeekDate
    })
  },

  loadCategories() {
    const token = wx.getStorageSync('access_token')
    wx.request({
      url: 'https://api.jhzyfw.com/api/get_activity_categories.php',
      method: 'GET',
      header: { 'Authorization': `Bearer ${token}` },
      success: (res: any) => {
        if (res.data.success === true) {
          this.setData({ categories: res.data.data || [] })
        }
      }
    })
  },

  loadExistingImages() {
    const token = wx.getStorageSync('access_token')
    wx.request({
      url: 'https://api.jhzyfw.com/api/get_activity_images.php',
      method: 'GET',
      header: { 'Authorization': `Bearer ${token}` },
      success: (res: any) => {
        if (res.data.success === true) {
          this.setData({ existingImages: res.data.data || [] })
        }
      }
    })
  },

  loadActivityTemplate(id) {
    const token = wx.getStorageSync('access_token');
    wx.showLoading({ title: '加载模板中...', mask: true });
    
    wx.request({
      url: `https://api.jhzyfw.com/api/activity_manage.php?id=${id}`,
      method: 'GET',
      header: { 'Authorization': `Bearer ${token}` },
      success: (res: any) => {
        wx.hideLoading();
        if (res.data.code === 0 && res.data.data) {
          const activity = res.data.data;
          let cIndex = -1;
          if (this.data.categories.length > 0) {
            cIndex = this.data.categories.findIndex(c => c.id == activity.category || c.name == activity.category);
          }
          this.setData({
            'formData.title': activity.title + ' (复制)',
            'formData.category': activity.category || '',
            'formData.description': activity.description || '',
            'formData.cover_image': activity.cover_image || '',
            'formData.location': activity.location || '',
            'formData.location_lat': activity.location_lat || 0,
            'formData.location_lng': activity.location_lng || 0,
            'formData.start_time': activity.start_time || '',
            'formData.end_time': activity.end_time || '',
            'formData.recruit_unit': activity.recruit_unit || '嘉兴市嘉禾志愿服务中心',
            'formData.contact_person': activity.contact_person || '',
            'formData.contact_phone': activity.contact_phone || '',
            'formData.max_participants': activity.max_participants || '',
            'formData.enable_certificate': activity.enable_certificate === 1 || activity.enable_certificate === true,
            categoryIndex: cIndex >= 0 ? cIndex : -1
          });
          wx.showToast({ title: '模板加载成功', icon: 'success' });
        }
      }
    });
  },

  showImagePickerDialog() { this.setData({ showImagePicker: true }) },
  hideImagePicker() { this.setData({ showImagePicker: false }) },

  chooseFromExisting() {
    if (this.data.existingImages.length === 0) return wx.showToast({ title: '暂无可用图片', icon: 'none' })
    this.setData({ showImageGallery: true, showImagePicker: false })
  },
  closeImageGallery() { this.setData({ showImageGallery: false }) },
  selectGalleryImage(e: any) {
    this.setData({ 'formData.cover_image': e.currentTarget.dataset.url, showImageGallery: false })
  },

  uploadNewImage() {
    const token = wx.getStorageSync('access_token')
    wx.chooseImage({
      count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'],
      success: (res) => {
        wx.showLoading({ title: '上传中...', mask: true })
        wx.uploadFile({
          url: 'https://api.jhzyfw.com/api/admin_upload_activity_image.php',
          filePath: res.tempFilePaths[0], name: 'image',
          header: { 'Authorization': `Bearer ${token}` },
          success: (uploadRes: any) => {
            wx.hideLoading()
            try {
              const response = JSON.parse(uploadRes.data)
              if (response.code === 200) {
                this.setData({ 'formData.cover_image': response.data?.url || response.data, showImagePicker: false })
                this.loadExistingImages()
              }
            } catch (e) {}
          }
        })
      }
    })
  },

  onInput(e: any) { this.setData({ [`formData.${e.currentTarget.dataset.field}`]: e.detail.value }) },
  onCategoryChange(e: any) { this.setData({ categoryIndex: e.detail.value, 'formData.category': this.data.categories[e.detail.value].id.toString() }) },
  
  // 核心切换：切换周期状态
  toggleRecurring(e: any) { 
    const isRecurring = e.detail.value;
    const patterns = ['once', 'daily', 'weekly', 'monthly'];
    this.setData({ 
      'formData.is_recurring': isRecurring,
      // 如果关闭周期，强行设回 once
      'formData.recurrence_pattern': isRecurring ? patterns[this.data.recurrenceIndex] : 'once'
    }) 
  },
  
  onRecurrenceChange(e: any) { const patterns = ['once', 'daily', 'weekly', 'monthly']; this.setData({ recurrenceIndex: e.detail.value, 'formData.recurrence_pattern': patterns[e.detail.value] }) },
  onRecurrenceStartDateChange(e: any) { this.setData({ 'formData.recurrence_start_date': e.detail.value }) },
  onRecurrenceEndDateChange(e: any) { this.setData({ 'formData.recurrence_end_date': e.detail.value }) },
  onDateChange(e: any) { this.setData({ 'formData.activity_date': e.detail.value }) },
  onStartTimeChange(e: any) { this.setData({ 'formData.start_time': e.detail.value }) },
  onEndTimeChange(e: any) { this.setData({ 'formData.end_time': e.detail.value }) },
  onCertificateChange(e: any) { this.setData({ 'formData.enable_certificate': e.detail.value }) },
  chooseLocation() { wx.chooseLocation({ success: (res) => { this.setData({ 'formData.location': res.address, 'formData.location_lat': res.latitude, 'formData.location_lng': res.longitude }) } }) },
  
  // 核心修复：终极提交逻辑
  onSubmit() {
    const data = this.data.formData;
    
    // 1. 通用基础验证
    if (!data.title) return wx.showToast({ title: '请输入标题', icon: 'none' })
    if (!data.cover_image) return wx.showToast({ title: '请选择封面', icon: 'none' })
    if (!data.location) return wx.showToast({ title: '请选择地点', icon: 'none' })
    if (!data.start_time || !data.end_time) return wx.showToast({ title: '请选择完整时间', icon: 'none' })

    // 2. 深度克隆数据，准备发给后端
    let postData = { ...data };

    // 3. 隔离处理单次与周期数据
    if (!data.is_recurring) {
      // 模式A：单次活动
      if (!data.activity_date) return wx.showToast({ title: '请选择活动日期', icon: 'none' })
      
      // 精准合并日期和时间
      postData.start_time = `${data.activity_date} ${data.start_time}:00`;
      postData.end_time = `${data.activity_date} ${data.end_time}:00`;
      
      // 抹除多余的周期字段，保持后端清爽
      postData.recurrence_pattern = 'once';
      postData.recurrence_start_date = '';
      postData.recurrence_end_date = '';
      postData.recurrence_days = [];
    } else {
      // 模式B：周期排班活动
      if (!data.recurrence_start_date || !data.recurrence_end_date) return wx.showToast({ title: '请选择起止日期', icon: 'none' })
      
      // 周期活动只传纯时间段（如 08:00:00）
      postData.start_time = `${data.start_time}:00`;
      postData.end_time = `${data.end_time}:00`;
      
      // 抹除单次活动的日期，防止后端混乱
      postData.activity_date = '';
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中...', mask: true })
    
    const token = wx.getStorageSync('access_token')
    wx.request({
      url: 'https://api.jhzyfw.com/api/simple_create_activity.php',
      method: 'POST',
      header: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      data: postData,
      success: (res: any) => {
        wx.hideLoading()
        if (res.data.success) {
          wx.showToast({ title: '创建成功', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 1500)
        } else {
          wx.showToast({ title: res.data.message || '创建失败', icon: 'none' })
        }
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '网络错误', icon: 'none' })
      },
      complete: () => { this.setData({ submitting: false }) }
    })
  }
})