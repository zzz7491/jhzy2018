Page({
  data: {
    // 列表数据
    adminList: [],
    total: 0,
    page: 1,
    limit: 10,
    hasMore: false,
    loading: false,
    
    // 搜索条件
    searchKeyword: '',
    
    // 筛选条件
    roleFilterIndex: 0,
    statusFilterIndex: 0,
    roleOptions: [
      { label: '全部角色', value: '' },
      { label: '超级管理员', value: 'super_admin' },
      { label: '管理员', value: 'admin' },
      { label: '审核员', value: 'verifier' },
      { label: '审计员', value: 'auditor' }
    ],
    statusOptions: [
      { label: '全部状态', value: '' },
      { label: '正常', value: 'active' },
      { label: '停用', value: 'inactive' },
      { label: '冻结', value: 'suspended' }
    ],
    
    // 弹窗相关
    showModal: false,
    modalTitle: '新增',
    isEdit: false,
    isResetPwd: false,
    formData: {
      username: '',
      password: '',
      real_name: '',
      email: '',
      phone: '',
      roleIndex: 2, // 默认为审核员
      statusIndex: 0 // 默认为正常
    },
    
    // 当前编辑的管理员ID
    currentAdminId: null
  },

  onLoad() {
    this.loadAdminList()
  },

  onPullDownRefresh() {
    this.setData({ page: 1, adminList: [] })
    this.loadAdminList().then(() => {
      wx.stopPullDownRefresh()
    })
  },

  // 加载管理员列表
  async loadAdminList() {
    if (this.data.loading) return
    
    this.setData({ loading: true })
    
    try {
      const token = wx.getStorageSync('access_token')
      if (!token) {
        wx.showToast({ title: '请先登录', icon: 'none' })
        return
      }

      const params = {
        page: this.data.page,
        limit: this.data.limit,
        role: this.data.roleOptions[this.data.roleFilterIndex].value,
        status: this.data.statusOptions[this.data.statusFilterIndex].value
      }

      if (this.data.searchKeyword) {
        params.search = this.data.searchKeyword
      }

      const res = await new Promise((resolve, reject) => {
        wx.request({
          url: 'https://api.jhzyfw.com/api/admin_manage.php',
          method: 'GET',
          data: params,
          header: {
            'Authorization': 'Bearer ' + token
          },
          success: resolve,
          fail: reject
        })
      })

      if (res.data.success) {
        const list = res.data.data.list || []
        const total = res.data.data.total || 0
        const hasMore = this.data.page * this.data.limit < total
        
        this.setData({
          adminList: this.data.page === 1 ? list : [...this.data.adminList, ...list],
          total,
          hasMore,
          loading: false
        })
      } else {
        wx.showToast({ title: res.data.message || '加载失败', icon: 'none' })
        this.setData({ loading: false })
      }
    } catch (err) {
      console.error('加载管理员列表失败:', err)
      wx.showToast({ title: '网络错误', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  // 加载更多
  loadMore() {
    if (this.data.hasMore && !this.data.loading) {
      this.setData({ page: this.data.page + 1 })
      this.loadAdminList()
    }
  },

  // 搜索输入
  onSearchInput(e) {
    this.setData({ searchKeyword: e.detail.value })
  },

  // 角色筛选
  onRoleFilterChange(e) {
    this.setData({ 
      roleFilterIndex: e.detail.value,
      page: 1,
      adminList: []
    })
    this.loadAdminList()
  },

  // 状态筛选
  onStatusFilterChange(e) {
    this.setData({ 
      statusFilterIndex: e.detail.value,
      page: 1,
      adminList: []
    })
    this.loadAdminList()
  },

  // 重置筛选
  resetFilter() {
    this.setData({
      roleFilterIndex: 0,
      statusFilterIndex: 0,
      searchKeyword: '',
      page: 1,
      adminList: []
    })
    this.loadAdminList()
  },

  // 获取角色名称
  getRoleName(role) {
    const map = {
      'super_admin': '超级管理员',
      'admin': '管理员',
      'verifier': '审核员',
      'auditor': '审计员'
    }
    return map[role] || role
  },

  // 获取状态名称
  getStatusName(status) {
    const map = {
      'active': '正常',
      'inactive': '停用',
      'suspended': '冻结'
    }
    return map[status] || status
  },

  // 显示新增弹窗
  showAddModal() {
    this.setData({
      showModal: true,
      modalTitle: '新增',
      isEdit: false,
      isResetPwd: false,
      formData: {
        username: '',
        password: '',
        real_name: '',
        email: '',
        phone: '',
        roleIndex: 2,
        statusIndex: 0
      },
      currentAdminId: null
    })
  },

  // 显示编辑弹窗
  showEditModal(e) {
    const admin = e.currentTarget.dataset.admin
    const roleIndex = this.data.roleOptions.findIndex(item => item.value === admin.role)
    const statusIndex = this.data.statusOptions.findIndex(item => item.value === admin.status)
    
    this.setData({
      showModal: true,
      modalTitle: '编辑',
      isEdit: true,
      isResetPwd: false,
      formData: {
        username: admin.username,
        password: '',
        real_name: admin.real_name,
        email: admin.email || '',
        phone: admin.phone || '',
        roleIndex: roleIndex > 0 ? roleIndex : 0,
        statusIndex: statusIndex > 0 ? statusIndex : 0
      },
      currentAdminId: admin.id
    })
  },

  // 显示重置密码弹窗
  showResetPwdModal(e) {
    const { id, name } = e.currentTarget.dataset
    
    this.setData({
      showModal: true,
      modalTitle: '重置密码',
      isEdit: true,
      isResetPwd: true,
      formData: {
        username: '',
        password: '',
        real_name: name,
        email: '',
        phone: '',
        roleIndex: 2,
        statusIndex: 0
      },
      currentAdminId: id
    })
  },

  // 关闭弹窗
  closeModal() {
    this.setData({ showModal: false })
  },

  // 表单字段变更
  onFieldChange(e) {
    const { field } = e.currentTarget.dataset
    const { value } = e.detail
    
    this.setData({
      [`formData.${field}`]: value
    })
  },

  // 角色选择变更
  onRoleChange(e) {
    this.setData({
      'formData.roleIndex': e.detail.value
    })
  },

  // 状态选择变更
  onStatusChange(e) {
    this.setData({
      'formData.statusIndex': e.detail.value
    })
  },

  // 保存管理员
  async saveAdmin() {
    const { formData, isEdit, isResetPwd, currentAdminId } = this.data
    
    // 验证
    if (!isEdit || isResetPwd) {
      if (!formData.username && !isEdit) {
        wx.showToast({ title: '请输入用户名', icon: 'none' })
        return
      }
      if (!formData.password) {
        wx.showToast({ title: '请输入密码', icon: 'none' })
        return
      }
    }
    
    if (!formData.real_name) {
      wx.showToast({ title: '请输入真实姓名', icon: 'none' })
      return
    }

    // 邮箱格式验证
    if (formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      wx.showToast({ title: '邮箱格式不正确', icon: 'none' })
      return
    }

    // 手机号格式验证
    if (formData.phone && !/^1[3-9]\d{9}$/.test(formData.phone)) {
      wx.showToast({ title: '手机号格式不正确', icon: 'none' })
      return
    }

    try {
      const token = wx.getStorageSync('access_token')
      if (!token) {
        wx.showToast({ title: '请先登录', icon: 'none' })
        return
      }

      const requestData = {
        username: formData.username,
        password: formData.password,
        real_name: formData.real_name,
        email: formData.email,
        phone: formData.phone,
        role: this.data.roleOptions[formData.roleIndex].value,
        status: this.data.statusOptions[formData.statusIndex].value
      }

      if (isEdit && !isResetPwd) {
        // 编辑，只提交有修改的字段
        requestData.id = currentAdminId
        // 如果密码为空，删除password字段
        if (!requestData.password) {
          delete requestData.password
        }
      } else if (isResetPwd) {
        // 重置密码，只提交id和密码
        requestData.id = currentAdminId
        // 删除其他字段
        delete requestData.username
        delete requestData.real_name
        delete requestData.email
        delete requestData.phone
        delete requestData.role
        delete requestData.status
      }

      const res = await new Promise((resolve, reject) => {
        wx.request({
          url: 'https://api.jhzyfw.com/api/admin_manage.php',
          method: isEdit ? 'PUT' : 'POST',
          data: requestData,
          header: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          success: resolve,
          fail: reject
        })
      })

      if (res.data.success) {
        wx.showToast({ 
          title: isEdit ? (isResetPwd ? '密码重置成功' : '修改成功') : '创建成功',
          icon: 'success'
        })
        this.setData({ showModal: false, page: 1, adminList: [] })
        this.loadAdminList()
      } else {
        wx.showToast({ title: res.data.message || '操作失败', icon: 'none' })
      }
    } catch (err) {
      console.error('保存管理员失败:', err)
      wx.showToast({ title: '网络错误', icon: 'none' })
    }
  },

  // 确认删除
  confirmDelete(e) {
    const { id, name, role } = e.currentTarget.dataset
    
    wx.showModal({
      title: '提示',
      content: `确定要删除管理员 ${name} 吗？`,
      success: (res) => {
        if (res.confirm) {
          this.deleteAdmin(id, role)
        }
      }
    })
  },

  // 删除管理员
  async deleteAdmin(id, role) {
    try {
      const token = wx.getStorageSync('access_token')
      if (!token) {
        wx.showToast({ title: '请先登录', icon: 'none' })
        return
      }

      const res = await new Promise((resolve, reject) => {
        wx.request({
          url: 'https://api.jhzyfw.com/api/admin_manage.php',
          method: 'DELETE',
          data: { id, role },
          header: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          success: resolve,
          fail: reject
        })
      })

      if (res.data.success) {
        wx.showToast({ title: '删除成功', icon: 'success' })
        this.setData({ page: 1, adminList: [] })
        this.loadAdminList()
      } else {
        wx.showToast({ title: res.data.message || '删除失败', icon: 'none' })
      }
    } catch (err) {
      console.error('删除管理员失败:', err)
      wx.showToast({ title: '网络错误', icon: 'none' })
    }
  }
})