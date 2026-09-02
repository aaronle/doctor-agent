#!/usr/bin/env node
/**
 * 还原度比对：把 V4.3 原件与重建版在同一视口下跑起来，逐个元素比关键计算样式。
 *
 * 比对的是「同名 class 的第一个元素」的盒模型与排版属性。截图对屏靠肉眼，
 * 容易漏掉几像素的差异；这里用数值兜住，回归时能立刻发现走样。
 *
 * 用法：
 *   1. 先启动重建版：npm run dev
 *   2. node scripts/compare-v43-fidelity.mjs
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const GLOBAL_MODULES = '/Users/leying/.nvm/versions/node/v24.11.1/lib/node_modules';
const { chromium } = require(join(GLOBAL_MODULES, 'playwright'));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'references/ui-demo/AI-HIS门诊模块V4.3.html');
const REF_PORT = 8899;
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:4173';
const VIEWPORT = { width: 1600, height: 1000 };

// 决定视觉观感的属性。颜色与字号错一点就会整体走样，优先看这些。
//
// 刻意不比 width / height：两者都由内容长度决定。去掉「惠每」后标题变短、
// 真实模型产出的诊断描述比 fixture 长，都会让尺寸对不上，但那是内容差异
// 不是还原度差异。真正决定观感的是字号、字重、行高、配色与盒模型内距。
const PROPS = ['fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'padding', 'borderRadius'];

/**
 * 逐选择器豁免的属性，**必须写明理由**。
 *
 * 这里放的是「取值由模型输出决定」的属性 —— 与上面刻意不比 width/height 同一类原因：
 * 那不是还原度差异，是内容差异。
 *
 * `.ra-card-name` 的颜色绑在 `risk.color`（danger/warning）上，而风险等级是模型判的。
 * 2026-09-02 把模型从 Haiku 换到 Sonnet 5 之后，P006 首条风险由高风险变中风险，
 * 颜色随之红变橙 —— 样式规则本身（.ra-name-danger #e6191a / .ra-name-warning #e6a23c）
 * 一个字没改。
 *
 * **豁免不等于不管**：这两个类名到颜色的映射由单元测试盯着
 * （AiEmrFloat.spec.ts「风险名按等级着色」），换个地方守，不是放掉。
 */
const PROP_EXEMPTIONS = {
  '.ra-card-name': ['color'],
  // 同上：色点的背景绑在 risk.color 上，也是模型判的等级。
  // 映射由 AiEmrFloat.spec.ts「色点按等级上色」守着。
  '.risk-dot': ['backgroundColor'],
};

// 每个页面挑一组有代表性的 class 做比对
/**
 * 把 ＋ 菜单点到「确定展开」。
 *
 * 不能简单点一下就完事：两个 page 实例在所有场景间复用，切 hash 不会重挂载组件，
 * 上一个场景留下的展开态会让这一次的点击变成「收起」。所以先归零再展开。
 */
/**
 * 确保 AI 浮层是打开的。
 *
 * 两个 page 实例在所有场景间复用，切 hash 不会重挂载组件 —— 上一个场景把浮层
 * 关掉（比如为了露出被盖住的阳性结果），下一个场景就点不到标签页，直接超时。
 * 与其要求每个场景自己收尾，不如让依赖浮层的场景自己确保前置状态。
 */
/**
 * 把这一位患者的这场就诊推进到「问诊已完成」。
 *
 * 改成问诊状态机之后，智慧诊疗 / 病历管理 / 诊断管理 / 共病管理四页在问诊前是
 * 锁着的（整页让位给说明卡）——不先解锁，这四页一个元素都取不到，
 * 比出来会是「重建版缺一大片」，而那是状态差异不是漏做。
 *
 * 走 voice/complete 而不是 analysis/unlock：前者会落一份真实 InterviewSession，
 * 上下文里就有对话，产出的内容量与原件可比；后者是「跳过」，没有对话，
 * 分析会明显更薄，比的就不是同一个东西了。
 */
async function ensureAnalysisUnlocked(page, apiBase, patientId) {
  await page.evaluate(async ({ base, pid }) => {
    const state = await fetch(`${base}/api/emr/visit-state/${pid}`).then((r) => r.json()).catch(() => null);
    if (state?.analysis_unlocked) return;
    await fetch(`${base}/api/emr/interview/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patient_id: pid,
        conversation_summary: '门禁脚本：以种子对话推进到问诊完成态',
        messages: [
          { role: 'doctor', text: '最近情况怎么样？' },
          { role: 'patient', text: '和上次差不多，没有明显好转。' },
        ],
      }),
    });
  }, { base: apiBase, pid: patientId });
}

/**
 * 等页面上的加载遮罩散掉再动手。
 *
 * `el-loading-mask` 会拦截指针事件。遮罩还在时点击**不会**报「找不到元素」，
 * 而是一路重试到超时，抛出来的是 TimeoutError —— 看着像元素不存在，
 * 实际是它被盖住了。查这个错会先去怀疑选择器，方向就偏了。
 *
 * 判据是「遮罩没了」，不是「等够了 N 秒」。这和把 `networkidle` 换成
 * 「要比的元素在场了」是同一件事：等的应该是那个条件本身。
 *
 * 150 秒是因为智慧诊疗聚合在 Sonnet 5 下要跑一分钟以上（Haiku 时代约 20 秒）。
 * **换模型第二次把藏在余量里的等待顶出来** —— 第一次是 Nginx 那 60 秒读超时。
 */
async function settle(page, timeout = 150000) {
  await page.waitForFunction(
    () => {
      const masked = [...document.querySelectorAll('.el-loading-mask')].some(
        (m) => m.offsetParent !== null && getComputedStyle(m).display !== 'none',
      );
      // 「智能体分析中…」是应用自己的「我还在算」信号，且**不是被测的那些选择器**。
      //
      // 只等遮罩不够：遮罩散了不代表 report-summary 回来了，而诊断（.dd-*）与
      // 风险（.ra-*）那十四个元素要等它回来才渲染。等的应该是这个条件本身。
      const thinking = document.body.innerText.includes('智能体分析中');
      return !masked && !thinking;
    },
    null,
    { timeout },
  );
}

async function ensureAiFloat(page) {
  // 每个 prepare 都从这里进来，遮罩的等待放在最前面，各处不必各写一遍
  await settle(page);
  const round = page.locator('.ai-float-btn').first();
  if (await round.isVisible().catch(() => false)) {
    await round.click();
    await page.waitForTimeout(400);
  }
  // AI 助手 2026-09-02 起**默认收起**（问诊前不该先把结论摆出来），
  // 且唤回入口从 ‹ › 小箭头换成了医生智能体里的整块开关卡片。
  // 比对这一侧的内容之前必须先展开，否则取到的是「什么都没有」，
  // 而那会被报成「重建版整块缺失」。
  const toggle = page.locator('.assistant-handle').first();
  if (!(await page.locator('.tips-drawer').first().isVisible().catch(() => false))
      && await toggle.isVisible().catch(() => false)) {
    await toggle.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.locator('.tips-drawer').first().waitFor({ state: 'visible', timeout: 8000 });
}

async function openPlusMenu(page) {
  await ensureAiFloat(page);
  if (await page.locator('.plus-menu').first().isVisible().catch(() => false)) {
    await page.locator('.tb-plus-btn').first().click();
    await page.waitForTimeout(250);
  }
  await page.locator('.tb-plus-btn').first().click();
  await page.locator('.plus-menu').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(300);
}

const PAGES = [
  {
    name: '候诊列表',
    hash: '#/outpatient/list',
    path: '/outpatient/list',
    selectors: ['.his-header', '.his-title', '.his-toolbar', '.patient-grid', '.patient-card', '.patient-avatar', '.patient-name', '.card-footer'],
  },
  {
    name: '门诊工作站',
    // 用 P006：只有带红色预警的患者才会渲染 risk-alert-section
    hash: '#/outpatient/P006',
    path: '/outpatient/P006',
    // AI 助手默认收起（问诊前不该先摆结论），比之前先展开
    prepare: async (page) => { await ensureAiFloat(page); },
    // **比对范围已收窄到 AI 助手内部**（2026-09-02）。
    //
    // 撤掉的那些（.workstation-body / .his-record-panel / .form-row / .fl /
    // .panel-title-bar / 医嘱面板 / 阳性结果）不再复刻 V4.3 —— 那是有意的产品
    // 决策，留在门禁里只会每次报「缺失」，而缺失的含义应该是「漏做了」。
    //
    // 页头与身份条保留：它们还在，只是内容简化了。
    selectors: [
      '.workstation-page', '.his-header', '.basic-info-strip',
      '.tips-drawer', '.tips-tab-nav', '.ttab', '.assistant-panel',
      '.rc-label', '.skill-chip',
      // 鉴别诊断与风险提示：首轮重建做成了自拟结构，与原件差得最远的两块
      '.dd-card', '.dd-header', '.dd-title', '.dd-confirm-btn', '.dd-rec-item', '.dd-card-top',
      '.dd-primary-tag', '.dd-primary-name', '.dd-icd', '.dd-reason', '.dd-diff-label', '.dd-diff-count',
      '.risk-alert-section', '.ra-title', '.ra-card', '.ra-card-name', '.ra-card-suggestion', '.ra-view-btn',
    ],
  },
  // 八个 AI 标签页逐页比对。类名齐不等于样式对 —— 早先健康档案与病历质控
  // 就是「结构看着有、其实整块没做」，只有逐页取样才能发现。
  ...[
    ['智慧诊疗', ['.condition-overview-card', '.coc-title', '.dd-card', '.record-card', '.rc-label', '.ka-cat-name', '.ka-card', '.rc-vital', '.rc-vk']],
    // .risk-dot / .risk-actions 是补上的：漏写就等于不检查 ——
    // 色点当初只渲染了一个没有背景色的空 span，肉眼是「少了个图标」，
    // 而 126→144 个元素的比对一路全绿，因为它俩根本不在清单里。
    ['预警评估', ['.risk-assess-block', '.risk-card', '.risk-card-header', '.risk-dot', '.risk-name', '.risk-actions', '.risk-summary']],
    ['病历管理', ['.record-layout', '.record-main', '.record-node', '.node-title', '.node-content', '.record-qc-side', '.rc-side-card', '.rc-side-head', '.rc-side-title', '.rc-risk-row', '.rc-risk-text', '.rc-qc-row', '.rc-qc-name', '.rc-qc-pill', '.rc-side-more']],
    ['诊断管理', ['.suspected-list', '.suspected-item', '.susp-name', '.susp-conf', '.susp-icd', '.susp-desc', '.primary-mark-btn', '.diag-selection-actions']],
    ['医嘱管理', ['.treat-panel', '.treat-section-title', '.treat-card', '.treat-drug', '.treat-spec', '.treat-basis', '.exam-rec-order', '.ero-name']],
    ['共病管理', ['.comorbidity-overview', '.comorbidity-condition-card', '.condition-name', '.condition-analysis', '.condition-dept', '.comorbidity-actions-bar']],
    ['健康档案', ['.archive-panel', '.archive-overview', '.ao-title', '.ao-k', '.ao-v', '.archive-toolbar', '.archive-muted', '.af-chip', '.visit-list', '.visit-card', '.vc-type', '.vc-time', '.vc-dept', '.vc-meta', '.vc-cc']],
    ['时间轴', ['.timeline-list', '.timeline-group', '.tl-time-tag', '.tl-group-card', '.tl-group-action', '.tl-sub-label', '.tl-sub-action', '.tl-sub-detail', '.tl-cat-tag', '.timeline-actions']],
  ].map(([tab, selectors]) => ({
    name: `标签页 · ${tab}`,
    hash: '#/outpatient/P001',
    path: '/outpatient/P001',
    prepare: async (page) => {
      await ensureAiFloat(page);
      await page.locator('.ttab').filter({ hasText: tab }).first().click();
      await page.waitForTimeout(700);
      // 切标签页会触发该页自己的加载，再等一次
      await settle(page);
      // 就诊卡默认折叠，点开第一张才能取到内部元素
      const visit = page.locator('.visit-card').first();
      if (await visit.isVisible().catch(() => false)) {
        await visit.click();
        await page.waitForTimeout(400);
      }
      // 专项评估小助手：**重建版五个分类默认全折叠，原件全展开**
      // （2026-09-02 产品决策，见 10-V4.3反向需求规格说明书.md）。要比就得
      // 先摊到同一个状态，否则比的是默认态差异而不是还原度。
      //
      // 每一个分类都要开，不能只开第一个 —— 卡片配色按分类分布，
      // 只开第一个就采不到后面几类的样式。
      //
      // 一律「确保展开」而不是「点一下」：盲点会把原件那份已展开的收起来，
      // 于是第一张可见卡片变成另一个分类的，比出来是背景色不一致，
      // 其实是取样取错了对象。
      // **先确认这一页真的看得见专项评估。** 标签页之间用 v-show 切换，
      // `.ka-category` 在每一页的 DOM 里都在，只是隐藏着 —— 不加这道判断，
      // 另外七个标签页上每次点击都会等满 Playwright 的 30 秒超时再被 catch 掉：
      // 5 个分类 × 2 个页面 × 7 个标签页 ≈ 35 分钟，跑起来像卡死。
      // 原来的写法有这道判断（`cat.isVisible()`），是我改的时候弄丢的。
      const categories = page.locator('.ka-category');
      const catCount = await categories.count().catch(() => 0);
      if (catCount && (await categories.first().locator('.ka-cat-header').isVisible().catch(() => false))) {
        for (let i = 0; i < catCount; i += 1) {
          const header = categories.nth(i).locator('.ka-cat-header');
          if (await categories.nth(i).locator('.ka-list').isVisible().catch(() => false)) continue;
          // 给短超时：真点不动时快点失败，别把一次误判摊成半分钟
          await header.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(120);
        }
      }
      // 评估卡的**默认态**两边不同：原件默认展开前两条说明，重建版一律折叠
      // （产品决策，见 assessment_catalog.json 的 note）。所以这里要把第一张卡
      // 「确保展开」再取样 —— 比的是卡片展开后长得对不对，不是默认开还是关。
      // 同样是「确保」不是「点一下」：盲点会把原件那张已展开的收起来。
      const card = page.locator('.ka-card').first();
      if (await card.isVisible().catch(() => false)) {
        const collapsed = await card.evaluate((el) => el.classList.contains('collapsed'));
        if (collapsed) {
          await card.click();
          // 点完鼠标还停在卡上，取到的会是 :hover 色（.ka-card-danger:hover 是
          // #ffe8e8，静止态是 #fff5f5）—— 挪开再取样，否则比出来的是悬停差异。
          await page.mouse.move(0, 0);
          await page.waitForTimeout(400);
        }
      }
    },
    selectors,
  })),

  {
    name: '语音问诊播放中',
    hash: '#/outpatient/P006',
    path: '/outpatient/P006',
    // 点「语音问诊」后 2.5 秒内采集：对话脚本约 7 秒播完就转 ended，浮层随之消失
    // V4.3 的问诊数据是本地的，点完即播；重建版要先等 voiceInit 的真实模型
    // 调用返回，所以等浮层出现而不是死等固定时长。
    prepare: async (page) => {
      await ensureAiFloat(page);
      await page.locator('.action-bar button', { hasText: '语音问诊' }).first().click();
      // 原来等 .pending-float（AI 追问提示）—— 那一块一期已撤，等它只会白等 30 秒。
      // 现在等第一条对话气泡出现，那才是这个场景真正要比的东西。
      await page.locator('.msg-bubble').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(800);
    },
    // 「AI 追问提示」六个类（.pending-* / .pq-*）已从清单摘掉：
    // 一期撤掉了那个功能（没有临床知识库支撑时，建议错一条的代价大于不给建议），
    // 这是**有意偏离原件**。留在清单里只会每次报「缺失」，
    // 而「缺失」的含义应该是「漏做了」，不是「有意没做」。
    //
    // `.mode-badge`（红色的「语」）2026-09-03 同样摘掉，两条理由各自成立：
    //   ① 它标的是「语音问诊模式」，而一期没有任何语音识别 ——
    //      全仓零行 SpeechRecognition / MediaRecorder，标了一个不存在的模式；
    //   ② 红色在本产品是临床风险语义（F06 明确禁止拿红色做别的用途）。
    //      患者姓名旁边的红色现在给药物过敏史 —— 那才配得上这个颜色和这个位置。
    selectors: ['.msg-bubble', '.bubble-role', '.bubble-content'],
  },

  // 「阳性结果展开态」场景已移除（2026-09-02）：阳性结果面板随 HIS 门面一起撤掉，
  // 场景里等的 .result-list-item 永远不会出现，整条门禁会挂在 30 秒超时上 ——
  // 而报错长得像「点不到元素」，查起来会先去怀疑选择器。
  {
    name: '质控明细展开',
    hash: '#/outpatient/P001',
    path: '/outpatient/P001',
    prepare: async (page) => {
      await ensureAiFloat(page);
      await page.locator('.ttab').filter({ hasText: '病历管理' }).first().click();
      await page.waitForTimeout(700);
      // 「查看全部 N 处遗漏」是风险卡里的第一个 rc-side-more
      await page.locator('.rc-risk-card .rc-side-more').first().click();
      await page.locator('.qc-item').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(400);
    },
    /**
     * 只比与变体无关的元素。
     *
     * `.qc-item` 与 `.qc-issue` 的背景/字色取决于这一条是 error 还是 warning，
     * 而「第一条是哪一型」「有没有某一型」完全由数据决定 —— 我们的质控规则是
     * 【增强】重写过的确定性规则，触发分布本就与原件不同。拿它们比对，比的是
     * 规则行为不是视觉还原，只会稳定误报。锁定某一变体也不行：那一型在某次
     * 数据下可能一条都不出，就变成「缺失」。
     *
     * 变体配色由 split-v43-css 从原件逐字拆来，无人工改写；类是否正确挂上
     * 由 AiEmrFloat.spec.ts 的「按 type 分图标」用例把守。
     */
    selectors: ['.rc-qc-detail', '.qc-icon', '.qc-body', '.qc-field'],
  },

  {
    name: '＋ 菜单展开',
    hash: '#/outpatient/P001',
    path: '/outpatient/P001',
    prepare: openPlusMenu,
    selectors: ['.plus-menu', '.pm-item', '.pm-submenu-trigger'],
  },

  {
    name: '技能管理对话框',
    hash: '#/outpatient/P001',
    path: '/outpatient/P001',
    prepare: async (page) => {
      await openPlusMenu(page);
      // 「技能管理」是 ＋ 菜单最后一项
      await page.locator('.plus-menu .pm-item').last().click();
      await page.locator('.skill-manage-dialog').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(400);
    },
    selectors: ['.skill-manage-dialog', '.sm-body', '.sm-toolbar', '.sm-hint'],
  },

  {
    name: '浮层全关的唤回钮',
    hash: '#/outpatient/P001',
    path: '/outpatient/P001',
    prepare: async (page) => {
      // 上一场景留下的技能管理对话框会盖住关闭按钮，先收干净
      const close = page.locator('.skill-manage-dialog .el-dialog__headerbtn').first();
      if (await close.isVisible().catch(() => false)) {
        await close.click();
        await page.waitForTimeout(400);
      }
      for (const sel of ['.tips-close', '.panel-close']) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click();
          await page.waitForTimeout(400);
        }
      }
      await page.locator('.ai-float-btn').first().waitFor({ state: 'visible', timeout: 8000 });
    },
    selectors: ['.ai-float-btn', '.float-icon', '.float-ready-dot'],
  },
];

function readStyles(selectors, props) {
  const out = {};
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) {
      out[selector] = null;
      continue;
    }
    const cs = getComputedStyle(el);
    out[selector] = Object.fromEntries(props.map((p) => [p, cs[p]]));
  }
  return out;
}

const html = await readFile(SOURCE);
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((resolve) => server.listen(REF_PORT, '127.0.0.1', resolve));

const browser = await chromium.launch();

/**
 * 取样前先等这些选择器出现。
 *
 * 不等的话，判据就成了「我按下快门那一瞬间它在不在」—— 而这一瞬间取决于模型多快返回。
 * 换到 Sonnet 5 之后真的抖出来过一次：同一份代码，一轮报「缺失 14」，
 * 单独重跑又是「缺失 0」。那不是缺失，是**还没渲染出来**。
 *
 * 等过之后，「缺失」才恢复它本来的含义：**给了时间也没出现**，
 * 那才是真的整块没做或者根本没渲染。
 *
 * 全部并行等，所以墙钟是单个超时而不是累加。等不到的不报错 ——
 * 由后面的比对如实记成缺失，这里只负责给足时间。
 */
/**
 * 这里的预算刻意保持在 20 秒，**不跟着模型变慢一起加大**。
 *
 * 「分析回来了没有」由 `settle()` 负责等（它盯的是应用自己的加载信号，
 * 预算 150 秒）。到了这一步内容本该已经在了，20 秒只是给渲染留的余量。
 *
 * 如果这里也放到 150 秒，真出现漏做时每个场景都要空等满 —— 十六个场景
 * 能拖到四十分钟，而那正是最需要快点看到结论的时候。
 */
async function waitForSampleTargets(page, selectors, timeout = 20000) {
  await Promise.all(
    selectors.map((s) =>
      page.locator(s).first().waitFor({ state: 'attached', timeout }).catch(() => {}),
    ),
  );
}

async function collect(page, selectors) {
  await waitForSampleTargets(page, selectors);
  return page.evaluate(([s, p]) => {
    const out = {};
    for (const selector of s) {
      const el = document.querySelector(selector);
      if (!el) { out[selector] = null; continue; }
      const cs = getComputedStyle(el);
      out[selector] = Object.fromEntries(p.map((k) => [k, cs[k]]));
    }
    return out;
  }, [selectors, PROPS]);
}

// **重建版一律不用 networkidle 等页面。**
//
// 解锁过的就诊一进场就会拉 report-summary，Sonnet 5 下要跑一分钟以上 ——
// 网络永远闲不下来，30 秒必然超时。networkidle 的前提是「加载完请求就停」，
// 这个页面根本不满足。
//
// 改成等 DOM 就绪 + 等真正要用的元素出现：判据从「网络安静了」换成
// 「我要比的东西在场了」，那才是这一步真正等的东西。
const APP_READY = { waitUntil: 'domcontentloaded' };

const refPage = await browser.newPage({ viewport: VIEWPORT });
await refPage.goto(`http://127.0.0.1:${REF_PORT}/#/login`, { waitUntil: 'networkidle' });
await refPage.getByRole('button', { name: '进入门诊工作站' }).click();
await refPage.waitForTimeout(1500);

// 重建版已于 2026-09-01 移除登录页（一期无 SSO，那道门形同虚设），直接进候诊列表。
// 原件那边还得走登录 —— 两边入口不同，但落点都是候诊列表，比对的起点是一致的。
const appPage = await browser.newPage({ viewport: VIEWPORT });
await appPage.goto(`${APP_URL}/outpatient/list`, APP_READY);
await appPage.locator('.patient-card').first().waitFor({ state: 'visible', timeout: 30000 });
await appPage.waitForTimeout(1500);
// 两位取样患者都推进到「问诊已完成」，否则受门禁的四页取不到元素
for (const pid of ['P001', 'P006']) await ensureAnalysisUnlocked(appPage, APP_URL, pid);

let total = 0;
let diffs = 0;
let missing = 0;

for (const target of PAGES) {
  await refPage.evaluate((h) => { location.hash = h.slice(1); }, target.hash);
  await refPage.waitForTimeout(1800);
  await appPage.goto(`${APP_URL}${target.path}`, APP_READY);
  // 等页面骨架，不等网络 —— 分析是后台慢慢回来的，不该卡住导航
  await appPage.locator(target.path.includes('/list') ? '.his-list-page' : '.workstation-page')
    .first().waitFor({ state: 'visible', timeout: 30000 });
  // 工作站首屏要等四个岗位跑完。
  //
  // **等的是「数据到位了」这个肯定条件，不是「什么都没在转」。**
  //
  // 这一处前后错了三次，每次都更接近但都没到位：
  //   ① `waitForTimeout(25000)` —— 写死秒数。Haiku 时代量的，Sonnet 要 61 秒
  //   ② `settle()` 只放在各场景的 prepare 里 —— 这个场景没有 prepare，没跑到
  //   ③ `settle()` 放进主循环 —— 仍然会漏，因为它有竞态：页面刚加载、
  //      请求还没发出去时，既没有遮罩也没有「智能体分析中」，settle 立刻通过。
  //      「什么都没在转」分不清「已经好了」和「还没开始」。
  //
  // 现在先把 report-summary 自己请求一遍。它服务端有缓存，所以这一步既是
  // 「等数据」也是「预热」；它返回了，就一定有数据可渲染。之后 settle()
  // 只负责等渲染完成。
  if (target.path.includes('/outpatient/P')) {
    const pid = target.path.split('/').pop();
    await appPage.evaluate(
      async ({ base, id }) => {
        try {
          await fetch(`${base}/api/emr/report-summary/${id}`);
        } catch {
          // 拿不到就让后面的比对如实记成缺失，这里不代它下结论
        }
      },
      { base: APP_URL, id: pid },
    );
  }
  await settle(appPage);
  await appPage.waitForTimeout(target.path.includes('/outpatient/P') ? 1200 : 800);

  // 两边各自「准备完立刻采集」，不能先准备两边再一起采：
  // 原件的问诊浮层约 7 秒后随播放结束消失，而重建版要等真实模型返回，
  // 等回来时原件那边早没了，会误报成「原件中不存在」。
  let ref;
  let app;
  if (target.prepare) {
    await target.prepare(refPage);
    ref = await collect(refPage, target.selectors);
    await target.prepare(appPage);
    app = await collect(appPage, target.selectors);
  } else {
    [ref, app] = await Promise.all([collect(refPage, target.selectors), collect(appPage, target.selectors)]);
  }

  console.log(`\n■ ${target.name}`);
  for (const selector of target.selectors) {
    if (!ref[selector]) { console.log(`  ? ${selector.padEnd(22)} 原件中不存在，跳过`); continue; }
    if (!app[selector]) { console.log(`  ✗ ${selector.padEnd(22)} 重建版缺失该元素`); missing += 1; continue; }

    const exempt = PROP_EXEMPTIONS[selector] || [];
    const bad = PROPS.filter((p) => !exempt.includes(p) && ref[selector][p] !== app[selector][p]);
    total += 1;
    if (!bad.length) {
      console.log(`  ✓ ${selector.padEnd(22)} 一致`);
    } else {
      diffs += 1;
      console.log(`  △ ${selector.padEnd(22)} ${bad.length} 项不同`);
      for (const p of bad) console.log(`      ${p}: 原件 ${ref[selector][p]}  →  重建 ${app[selector][p]}`);
    }
  }
}

console.log(`\n合计比对 ${total} 个元素：一致 ${total - diffs}，有差异 ${diffs}，缺失 ${missing}`);

await browser.close();
server.close();

// 2026-09-02 补：这个脚本原本**只打印、从不设退出码**，一直是 exit 0。
//
// 也就是说它压根没在「门禁」，全靠人盯着最后那行数字。链式的
// `a && b && c` 里它永远放行；直到 verify.mjs 按退出码判定，才露出来 ——
// 那一次它印着「缺失 14」，却被记成通过。
//
// **缺失比差异更该拦。** 差异是「长得不一样」，缺失是「这个元素根本没渲染出来」，
// 后者往往意味着整块功能没上，或者取样时页面还没到位。
if (diffs || missing) {
  console.log(`\n✗ 还原度门禁未过：差异 ${diffs}、缺失 ${missing}`);
  process.exit(1);
}
process.exit(0);
