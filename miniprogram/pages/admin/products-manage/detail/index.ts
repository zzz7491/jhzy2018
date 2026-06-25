const API_BASE = 'https://api.jhzyfw.com/api';

Page({
  data: {
    isEdit: false,
    productId: null as number | null,
    form: {
      product_name: '',
      description: '',
      category_name: '',
      source_type: '',
      source_name: '',
      points_required: '',
      stock: '',
      image_url: '',
      status: 'available',
      sold_out_at: '',
      limit_per_user: '0'  // 新增：每人限兑数量
    } as any,
    sourceTypeOptions: ['采购', '个人捐赠', '单位捐赠'],
    sourceTypeValues: ['purchase', 'personal', 'company'],
    sourceTypeIndex: 0
  },

  onLoad(options: any) {
    if (options.id) {
      this.setData({ isEdit: true, productId: parseInt(options.id) });
      this.loadProduct();
      wx.setNavigationBarTitle({ title: '编辑商品' });
    } else {
      wx.setNavigationBarTitle({ title: '新增商品' });
    }
  },

  loadProduct() {
    const token = wx.getStorageSync('access_token');
    wx.request({
      url: `${API_BASE}/admin_products.php?product_id=${this.data.productId}`,
      header: { 'Authorization': `Bearer ${token}` },
      success: (res: any) => {
        if (res.data.success) {
          const p = res.data.data;
          let sourceTypeIndex = 0;
          if (p.source_type) {
            sourceTypeIndex = this.data.sourceTypeValues.indexOf(p.source_type);
            if (sourceTypeIndex < 0) sourceTypeIndex = 0;
          }
          this.setData({
            sourceTypeIndex,
            form: {
              product_name: p.product_name || '',
              description: p.description || '',
              category_name: p.category_name || '',
              source_type: p.source_type || '',
              source_name: p.source_name || '',
              points_required: String(p.points_required || ''),
              stock: String(p.stock || ''),
              image_url: p.image_url || '',
              status: p.status || 'available',
              sold_out_at: p.sold_out_at || '',
              limit_per_user: String(p.limit_per_user || '0')  // 新增
            }
          });
        }
      }
    });
  },

  onInput(e: any) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`form.${field}`]: e.detail.value
    });
  },

  onSourceTypeChange(e: any) {
    const idx = parseInt(e.detail.value);
    this.setData({
      sourceTypeIndex: idx,
      'form.source_type': this.data.sourceTypeValues[idx],
      'form.source_name': '' // 切换类型时清空名称
    });
  },

  onStatusChange(e: any) {
    this.setData({
      'form.status': e.detail.value ? 'available' : 'sold_out'
    });
  },

  uploadImage() {
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFilePaths[0];
        const token = wx.getStorageSync('access_token');
        
        wx.showLoading({ title: '上传中...' });
        wx.uploadFile({
          url: `${API_BASE}/admin_upload_product_image.php`,
          filePath: tempFilePath,
          name: 'image',
          header: { 'Authorization': `Bearer ${token}` },
          success: (uploadRes: any) => {
            const data = JSON.parse(uploadRes.data);
            if (data.success) {
              this.setData({ 'form.image_url': data.data.image_url });
              wx.showToast({ title: '上传成功', icon: 'success' });
            } else {
              wx.showToast({ title: data.message || '上传失败', icon: 'none' });
            }
          },
          fail: () => {
            wx.showToast({ title: '上传失败', icon: 'none' });
          },
          complete: () => wx.hideLoading()
        });
      }
    });
  },

  submitForm() {
    const { form, isEdit } = this.data;
    
    if (!form.product_name.trim()) {
      wx.showToast({ title: '请输入商品名称', icon: 'none' });
      return;
    }
    if (!form.points_required || parseInt(form.points_required) <= 0) {
      wx.showToast({ title: '请输入有效积分', icon: 'none' });
      return;
    }
    if (form.stock === '' || parseInt(form.stock) < 0) {
      wx.showToast({ title: '请输入有效库存', icon: 'none' });
      return;
    }
    if (form.source_type === 'personal' && !form.source_name.trim()) {
      wx.showToast({ title: '请输入捐赠人姓名', icon: 'none' });
      return;
    }
    if (form.source_type === 'company' && !form.source_name.trim()) {
      wx.showToast({ title: '请输入捐赠单位名称', icon: 'none' });
      return;
    }

    const token = wx.getStorageSync('access_token');
    const url = `${API_BASE}/admin_products.php`;
    const method = isEdit ? 'PUT' : 'POST';
    
    const data: any = {
      product_name: form.product_name.trim(),
      description: form.description.trim(),
      category_name: form.category_name.trim(),
      source: (this.data.sourceTypeOptions[this.data.sourceTypeIndex] + (form.source_name ? '：' + form.source_name : '')),
      source_type: form.source_type,
      source_name: form.source_name.trim(),
      points_required: parseInt(form.points_required),
      stock: parseInt(form.stock),
      image_url: form.image_url,
      status: form.status,
      limit_per_user: parseInt(form.limit_per_user) || 0  // 新增
    };
    
    if (isEdit) {
      data.product_id = this.data.productId;
    }

    wx.request({
      url,
      method,
      header: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      data,
      success: (res: any) => {
        if (res.data.success) {
          wx.setStorageSync('productNeedRefresh', true);
          wx.showToast({ title: isEdit ? '保存成功' : '添加成功', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 1500);
        } else {
          wx.showToast({ title: res.data.message || '操作失败', icon: 'none' });
        }
      }
    });
  },

  deleteProduct() {
    wx.showModal({
      title: '确认删除',
      content: '删除后不可恢复，确定删除该商品吗？',
      success: (res) => {
        if (res.confirm) {
          const token = wx.getStorageSync('access_token');
          wx.request({
            url: `${API_BASE}/admin_products.php`,
            method: 'DELETE',
            header: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            data: { product_id: this.data.productId },
            success: (res: any) => {
              if (res.data.success) {
                wx.setStorageSync('productNeedRefresh', true);
                wx.showToast({ title: '已删除', icon: 'success' });
                setTimeout(() => wx.navigateBack(), 1500);
              } else {
                wx.showToast({ title: res.data.message, icon: 'none' });
              }
            }
          });
        }
      }
    });
  }
});