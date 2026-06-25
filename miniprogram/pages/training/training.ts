// pages/training/training.js
const app = getApp();

Page({
  data: {
    isLoggedIn: false,
    isSeniorMode: false,
    userInfo: null,
    
    // 培训数据
    categories: [
      { id: 0, name: '全部' },
      { id: 1, name: '必修课程' },
      { id: 2, name: '选修课程' }
    ],
    activeCategory: 0,
    difficultyList: [
      { id: 0, name: '全部难度' },
      { id: 1, name: '初级' },
      { id: 2, name: '中级' },
      { id: 3, name: '高级' }
    ],
    activeDifficulty: 0,
    courses: [],
    hotCourses: [],
    currentCourse: null,
    
    // 搜索和分页
    searchValue: '',
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false,
    
    // 用户信息
    userPoints: 0,
    requiredCompleted: false,
    electiveCompleted: false,
    learningStats: {
      enrolledCount: 0,
      completedCount: 0,
      inProgressCount: 0,
      totalHours: 0
    },
    
    // 模态框控制
    showCourseDetail: false,
    
    // 震动反馈
    vibrationEnabled: true
  },

  onLoad(options) {
    console.log('培训学习页面加载');
    this.initVibration();
    this.checkLoginStatus();
    this.initDisplayMode();
    this.loadData();
  },

  onShow() {
    console.log('培训学习页面显示');
    if (this.data.isLoggedIn) {
      this.loadUserPoints();
      this.loadLearningStats();
      this.checkCourseCompletion();
    }
  },

  onPullDownRefresh() {
    this.refreshData();
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadMoreCourses();
    }
  },

  initVibration() {
    try {
      const setting = wx.getStorageSync('vibrationSetting');
      if (setting) {
        this.setData({ vibrationEnabled: setting.enabled !== false });
      }
    } catch (e) {
      console.log('震动设置初始化失败:', e);
    }
  },

  vibrate(type = 'light') {
    if (!this.data.vibrationEnabled) return;
    if (wx.vibrateShort) {
      wx.vibrateShort({ type: 'medium' });
    }
  },

  initDisplayMode() {
    const displayMode = wx.getStorageSync('displayMode') || 'normal';
    this.setData({ isSeniorMode: displayMode === 'senior' });
  },

  checkLoginStatus() {
    try {
      const userInfo = wx.getStorageSync('userInfo');
      const token = wx.getStorageSync('access_token');
      const isLoggedIn = wx.getStorageSync('isLoggedIn');
      const isValidLogin = isLoggedIn && token && userInfo && userInfo.id;
      
      this.setData({
        userInfo: userInfo || null,
        isLoggedIn: !!isValidLogin
      });
      
      return !!isValidLogin;
    } catch (error) {
      console.error('检查登录状态失败:', error);
      this.setData({ isLoggedIn: false });
      return false;
    }
  },

  loadData() {
    this.loadCourses(true);
    this.loadHotCourses();
  },

  refreshData() {
    this.setData({ page: 1, courses: [], hasMore: true });
    this.loadCourses(true);
    if (this.data.isLoggedIn) {
      this.loadUserPoints();
      this.loadLearningStats();
      this.checkCourseCompletion();
    }
    setTimeout(() => {
      wx.stopPullDownRefresh();
    }, 500);
  },

  loadHotCourses() {
    const token = wx.getStorageSync('access_token');
    wx.request({
      url: 'https://api.jhzyfw.com/api/training/courses.php',
      method: 'GET',
      data: { token: token, limit: 5 },
      success: (res) => {
        if (res.data.code === 0 && res.data.data) {
          this.setData({ hotCourses: res.data.data.slice(0, 5) });
        }
      },
      fail: (err) => {
        console.error('加载热门课程失败:', err);
      }
    });
  },

  loadCourses(refresh = false) {
    if (this.data.loading) return Promise.resolve();
    
    if (refresh) {
      this.setData({ page: 1, courses: [], hasMore: true });
    }
    
    this.setData({ loading: true });
    
    const token = wx.getStorageSync('access_token');
    const params = {
      token: token,
      page: this.data.page,
      limit: this.data.pageSize
    };
    
    // 分类筛选
    if (this.data.activeCategory === 1) {
      params.is_required = 1;
    } else if (this.data.activeCategory === 2) {
      params.is_required = 0;
    }
    
    // 难度筛选
    if (this.data.activeDifficulty > 0) {
      params.difficulty = this.data.activeDifficulty;
    }
    
    // 搜索
    if (this.data.searchValue) {
      params.search = this.data.searchValue;
    }
    
    return new Promise((resolve) => {
      wx.request({
        url: 'https://api.jhzyfw.com/api/training/courses.php',
        method: 'GET',
        data: params,
        success: (res) => {
          if (res.data.code === 0 && res.data.data) {
            let newCourses = res.data.data;
            
            if (this.data.isLoggedIn) {
              newCourses = newCourses.map(course => ({
                ...course,
                is_enrolled: course.is_enrolled || false,
                is_completed: course.is_completed || false
              }));
            }
            
            const courses = this.data.page === 1 ? newCourses : [...this.data.courses, ...newCourses];
            
            this.setData({
              courses: courses,
              hasMore: newCourses.length >= this.data.pageSize,
              loading: false
            });
          } else {
            this.setData({ loading: false });
          }
          resolve();
        },
        fail: (err) => {
          console.error('加载课程失败:', err);
          this.setData({ loading: false });
          resolve();
        }
      });
    });
  },

  loadMoreCourses() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 });
    this.loadCourses();
  },

  loadUserPoints() {
    const token = wx.getStorageSync('access_token');
    if (!token) return;
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/points_query.php',
      method: 'GET',
      data: { token: token },
      success: (res) => {
        if (res.data.code === 0 && res.data.data) {
          this.setData({ userPoints: res.data.data.current_points || 0 });
        }
      }
    });
  },

  loadLearningStats() {
    const token = wx.getStorageSync('access_token');
    if (!token) return;
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/training/user_stats.php',
      method: 'GET',
      data: { token: token },
      success: (res) => {
        if (res.data.code === 0 && res.data.data) {
          this.setData({ learningStats: res.data.data });
        }
      }
    });
  },

  checkCourseCompletion() {
    const token = wx.getStorageSync('access_token');
    if (!token) return;
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/training/check_completion.php',
      method: 'GET',
      data: { token: token },
      success: (res) => {
        if (res.data.code === 0 && res.data.data) {
          this.setData({
            requiredCompleted: res.data.data.required_completed,
            electiveCompleted: res.data.data.elective_completed
          });
        }
      },
      fail: (err) => {
        console.error('检查课程完成状态失败:', err);
      }
    });
  },

  goBack() {
    this.vibrate('light');
    wx.navigateBack();
  },

  switchDisplayMode() {
    const currentMode = wx.getStorageSync('displayMode') || 'normal';
    const newMode = currentMode === 'normal' ? 'senior' : 'normal';
    wx.setStorageSync('displayMode', newMode);
    this.setData({ isSeniorMode: newMode === 'senior' });
    this.vibrate('light');
    wx.showToast({ title: `已切换到${newMode === 'senior' ? '大字版' : '普通版'}`, icon: 'success' });
  },

  goToRegister() {
    wx.navigateTo({ url: '/pages/login-unified/index' });
  },

  onSearchInput(e) {
    this.setData({ searchValue: e.detail.value });
  },

  onSearchConfirm() {
    this.vibrate('light');
    this.setData({ page: 1, courses: [], hasMore: true });
    this.loadCourses(true);
  },

  onClearSearch() {
    this.setData({ searchValue: '', page: 1, courses: [], hasMore: true });
    this.loadCourses(true);
  },

  onCategoryChange(e) {
    const categoryId = e.currentTarget.dataset.id;
    this.vibrate('light');
    this.setData({
      activeCategory: categoryId,
      page: 1,
      courses: [],
      hasMore: true
    });
    this.loadCourses(true);
  },

  onDifficultyChange(e) {
    const difficultyId = e.currentTarget.dataset.id;
    this.vibrate('light');
    this.setData({
      activeDifficulty: difficultyId,
      page: 1,
      courses: [],
      hasMore: true
    });
    this.loadCourses(true);
  },

  goToCourseDetail(e) {
    const courseId = e.currentTarget.dataset.id;
    const course = this.data.courses.find(c => c.id == courseId) || this.data.hotCourses.find(c => c.id == courseId);
    if (course) {
      this.vibrate('light');
      this.setData({ currentCourse: course, showCourseDetail: true });
    }
  },

  closeCourseDetail() {
    this.setData({ showCourseDetail: false });
  },

  handleCourseAction(e) {
    const course = e.currentTarget.dataset.course || this.data.currentCourse;
    if (!course) return;
    
    this.vibrate('light');
    
    if (!this.data.isLoggedIn) {
      wx.navigateTo({ url: '/pages/login-unified/index' });
      return;
    }
    
    if (course.is_completed) {
      wx.showToast({ title: '已完成', icon: 'none' });
      return;
    }
    
    if (course.is_enrolled) {
      wx.navigateTo({ url: `/pages/training/chapter/chapter?course_id=${course.id}` });
    } else {
      wx.showLoading({ title: '报名中...' });
      this.enrollCourse(course.id);
    }
  },

  enrollCourse(courseId) {
    const token = wx.getStorageSync('access_token');
    wx.request({
      url: 'https://api.jhzyfw.com/api/training/enroll.php',
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: { token: token, course_id: courseId },
      success: (res) => {
        wx.hideLoading();
        if (res.data.code === 0) {
          wx.showToast({ title: '报名成功', icon: 'success' });
          this.refreshData();
        } else {
          wx.showToast({ title: res.data.msg || '报名失败', icon: 'none' });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '网络错误', icon: 'none' });
      }
    });
  },

  // 去考试 - 检查是否已有证书 -> 若无证书则获取当前有效场次并跳转
  goToExamCenter() {
    this.vibrate('light');
    if (!this.data.requiredCompleted || !this.data.electiveCompleted) {
      wx.showToast({ title: '请先完成所有课程', icon: 'none' });
      return;
    }
    
    const token = wx.getStorageSync('access_token');
    if (!token) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    
    wx.showLoading({ title: '检查中...', mask: true });
    
    // 第一步：检查是否已有培训证书
    wx.request({
      url: 'https://api.jhzyfw.com/api/check_training_certificate.php',
      method: 'GET',
      data: { token: token },
      success: (certRes) => {
        if (certRes.data.code === 0 && certRes.data.data) {
          if (certRes.data.data.has_certificate === true) {
            wx.hideLoading();
            wx.showModal({
              title: '提示',
              content: '您已取得培训证书，无需重复考试',
              showCancel: false,
              confirmText: '知道了'
            });
            return;
          }
          
          // 第二步：无证书，获取当前有效考试场次
          this.getActiveExamSession();
        } else {
          wx.hideLoading();
          wx.showToast({ title: certRes.data.msg || '检查证书失败', icon: 'none' });
        }
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('检查证书失败:', err);
        wx.showToast({ title: '网络错误，请稍后重试', icon: 'none' });
      }
    });
  },
  
  // 获取当前有效考试场次并跳转
  getActiveExamSession() {
    wx.request({
      url: 'https://api.jhzyfw.com/exam/api_get_active_session.php',
      method: 'GET',
      success: (res) => {
        wx.hideLoading();
        if (res.data.code === 0 && res.data.data && res.data.data.session_id) {
          const sessionId = res.data.data.session_id;
          const examUrl = `https://exam.jhzyfw.com/?session=${sessionId}`;
          wx.navigateTo({ 
            url: '/pages/webview/webview?url=' + encodeURIComponent(examUrl)
          });
        } else {
          wx.showToast({ title: '当前暂无有效考试场次', icon: 'none' });
        }
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('获取考试场次失败:', err);
        wx.showToast({ title: '获取考试场次失败，请稍后重试', icon: 'none' });
      }
    });
  },

  goToMyLearning() {
    this.vibrate('light');
    wx.navigateTo({ url: '/pages/training/my-learning/my-learning' });
  },

  goToCertificates() {
    this.vibrate('light');
    wx.navigateTo({ url: '/pages/certificates/certificates' });
  },

  viewTrainingRules() {
    this.vibrate('light');
    wx.showModal({
      title: '培训规则',
      content: '1. 新志愿者必须完成必修课程\n2. 需完成至少1门选修课程\n3. 完成所有课程后方可参加考试\n4. 考试合格（90分）获得证书\n5. 获得证书后方可报名活动\n6. 保险须通过机构指定服务商购买（联系工作号）\n7. 信用时长无法补录，属实情况可补录荣誉时长',
      showCancel: false
    });
  },

  shareCourse() {
    this.vibrate('light');
    wx.showToast({ title: '分享功能开发中', icon: 'none' });
  },

  refreshCourses() {
    this.refreshData();
  },

  viewMoreHotCourses() {
    this.setData({ activeCategory: 0, page: 1, courses: [], hasMore: true });
    this.loadCourses(true);
  },

  onShareAppMessage() {
    return { title: '志愿者培训学习', path: 'pages/training/training', imageUrl: '/images/share-default.jpg' };
  },

  onShareTimeline() {
    return { title: '志愿者培训学习', imageUrl: '/images/share-default.jpg' };
  }
});