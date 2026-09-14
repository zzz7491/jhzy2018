// home_v2_ui_contract.mjs
// P1-A.2 智能志愿型首页结构静态契约（仅首页，不改其他文件）
// 适配新的 SMART HERO + AI 入口 + 为你推荐 + 三大智能能力 + 我的公益足迹 结构
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..'); // miniprogram/
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const indexWxml = read(`${ROOT}/pages/index/index.wxml`);
const indexScss = read(`${ROOT}/pages/index/index.scss`);
const indexTs = read(`${ROOT}/pages/index/index.ts`);

let passed = 0;
let failed = 0;
const fails = [];
function check(name, cond) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; fails.push(name); console.log(`  FAIL  ${name}`); }
}

// 方法级分块：2 空格缩进的 "  }," 为 Page({}) 方法边界
function blockOf(src, name) {
  const blocks = src.split(/\n  \},\n/);
  return blocks.find((b) => new RegExp('\\n  ' + name + '\\(').test(b)) || '';
}
const goToActivityDetail = blockOf(indexTs, 'goToActivityDetail');
const goToAllActivities = blockOf(indexTs, 'goToAllActivities');

console.log('# home_v2_ui_contract (P1-A.2 SMART VOLUNTEER)');

// --- 游客浏览保护（P0-B）：首页仍绑定的公开方法不得重新加登录门禁 ---
check('游客浏览 goToActivityDetail 未重新加登录门禁', !goToActivityDetail.includes('showLoginModal'));
check('游客浏览 goToAllActivities 未重新加登录门禁', !goToAllActivities.includes('showLoginModal'));

// 1. SMART HERO 存在
check('SMART_HERO_PRESENT (主标题 让 AI 陪你一起做公益)',
  indexWxml.includes('让 AI 陪你一起做公益'));
check('SMART_HERO_PRESENT (问候语 你好)', indexWxml.includes('你好'));
check('SMART_HERO_PRESENT (辅助文案 更合适的活动)', indexWxml.includes('更合适的活动'));

// 2. AI 智能问答入口存在
check('AI_ENTRY_PRESENT (引导问句 试试问我)', indexWxml.includes('试试问我'));
check('AI_ENTRY_PRESENT (点击进入嘉禾 AI goToAi)', indexWxml.includes('bindtap="goToAi"'));

// 3. 为你推荐（真实 hotActivities）存在
check('RECOMMENDED_ACTIVITY_PRESENT (section 为你推荐)', indexWxml.includes('为你推荐'));
check('RECOMMENDED_ACTIVITY_PRESENT (绑定真实数据 hotActivities)', indexWxml.includes('hotActivities'));
check('RECOMMENDED_ACTIVITY_PRESENT (详情跳转 goToActivityDetail)', indexWxml.includes('bindtap="goToActivityDetail"'));

// 4. 三大智能能力固定为 3 个真实页面入口
check('SMART_CAPABILITY_COUNT = 3 (智能找活动→goToAllActivities)',
  indexWxml.includes('智能找活动') && indexWxml.includes('bindtap="goToAllActivities"'));
check('SMART_FIND_ACTIVITY = YES', indexWxml.includes('智能找活动'));
check('VOLUNTEER_ASSISTANT = YES (志愿助手→goToAi)',
  indexWxml.includes('志愿助手') && indexWxml.includes('bindtap="goToAi"'));
check('GROWTH_PLAN = YES (成长计划→goToGrowth)',
  indexWxml.includes('成长计划') && indexWxml.includes('bindtap="goToGrowth"'));
// 确认三大智能能力恰为 3 个独立入口（每个 .cap 块一个，无第七中心等额外入口）
const capBlockCount = (indexWxml.match(/<view class="cap"/g) || []).length;
check('SMART_CAPABILITY_COUNT = 3 (首页恰为 3 个智能能力入口块)', capBlockCount === 3);

// 5. 我的公益足迹存在
check('PUBLIC_WELFARE_FOOTPRINT = YES (我的公益足迹)', indexWxml.includes('我的公益足迹'));
check('PUBLIC_WELFARE_FOOTPRINT (登录展示真实数据 totalHours/totalActivities)',
  indexWxml.includes('stats.totalHours') && indexWxml.includes('stats.totalActivities'));
check('PUBLIC_WELFARE_FOOTPRINT (游客显示轻量引导，不伪造数字)',
  indexWxml.includes('登录后查看你的公益足迹'));

// 6. 首页不再承担 Sitemap：移除“更多服务”与七中心首页列表
check('MORE_SERVICES_SECTION = NO (无“更多服务”)', !indexWxml.includes('更多服务'));
const sevenCenterLabels = ['智慧活动', '志愿协作', '志愿成长', '学习培训', '嘉禾AI', '志愿团队', '公益社区'];
const centerPlain = indexWxml.replace(/\s/g, '');
const centerPresent = sevenCenterLabels.some((l) => centerPlain.includes(l.replace(/\s/g, '')));
check('SEVEN_CENTER_HOME_LIST = NO (七中心首页列表已移除)', !centerPresent);

// 7. 真实数据，无伪造推荐逻辑
check('REAL_DATA_ONLY (无声称的 AI/位置/画像推荐文案)', !/根据位置和服务记录推荐|为你智能推荐|兴趣画像/.test(indexWxml));
check('FAKE_RECOMMENDATION_LOGIC = NO (无伪造 qualification/APPROVED)', !/已为您匹配|智能匹配成功/.test(indexWxml));

// 8. 首页不含 admin/analytics 入口
check('首页不含 admin/analytics 入口', !/admin\/analytics|pages\/admin/.test(indexWxml));

// 9. 无 emoji 主图标 / 无 inline style / 无 legacy 紫色
const emojiCount = (indexWxml.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F02F}]/gu) || []).length;
check('EMOJI_PRIMARY_ICONS = 0', emojiCount === 0);
check('INLINE_STYLE = 0 (无 style= 补丁)', (indexWxml.match(/style="/g) || []).length === 0);
check('LEGACY_PURPLE = 0 (scss 无 #667eea)', !indexScss.includes('#667eea'));
check('LEGACY_PURPLE = 0 (scss 无 #764ba2)', !indexScss.includes('#764ba2'));

// 10. 多团队动态身份 + 平台身份保留
check('TEAM_BRANDING_DYNAMIC (读取 storage.activeTeamName)', indexTs.includes("getStorageSync('activeTeamName')"));
check('TEAM_BRANDING_DYNAMIC (wxml 使用 {{teamName}})', indexWxml.includes('{{teamName}}'));
check('TEAM_BRANDING_DYNAMIC (有 activeTeamName 时展示团队名)', indexWxml.includes('wx:if="{{teamName}}"'));
check('PLATFORM_IDENTITY_PRESERVED (嘉禾志愿 出现 >=2)', (indexWxml.match(/嘉禾志愿/g) || []).length >= 2);

// 11. 适老基线默认值（不依赖 senior-mode）
check('SENIOR_BASELINE (正文 >=30rpx: font-size: 30rpx 存在)', indexScss.includes('font-size: 30rpx'));
check('SENIOR_BASELINE (主标题 44rpx: hero-title)', /font-size:\s*44rpx/.test(indexScss));
check('SENIOR_BASELINE (二级标题 36rpx: section-title)', /font-size:\s*36rpx/.test(indexScss));
check('SENIOR_BASELINE (按钮高度 >=96rpx)', /height:\s*96rpx/.test(indexScss));

// 12. P1-A.3 视觉基准：三类视觉插槽存在（Hero / 推荐图 / 能力插画）
check('HERO_HAS_VISUAL_SLOT = YES (hero-bg 本地图片视觉)',
  indexWxml.includes('class="hero-bg"') && indexWxml.includes('/images/home-v2/hero-ai.webp'));
check('RECOMMENDED_ACTIVITY_HAS_IMAGE_SLOT = YES (rec-media 图片插槽)',
  indexWxml.includes('class="rec-media"') && indexWxml.includes('class="rec-img"'));
check('SMART_CAPABILITIES_HAVE_VISUAL_SLOT = YES (每卡 cap-visual 插槽, 恰 3)',
  (indexWxml.match(/class="cap-visual/g) || []).length === 3);

// 13. P1-A.4 本地已认可素材接入
const ASSET = (n) => `${ROOT}/images/home-v2/${n}`;
check('LOCAL_HERO_ASSET_PRESENT = YES', existsSync(ASSET('hero-ai.webp')));
check('LOCAL_SMART_FIND_ASSET_PRESENT = YES', existsSync(ASSET('smart-find.png')));
check('LOCAL_SMART_ASSISTANT_ASSET_PRESENT = YES', existsSync(ASSET('smart-assistant.png')));
check('LOCAL_GROWTH_PLAN_ASSET_PRESENT = YES', existsSync(ASSET('growth-plan.png')));
check('LOCAL_STORY_1_ASSET_PRESENT = YES', existsSync(ASSET('story-community.png')));
check('LOCAL_STORY_2_ASSET_PRESENT = YES', existsSync(ASSET('story-warmth.png')));
check('HERO_REFERENCES_LOCAL_IMAGE = YES', indexWxml.includes('/images/home-v2/hero-ai.webp'));
check('SMART_CAPABILITIES_REFERENCE_LOCAL_IMAGES = YES',
  indexWxml.includes('/images/home-v2/smart-find.png') &&
  indexWxml.includes('/images/home-v2/smart-assistant.png') &&
  indexWxml.includes('/images/home-v2/growth-plan.png'));
check('STORY_SECTION_SUPPORTS_LOCAL_IMAGES = YES',
  indexWxml.includes('/images/home-v2/story-community.png') &&
  indexWxml.includes('/images/home-v2/story-warmth.png'));

// 14. P1-A.5 最终视觉精修：首页顺序 / 游客轻量 / 能力视觉卡 / 故事品牌视觉 / 动态降权
const posHero = indexWxml.indexOf('class="hero"');
const posAi = indexWxml.indexOf('class="ai-entry"');
const posRec = indexWxml.indexOf('为你推荐');
const posCaps = indexWxml.indexOf('class="caps"');
const posFoot = indexWxml.indexOf('我的公益足迹');
check('HOME_ORDER = HERO > AI_ENTRY > RECOMMENDATION > SMART_CAPABILITIES > FOOTPRINT',
  posHero > -1 && posAi > posHero && posRec > posAi && posCaps > posRec && posFoot > posCaps);

check('GUEST_FOOTPRINT_LIGHTWEIGHT = YES (无大 CTA，仅轻量引导)',
  !indexWxml.includes('class="footprint-guest-btn"') &&
  indexWxml.includes('footprint-guest-link') &&
  indexWxml.includes('登录后查看你的公益足迹'));

check('GUEST_LARGE_LOGIN_CTA_ON_HOME = NO',
  !indexWxml.includes('class="footprint-guest-btn"'));

check('SMART_CAPABILITY_EQUAL_VISUAL_CARDS = YES (3 等宽统一视觉卡)',
  (indexWxml.match(/<view class="cap"/g) || []).length === 3 &&
  !indexWxml.includes('cap-card-big') && !indexWxml.includes('cap-card-small') &&
  /flex:\s*1/.test(indexScss) && indexScss.includes('.cap-card'));

check('SMART_CAPABILITY_COUNT = 3 (统一卡仍为 3 个真实入口)',
  (indexWxml.match(/<view class="cap"/g) || []).length === 3);

check('SMART_CAPABILITY_MIXED_BIG_SMALL_LAYOUT = NO (无 1大+2小)',
  !indexWxml.includes('cap-card-big') && !indexWxml.includes('cap-card-small') &&
  !indexScss.includes('.cap-card-big') && !indexScss.includes('.cap-card-small'));

// 仅检查“智能志愿服务”区块内部是否残留设置菜单箭头，避免误命中 Footer 等其他区块的合法 ›
const _capSection = (indexWxml.split('class="caps"')[1] || '').split('<!-- 5.')[0];
check('SMART_CAPABILITY_SETTINGS_MENU_STYLE = NO (无设置菜单 ">" 箭头)',
  !indexWxml.includes('cap-arrow') && !_capSection.includes('›'));

check('SMART_CAPABILITY_IMAGES_PROMINENT = YES (每卡图为主视觉 等宽满铺)',
  indexScss.includes('.cap-visual') &&
  /cap-visual\s*\{\s*[\s\S]*?width:\s*100%/.test(indexScss) &&
  indexWxml.includes('/images/home-v2/smart-find.png') &&
  indexWxml.includes('/images/home-v2/smart-assistant.png') &&
  indexWxml.includes('/images/home-v2/growth-plan.png'));

check('LATEST_ACTIVITY_MAX_HOME_ITEMS <= 3 (首页仅展示前 3 条)',
  indexWxml.includes('wx:if="{{fi < 3}}"') || indexWxml.includes('fi < 3'));

check('STORY_VISUAL_AVAILABLE_WITHOUT_FAKE_DATA = YES (无数据时品牌视觉卡)',
  indexWxml.includes('class="story-brand"') &&
  indexWxml.includes('/images/home-v2/story-community.png'));

check('FAKE_STORY_DATA = NO (无编造人物/活动名)',
  !/张阿姨|李大爷|王奶奶|小明同学|小红同学|据某志愿者/.test(indexWxml));

// 16. P1-A.6 最终定点修正：3 等宽能力卡 + Footer 监管备案迁移（来源 1.0，零编造）
check('V1_FILING_INFO_FOUND = YES (1.0 含 ICP 备案号：浙ICP备2025213173号-1X)',
  indexWxml.includes('浙ICP备2025213173号-1X'));

check('V1_FILING_SOURCE_RECORDED = YES (备案号逐字迁移自 1.0 正式前端)',
  indexWxml.includes('备案号：浙ICP备2025213173号-1X'));

check('V2_FOOTER_FILING_VISIBLE = YES (Footer 展示 ICP 备案号)',
  indexWxml.includes('class="footer-icp"') &&
  indexWxml.includes('备案号：浙ICP备2025213173号-1X'));

check('FILING_INFO_INVENTED = NO (仅迁移 1.0 已有文案，未编造公安网备/备案号)',
  !/公网安备|公安网备|网安备/.test(indexWxml) &&
  indexWxml.includes('备案号：浙ICP备2025213173号-1X'));

// 17. P1-A.7 Footer 精简 + 关于我们页（非必要信息移至 about，零编造）
check('FOOTER_MAX_INFO_LAYERS = 2 (版权行 + ICP/关于我们行，无 footer-filing 多行块)',
  indexWxml.includes('class="footer"') &&
  indexWxml.includes('class="footer-row"') &&
  !indexWxml.includes('footer-filing'));

check('FOOTER_TECH_SUPPORT_REMOVED = YES (技术支持已移出首页 Footer)',
  !indexWxml.includes('技术支持：嘉兴市东诚信息咨询有限公司'));

check('FOOTER_HOTLINE_REMOVED = YES (志愿热线已移出首页 Footer)',
  !indexWxml.includes('志愿热线：0573-82099982'));

check('FOOTER_ICP_VISIBLE = YES (备案号继续在首页可见)',
  indexWxml.includes('备案号：浙ICP备2025213173号-1X'));

check('FOOTER_ABOUT_LINK_VISIBLE = YES (关于我们为真实 navigateTo 入口)',
  indexWxml.includes('url="/pages/about/index"') &&
  indexWxml.includes('关于我们'));

// 关于我们页真实承载迁移信息（READ 1.0，零编造）
const _aboutPath = resolve(__dirname, '..', 'pages', 'about', 'index.wxml');
let _aboutWxml = '';
try { _aboutWxml = read(_aboutPath); } catch (e) { _aboutWxml = ''; }

check('ABOUT_PAGE_REAL = YES (pages/about/index 真实存在且承载信息)',
  _aboutWxml.length > 0 && _aboutWxml.includes('嘉禾志愿志愿服务数字平台'));

check('ABOUT_PAGE_TECH_SUPPORT_VISIBLE = YES (技术支持迁移至关于我们)',
  _aboutWxml.includes('技术支持') && _aboutWxml.includes('嘉兴市东诚信息咨询有限公司'));

check('ABOUT_PAGE_HOTLINE_VISIBLE = YES (志愿热线迁移至关于我们)',
  _aboutWxml.includes('志愿热线') && _aboutWxml.includes('0573-82099982'));

check('ABOUT_PAGE_ICP_VISIBLE = YES (备案号迁移至关于我们)',
  _aboutWxml.includes('浙ICP备2025213173号-1X'));

check('ABOUT_PAGE_FILING_NOT_INVENTED = YES (关于我们页未编造公安网备/备案号)',
  !/公网安备|公安网备|网安备/.test(_aboutWxml) &&
  _aboutWxml.includes('浙ICP备2025213173号-1X'));

console.log(`\nRESULT: ${failed === 0 ? 'ALL GREEN' : 'HAS FAILURES'}`);
console.log(`passed=${passed} failed=${failed}`);
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
process.exit(0);
