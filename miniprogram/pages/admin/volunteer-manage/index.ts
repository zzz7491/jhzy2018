// pages/admin/volunteer-manage/index.js
Page({
  data: {
    // 搜索和筛选
    searchKeyword: '',
    status: 'all',
    
    // 列表数据
    volunteerList: [],
    currentVolunteer: null,
    
    // 模态框控制
    showDetailModal: false,
    showPointsModal: false,
    showDeleteModal: false,
    
    // 积分管理
    pointsOperation: 'add',
    pointsAmount: '',
    pointsReason: '',
    
    // 删除原因
    deleteReason: '',
    
    // 分页
    page: 1,
    limit: 10,
    hasMore: true,
    loading: false,
    
    // 统计数据
    totalCount: 0,
    pendingCount: 0,
    activeCount: 0,
    disabledCount: 0,
    
    // 审核相关
    showQuickAudit: false,
    quickAuditAction: 'approve',
    quickAuditRemark: '',
    volunteerType: 'new',
    selectedCount: 0,
    
    // 导入相关
    showImportModal: false,
    importType: 'single',
    importLoading: false,
    singleForm: {
      real_name: '',
      id_card: '',
      phone: '',
      password: '123456',
      emergency_contact: '',
      emergency_phone: ''
    },
    batchFile: null
  },

  onLoad() {
    console.log('志愿者管理页面加载');
    this.loadData();
  },

  // 搜索输入
  onSearchInput(e) {
    this.setData({ searchKeyword: e.detail.value });
  },

  // 搜索确认
  onSearchConfirm() {
    this.setData({ page: 1, volunteerList: [] });
    this.loadData();
  },

  clearSearch() {
    this.setData({ searchKeyword: '', page: 1, volunteerList: [] });
    this.loadData();
  },

  // 切换状态筛选
  switchStatus(e) {
    const status = e.currentTarget.dataset.status;
    this.setData({ status, page: 1, volunteerList: [] });
    this.loadData();
  },

  // 加载志愿者数据
  loadData() {
    if (this.data.loading) return;
    
    this.setData({ loading: true });
    
    const token = wx.getStorageSync('access_token');
    if (!token) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/login-unified/index?role=admin' });
      }, 1500);
      return;
    }
    
    const params = {
      page: this.data.page,
      limit: this.data.limit
    };
    
    if (this.data.searchKeyword && this.data.searchKeyword.trim()) {
      params.search = this.data.searchKeyword.trim();
    }
    
    if (this.data.status === 'pending') {
      params.status = 'pending';
    } else if (this.data.status === 'active') {
      params.status = 'active';
    } else if (this.data.status === 'disabled') {
      params.status = 'disabled';
    } else if (this.data.status === 'rejected') {
      params.status = 'rejected';
    }
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/admin_get_volunteers_search.php',
      method: 'GET',
      header: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${token}`
      },
      data: params,
      success: (res) => {
        console.log('志愿者数据返回:', res.data);
        
        if (res.statusCode === 200 && res.data && res.data.success === true) {
          const list = res.data.data?.volunteers || [];
          
          // 处理列表数据，添加活动次数字段
          for (let i = 0; i < list.length; i++) {
            const item = list[i];
            // 活动次数 = total_activities + monthly_activity_count + consecutive_activity_count
            item.total_activities = (item.total_activities || 0) + 
                                      (item.monthly_activity_count || 0) + 
                                      (item.consecutive_activity_count || 0);
          }
          
          let pending = 0;
          let active = 0;
          let disabled = 0;
          let rejected = 0;
          
          for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (item.status == 0) {
              pending++;
            } else if (item.status == 1) {
              active++;
            } else if (item.status == 2) {
              disabled++;
            } else if (item.status == 3) {
              rejected++;
            }
          }
          
          this.setData({
            totalCount: res.data.data?.total_volunteers || list.length,
            pendingCount: pending,
            activeCount: active,
            disabledCount: disabled,
            rejectedCount: rejected
          });
          
          const newList = this.data.page === 1 ? list : this.data.volunteerList.concat(list);
          
          this.setData({
            volunteerList: newList,
            hasMore: list.length >= this.data.limit,
            loading: false,
            selectedCount: 0
          });
        } else {
          const errorMsg = res.data?.message || res.data?.msg || '加载失败';
          wx.showToast({ title: errorMsg, icon: 'none' });
          this.setData({ loading: false });
        }
      },
      fail: (error) => {
        console.error('请求失败:', error);
        wx.showToast({ title: '网络错误', icon: 'none' });
        this.setData({ loading: false });
      }
    });
  },

  // 更新统计
  updateStats(list) {
    let pending = 0;
    let active = 0;
    let disabled = 0;
    let rejected = 0;
    
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item.status == 0) {
        pending++;
      } else if (item.status == 1) {
        active++;
      } else if (item.status == 2) {
        disabled++;
      } else if (item.status == 3) {
        rejected++;
      }
    }
    
    this.setData({
      totalCount: list.length,
      pendingCount: pending,
      activeCount: active,
      disabledCount: disabled,
      rejectedCount: rejected
    });
  },

  // 查看详情
  viewDetail(e) {
    const id = e.currentTarget.dataset.id;
    
    wx.navigateTo({
      url: `/pages/admin/volunteer-detail/index?id=${id}`,
      fail: (err) => {
        console.error('跳转失败:', err);
        wx.showToast({ 
          title: '跳转失败，请检查页面路径', 
          icon: 'none',
          duration: 2000
        });
      }
    });
  },

  // 获取志愿者
  getVolunteerById(id) {
    const list = this.data.volunteerList;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id == id) {
        return list[i];
      }
    }
    return null;
  },

  // 关闭详情
  closeDetail() {
    this.setData({ 
      showDetailModal: false,
      currentVolunteer: null
    });
  },

  // 复选框变化
  onCheckboxChange(e) {
    const checkedIds = e.detail.value;
    const updatedList = [];
    const list = this.data.volunteerList;
    
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      updatedList.push({
        ...v,
        checked: checkedIds.indexOf(v.id.toString()) > -1
      });
    }
    
    this.setData({
      volunteerList: updatedList,
      selectedCount: checkedIds.length
    });
  },

  // 显示批量审核
  showBatchAudit() {
    const selected = [];
    const list = this.data.volunteerList;
    
    for (let i = 0; i < list.length; i++) {
      if (list[i].checked) {
        selected.push(list[i]);
      }
    }
    
    if (selected.length === 0) {
      wx.showToast({ title: '请先选择志愿者', icon: 'none' });
      return;
    }
    
    wx.showModal({
      title: '批量审核',
      content: `确定要批量审核 ${selected.length} 个志愿者吗？`,
      success: (res) => {
        if (res.confirm) {
          this.batchApprove();
        }
      }
    });
  },

  // 快速审核（通过）
  quickApprove(e) {
    const id = e.currentTarget.dataset.id;
    const volunteer = this.getVolunteerById(id);
    
    if (volunteer) {
      this.setData({
        currentVolunteer: volunteer,
        quickAuditAction: 'approve',
        quickAuditRemark: '',
        volunteerType: 'new',
        showQuickAudit: true
      });
    }
  },

  // 快速审核（拒绝）
  quickReject(e) {
    const id = e.currentTarget.dataset.id;
    const volunteer = this.getVolunteerById(id);
    
    if (volunteer) {
      this.setData({
        currentVolunteer: volunteer,
        quickAuditAction: 'reject',
        quickAuditRemark: '',
        showQuickAudit: true
      });
    }
  },

  // 志愿者类型选择
  onVolunteerTypeChange(e) {
    this.setData({
      volunteerType: e.detail.value
    });
  },

  // 快速启用
  quickEnable(e) {
    const id = e.currentTarget.dataset.id;
    this.toggleStatusWithId(id, 1);
  },

  // 快速禁用
  quickDisable(e) {
    const id = e.currentTarget.dataset.id;
    this.toggleStatusWithId(id, 2);
  },

  // 根据ID切换状态
  toggleStatusWithId(id, newStatus) {
    const volunteer = this.getVolunteerById(id);
    if (volunteer) {
      const action = newStatus == 1 ? '启用' : '禁用';
      const name = volunteer.real_name || '该志愿者';
      
      wx.showModal({
        title: '确认操作',
        content: `确定要${action}"${name}"的账号吗？`,
        success: (res) => {
          if (res.confirm) {
            this.updateStatus(id, newStatus);
          }
        }
      });
    }
  },

  // 更新状态
  updateStatus(id, status) {
    wx.showLoading({ title: '处理中...', mask: true });
    
    const token = wx.getStorageSync('access_token');
    wx.request({
      url: 'https://api.jhzyfw.com/api/admin_update_volunteer.php',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      data: { id, status },
      success: (res) => {
        wx.hideLoading();
        
        if (res.statusCode === 200 && res.data && res.data.code === 0) {
          wx.showToast({ title: '操作成功', icon: 'success' });
          
          const updatedList = [];
          const list = this.data.volunteerList;
          
          for (let i = 0; i < list.length; i++) {
            const v = list[i];
            if (v.id == id) {
              updatedList.push({ ...v, status });
            } else {
              updatedList.push(v);
            }
          }
          
          this.setData({ volunteerList: updatedList });
          
          if (this.data.currentVolunteer && this.data.currentVolunteer.id == id) {
            this.setData({
              'currentVolunteer.status': status
            });
          }
          
          this.updateStats(updatedList);
          
        } else {
          const errorMsg = res.data?.msg || '操作失败';
          wx.showToast({ title: errorMsg, icon: 'none' });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '网络错误', icon: 'none' });
      }
    });
  },

  // 重置密码
  resetPassword(e) {
    const id = e.currentTarget.dataset.id;
    const volunteer = this.getVolunteerById(id);
    
    if (volunteer) {
      wx.showModal({
        title: '重置密码',
        content: `确定要重置志愿者 "${volunteer.real_name}" 的密码吗？`,
        success: (res) => {
          if (res.confirm) {
            this.doResetPassword(id);
          }
        }
      });
    }
  },

  // 执行重置密码
  doResetPassword(id) {
    wx.showLoading({ title: "重置密码中...", mask: true });
    const token = wx.getStorageSync('access_token');
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/admin_reset_password.php',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': token ? `Bearer ${token}` : ''
      },
      data: { volunteer_id: id },
      success: (res) => {
        wx.hideLoading();
        
        if (res.statusCode === 200 && res.data && res.data.code === 0) {
          wx.showModal({
            title: "重置成功",
            content: `密码已重置为: ${res.data.new_password}`,
            showCancel: false
          });
        } else {
          const errorMsg = res.data?.msg || "重置失败";
          wx.showToast({ title: errorMsg, icon: "none" });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: "网络错误", icon: "none" });
      }
    });
  },

  // 关闭快速审核
  closeQuickAudit() {
    this.setData({
      showQuickAudit: false,
      quickAuditRemark: '',
      volunteerType: 'new'
    });
  },

  // 快速审核备注输入
  onQuickRemarkInput(e) {
    this.setData({ quickAuditRemark: e.detail.value });
  },

  // 提交快速审核
  submitQuickAudit() {
    if (!this.data.currentVolunteer) return;
    
    const action = this.data.quickAuditAction;
    const volunteer = this.data.currentVolunteer;
    const volunteerType = this.data.volunteerType;
    
    wx.showLoading({ title: '处理中...', mask: true });
    
    const token = wx.getStorageSync('access_token');
    wx.request({
      url: 'https://api.jhzyfw.com/api/admin/approve_volunteer.php',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      data: {
        action: action,
        volunteer_id: volunteer.id,
        notes: this.data.quickAuditRemark || (action === 'approve' ? '审核通过' : '审核拒绝'),
        volunteer_type: volunteerType
      },
      success: (res) => {
        wx.hideLoading();
        
        if (res.statusCode === 200 && res.data) {
          if (res.data.status === 'success' || res.data.code === 0) {
            wx.showToast({ 
              title: action === 'approve' ? '审核通过成功' : '审核拒绝成功', 
              icon: 'success'
            });
            
            const updatedList = [];
            const list = this.data.volunteerList;
            
            for (let i = 0; i < list.length; i++) {
              if (list[i].id !== volunteer.id) {
                updatedList.push(list[i]);
              }
            }
            
            this.setData({
              volunteerList: updatedList,
              showQuickAudit: false
            });
            
            this.updateStats(updatedList);
            
          } else {
            const errorMsg = res.data.message || res.data.msg || '审核失败';
            wx.showToast({ title: errorMsg, icon: 'none' });
          }
        } else {
          wx.showToast({ title: '请求失败', icon: 'none' });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '网络错误', icon: 'none' });
      }
    });
  },

  // 批量审核
  batchApprove() {
    const selected = [];
    const list = this.data.volunteerList;
    
    for (let i = 0; i < list.length; i++) {
      if (list[i].checked) {
        selected.push(list[i]);
      }
    }
    
    if (selected.length === 0) return;
    
    wx.showLoading({ title: `批量审核中...`, mask: true });
    
    const token = wx.getStorageSync('access_token');
    let successCount = 0;
    let failCount = 0;
    let completed = 0;
    
    for (let i = 0; i < selected.length; i++) {
      const volunteer = selected[i];
      
      wx.request({
        url: 'https://api.jhzyfw.com/api/admin/approve_volunteer.php',
        method: 'POST',
        header: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        data: {
          action: 'approve',
          volunteer_id: volunteer.id,
          notes: '批量审核通过',
          volunteer_type: 'new'
        },
        success: (res) => {
          completed++;
          
          if (res.statusCode === 200 && res.data && 
              (res.data.status === 'success' || res.data.code === 0)) {
            successCount++;
          } else {
            failCount++;
          }
          
          if (completed === selected.length) {
            wx.hideLoading();
            
            wx.showModal({
              title: '批量审核完成',
              content: `成功: ${successCount}人\n失败: ${failCount}人`,
              showCancel: false,
              success: () => {
                this.setData({ page: 1, volunteerList: [] });
                this.loadData();
              }
            });
          }
        },
        fail: () => {
          completed++;
          failCount++;
          
          if (completed === selected.length) {
            wx.hideLoading();
            
            wx.showModal({
              title: '批量审核完成',
              content: `成功: ${successCount}人\n失败: ${failCount}人`,
              showCancel: false,
              success: () => {
                this.setData({ page: 1, volunteerList: [] });
                this.loadData();
              }
            });
          }
        }
      });
    }
  },

  // ========== 导入志愿者相关方法 ==========
  
  showImport() {
    this.setData({
      showImportModal: true,
      importType: 'single',
      singleForm: {
        real_name: '',
        id_card: '',
        phone: '',
        password: '123456',
        emergency_contact: '',
        emergency_phone: ''
      },
      batchFile: null
    });
  },

  closeImportModal() {
    this.setData({ showImportModal: false });
  },

  switchImportType(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ importType: type });
  },

  onSingleInput(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    this.setData({
      [`singleForm.${field}`]: value
    });
  },

  chooseExcelFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['xlsx', 'xls', 'csv'],
      success: (res) => {
        const file = res.tempFiles[0];
        this.setData({
          batchFile: {
            name: file.name,
            path: file.path,
            size: file.size
          }
        });
      },
      fail: (err) => {
        console.error('选择文件失败:', err);
        wx.showToast({ title: '选择文件失败', icon: 'none' });
      }
    });
  },

  downloadTemplate() {
    wx.showLoading({ title: '下载中...' });
    
    wx.downloadFile({
      url: 'https://api.jhzyfw.com/templates/volunteer_import_template.csv',
      success: (res) => {
        wx.hideLoading();
        if (res.statusCode === 200) {
          wx.saveFile({
            tempFilePath: res.tempFilePath,
            success: (saveRes) => {
              wx.showModal({
                title: '下载成功',
                content: '模板已保存，请用 Excel 或 WPS 打开该文件',
                confirmText: '打开文件',
                success: (modalRes) => {
                  if (modalRes.confirm) {
                    wx.openDocument({
                      filePath: saveRes.savedFilePath,
                      success: () => {},
                      fail: () => {
                        wx.showToast({ title: '请用其他应用打开', icon: 'none' });
                      }
                    });
                  }
                }
              });
            },
            fail: () => {
              wx.showToast({ title: '保存失败', icon: 'none' });
            }
          });
        } else {
          wx.showToast({ title: '模板不存在', icon: 'none' });
        }
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('下载失败:', err);
        wx.showToast({ title: '下载失败', icon: 'none' });
      }
    });
  },

  submitImport() {
    if (this.data.importLoading) return;
    
    if (this.data.importType === 'single') {
      this.submitSingleImport();
    } else {
      this.submitBatchImport();
    }
  },

  submitSingleImport() {
    const form = this.data.singleForm;
    
    if (!form.real_name || !form.real_name.trim()) {
      wx.showToast({ title: '请填写真实姓名', icon: 'none' });
      return;
    }
    if (!form.id_card || !form.id_card.trim()) {
      wx.showToast({ title: '请填写身份证号', icon: 'none' });
      return;
    }
    if (!form.phone || !form.phone.trim()) {
      wx.showToast({ title: '请填写手机号', icon: 'none' });
      return;
    }
    if (!form.password || !form.password.trim()) {
      wx.showToast({ title: '请填写密码', icon: 'none' });
      return;
    }
    
    this.setData({ importLoading: true });
    
    const token = wx.getStorageSync('access_token');
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/admin_add_volunteer.php',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      data: {
        real_name: form.real_name.trim(),
        id_card: form.id_card.trim(),
        phone: form.phone.trim(),
        password: form.password.trim(),
        emergency_contact: form.emergency_contact,
        emergency_phone: form.emergency_phone
      },
      success: (res) => {
        this.setData({ importLoading: false });
        
        if (res.statusCode === 200 && res.data && res.data.code === 0) {
          wx.showToast({ title: '导入成功', icon: 'success' });
          this.closeImportModal();
          this.setData({ page: 1, volunteerList: [] });
          this.loadData();
        } else {
          const errorMsg = res.data?.msg || res.data?.message || '导入失败';
          wx.showToast({ title: errorMsg, icon: 'none' });
        }
      },
      fail: () => {
        this.setData({ importLoading: false });
        wx.showToast({ title: '网络错误', icon: 'none' });
      }
    });
  },

  submitBatchImport() {
    if (!this.data.batchFile) {
      wx.showToast({ title: '请先选择文件', icon: 'none' });
      return;
    }
    
    this.setData({ importLoading: true });
    
    const token = wx.getStorageSync('access_token');
    
    wx.uploadFile({
      url: 'https://api.jhzyfw.com/api/admin_import_volunteers.php',
      filePath: this.data.batchFile.path,
      name: 'file',
      header: {
        'Authorization': `Bearer ${token}`
      },
      success: (res) => {
        this.setData({ importLoading: false });
        
        try {
          const data = JSON.parse(res.data);
          if (data.code === 0) {
            wx.showModal({
              title: '导入完成',
              content: `成功: ${data.success_count || 0}人\n失败: ${data.fail_count || 0}人\n${data.message || ''}`,
              showCancel: false,
              success: () => {
                this.closeImportModal();
                this.setData({ page: 1, volunteerList: [] });
                this.loadData();
              }
            });
          } else {
            wx.showToast({ title: data.msg || '导入失败', icon: 'none' });
          }
        } catch (e) {
          console.error('解析失败:', e);
          wx.showToast({ title: '解析失败', icon: 'none' });
        }
      },
      fail: (err) => {
        this.setData({ importLoading: false });
        console.error('上传失败:', err);
        wx.showToast({ title: '上传失败', icon: 'none' });
      }
    });
  },

  // ========== 导出数据方法 ==========
  exportData() {
    const token = wx.getStorageSync('access_token');
    if (!token) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    
    wx.showLoading({ title: '生成导出文件中...', mask: true });
    
    // 构建导出参数
    const params = {};
    if (this.data.searchKeyword && this.data.searchKeyword.trim()) {
      params.search = this.data.searchKeyword.trim();
    }
    if (this.data.status !== 'all') {
      params.status = this.data.status;
    }
    
    const queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
    const url = `https://api.jhzyfw.com/api/admin_export_volunteers.php${queryString ? '?' + queryString : ''}`;
    
    wx.request({
      url: url,
      method: 'GET',
      header: {
        'Authorization': `Bearer ${token}`
      },
      responseType: 'arraybuffer',
      success: (res) => {
        wx.hideLoading();
        
        if (res.statusCode === 200) {
          // 保存文件
          const filePath = `${wx.env.USER_DATA_PATH}/志愿者数据_${Date.now()}.csv`;
          const fs = wx.getFileSystemManager();
          
          fs.writeFile({
            filePath: filePath,
            data: res.data,
            encoding: 'binary',
            success: () => {
              wx.showModal({
                title: '导出成功',
                content: '文件已生成，是否打开？',
                confirmText: '打开',
                cancelText: '取消',
                success: (modalRes) => {
                  if (modalRes.confirm) {
                    wx.openDocument({
                      filePath: filePath,
                      fileType: 'csv',
                      success: () => {
                        console.log('打开文档成功');
                      },
                      fail: (err) => {
                        console.error('打开失败:', err);
                        wx.showToast({ title: '请用其他应用打开', icon: 'none' });
                      }
                    });
                  }
                }
              });
            },
            fail: (err) => {
              console.error('保存失败:', err);
              wx.showToast({ title: '保存文件失败', icon: 'none' });
            }
          });
        } else {
          wx.showToast({ title: '导出失败', icon: 'none' });
        }
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('导出请求失败:', err);
        wx.showToast({ title: '网络错误', icon: 'none' });
      }
    });
  },

  // 获取状态文本
  getStatusText(status) {
    if (status == 0) return '待审核';
    if (status == 1) return '已启用';
    if (status == 2) return '已禁用';
    if (status == 3) return '已拒绝';
    return '未知';
  },

  // 获取状态类名
  getStatusClass(status) {
    if (status == 0) return 'pending';
    if (status == 1) return 'active';
    if (status == 2) return 'disabled';
    if (status == 3) return 'rejected';
    return '';
  },

  // 加载更多
  loadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 });
    this.loadData();
  },

  // 格式化时间
  formatTime(time) {
    if (!time) return '';
    return time.substring(0, 10);
  }
});