/**
 * 全面走查：把**所有页面、所有主要交互**在真浏览器里跑一遍。
 *
 * 与既有两个脚本的分工：
 *   - `smoke-prod.mjs`  回答「页面白不白」
 *   - `demo-check.mjs`  回答「演示那条主线还成不成立」
 *   - 本脚本            回答「每一处点下去有没有坏、卡不卡」
 *
 * 它专门找三类东西，都是单测发现不了的：
 *   ① 只在真浏览器里成立的（层级、裁剪、`zoom` 与坐标、teleport）
 *   ② 跨状态的接缝（拖过再分离、改过字号再全屏、切患者后残留）
 *   ③ 手感（交互到反馈的毫秒数、有没有布局跳动）
 *
 * 用法：node scripts/full-audit.mjs [--base http://127.0.0.1:4173]
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(join('/Users/leying/.nvm/versions/node/v24.11.1/lib/node_modules', 'playwright'));

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:4173');

const issues = [];
const notes = [];
const apiLog = [];
const inflight = new Set();
let checks = 0;
const bad = (area, msg, detail = '') => { issues.push({ area, msg, detail }); console.log(`   ✗ [${area}] ${msg}${detail ? ` — ${detail}` : ''}`); };
const ok = (msg) => { checks++; console.log(`   ✓ ${msg}`); };
const slow = (area, what, ms, limit) => {
  checks++;
  if (ms > limit) issues.push({ area, msg: `${what} 耗时 ${ms}ms（阈值 ${limit}ms）`, detail: '手感' }),
    console.log(`   ⚠ [${area}] ${what} ${ms}ms > ${limit}ms`);
  else console.log(`   ✓ ${what} ${ms}ms`);
};

/**
 * 走查前重置**本地**状态。
 *
 * ⚠️ **不要调用 `scripts/demo-reset.mjs`** —— 那个脚本通过 SSH 操作
 * **生产库**（`ubuntu@81.71.155.220:/opt/doctor-agent/data/…`）。
 * 我在第一版里调了它，等于让一次本地走查改掉了线上演示状态。
 * 本地走查只许碰本地。
 *
 * 重置的必要性：走查会把患者解锁，不重置的话第二轮就测不到
 * 「未解锁时带锁」—— 而那正是一条安全门禁。一个不可重复的走查，
 * 第二次跑起来是在自欺。
 */
const RESET = arg('--reset', '1') !== '0';
const LOCAL = /127\.0\.0\.1|localhost/.test(BASE);
const { execSync } = await import('node:child_process');
const sh = (cmd) => execSync(cmd, { stdio: 'pipe', shell: '/bin/zsh' }).toString();

/** 临床主线走查用它 —— 会被解锁 */
const FLOW_PID = 'P002';
/** 门禁走查用它 —— **走查全程不碰**，所以它的锁态永远是真的 */
const GATE_PID = 'P005';

/**
 * 重置**只清一位患者的解锁态**，不重启服务。
 *
 * ⚠️ **不要调用 `scripts/demo-reset.mjs`** —— 那个脚本通过 SSH 操作
 * **生产库**。第一版调了它，等于让一次本地走查改掉了线上演示状态。
 *
 * 也不再重启 dev 栈：`npm run dev` 是 `concurrently -k`，杀一个带走另一个，
 * 而 uvicorn `--reload` 的父子进程放端口有延迟，反复撞
 * `Address already in use`。SQLite 是文件，另开一个连接删就行。
 */
if (RESET && LOCAL) {
  try {
    sh(`sqlite3 doctor-agent.db "UPDATE patients SET payload = json_remove(payload, '$.analysis_unlock') WHERE id='${FLOW_PID}'"`);
    sh(`sqlite3 doctor-agent.db "DELETE FROM voice_sessions WHERE patient_id='${FLOW_PID}'"`);
    console.log(`· 已把 ${FLOW_PID} 复位到未解锁态`);
  } catch (e) { console.log('· 复位跳过：' + String(e.message).split('\n')[0].slice(0, 70)); }
} else if (RESET) {
  console.log('· 非本地地址，跳过复位（生产状态不由走查脚本改）');
}

const browser = await chromium.launch();

/** 一段走查。**抛异常也只记一条**，不让整轮中断 —— 中断掉的那些项会被误读成「没问题」 */
async function section(name, fn) {
  console.log(`\n■ ${name}`);
  try { await fn(); } catch (e) { bad(name, '走查中断', String(e.message).split('\n')[0].slice(0, 120)); }
}

/** 每个页面都挂错误钩子 —— 控制台报错是零容忍的 */
function watch(page, area) {
  // 默认 30s 太长 —— 一处点不到就烧半分钟，整轮走查会被拖成十几分钟
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => bad(area, '页面异常', e.message.slice(0, 120)));
  page.on('requestfailed', (r) => {
    // 埋点是 fire-and-forget，导航时被取消是正常的（useTelemetry 明确不重试）
    if (r.url().includes('/api/telemetry')) return;
    // 导航或关页面时，在途请求被浏览器取消是**正常**的，不是接口故障。
    // 真正的故障是连接层报错（ERR_CONNECTION_*、ERR_FAILED 之类）
    const err = r.failure()?.errorText ?? '';
    if (err.includes('ERR_ABORTED')) return;
    if (r.url().includes('/api/')) bad(area, '接口请求失败', `${r.url().split('/api/')[1]} ${err}`);
  });
  page.on('request', (r) => {
    const u = r.url();
    if (!u.includes('/api/')) return;
    inflight.add(u);
  });
  page.on('response', (r) => {
    const u = r.url();
    if (!u.includes('/api/')) return;
    inflight.delete(u);
    apiLog.push(`${u.split('/api/')[1].split('?')[0]} ${r.status()}`);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // 模型网关抖动不算前端 bug
    if (/Failed to load resource|net::ERR|502|504/.test(t)) return;
    bad(area, '控制台报错', t.slice(0, 120));
  });
}

// ═══════════════════════════════════════════════ 桌面端
await section('桌面端 1600×1000', async () => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  watch(page, '桌面');

  // **先清个人偏好。** 走查会拖窗口、改字号，而 `remember_windows` 默认开着 ——
  // 这些都会存进偏好，让**下一轮**的几何与上一轮不同。
  // 线上第一次跑就栽在这：面板被上一轮记成 372px 宽，
  // 标题栏中心于是落进了按钮排。一个不可复现的走查，第二次跑起来是在自欺。
  await page.goto(`${BASE}/outpatient/list`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    localStorage.removeItem('doctor-agent:preferences');
    localStorage.removeItem('doctor-agent:font-level');
    // **要 await 完再走。** 不等的话紧接着的 goto 会把这几个 DELETE 掐掉，
    // 报成 `net::ERR_ABORTED` —— 那不是接口坏了，是我自己打断的
    await Promise.all(['张医生', 'demo-doctor'].map((who) =>
      fetch(`/api/preferences?actor=${encodeURIComponent(who)}`, { method: 'DELETE' }).catch(() => {})));
  });

  // ---- 候诊列表
  await page.goto(`${BASE}/outpatient/list`, { waitUntil: 'domcontentloaded' });
  await page.locator('.patient-card, [class*=patient-card]').first().waitFor({ timeout: 15000 }).catch(() => {});
  const cards = await page.locator('.patient-card, [class*=patient-card]').count();
  cards > 0 ? ok(`候诊列表 ${cards} 张卡`) : bad('候诊列表', '一张患者卡都没有');

  // 过敏标记：两种状态的字形要一致，不能一个 emoji 一个 ASCII
  const glyphs = await page.locator('.allergy-badge').allInnerTexts();
  const mixed = glyphs.some((g) => g.startsWith('⚠')) && glyphs.some((g) => /^[?？]/.test(g));
  mixed ? bad('候诊列表', '过敏标记字形不一致', `${glyphs.slice(0, 3).join(' / ')}`) : ok('过敏标记字形一致');

  // ---- 进工作站
  // 量的是「面板可用」不是 networkidle —— 分析在后台跑（18–60s），
  // 首屏本来就不等它（HANDOVER §6）。等 networkidle 量到的是模型耗时，不是手感
  const t0 = Date.now();
  await page.goto(`${BASE}/outpatient/P009`, { waitUntil: 'domcontentloaded' });
  await page.locator('.assistant-panel').waitFor({ timeout: 20000 });
  slow('桌面', '首屏可用', Date.now() - t0, 4000);
  // 分析没回来之前，界面必须已经能用（红线来自硬规则，毫秒级）
  const early = await page.locator('.assistant-panel').isVisible();
  early ? ok('分析未回时面板已可用') : bad('工作站', '首屏被分析阻塞');

  // 首屏只有医生智能体
  (await page.locator('.tips-drawer').count()) === 0
    ? ok('首屏只有医生智能体（AI 助手收起）')
    : bad('工作站', '首屏 AI 助手就展开了');

  // ---- 默认布局：两个窗必须是「连在一起、完整看得见」的一整块
  //
  // 这是演示第一眼看到的东西，也是最容易悄悄坏掉的东西 —— 布局记忆会把上一次
  // 拖成什么样原样铺回来。线上实测过一次全坏的：两窗互相压着，右边和底边
  // 一起甩出屏幕（抽屉 right=1805 / bottom=1264，视口 1600×1000）。
  await page.locator('.assistant-handle').click();
  await page.locator('.tips-drawer').waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
  {
    const d = await page.locator('.tips-drawer').boundingBox();
    const p = await page.locator('.assistant-panel').boundingBox();
    const vp = page.viewportSize();
    const seam = p.x - (d.x + d.width);
    Math.abs(seam) < 1
      ? ok('默认布局：两窗之间没有缝')
      : bad('浮窗', '两窗之间有缝', `${seam.toFixed(1)}px —— 底下的 HIS 会透上来`);
    Math.abs(d.y - p.y) < 1 && Math.abs(d.height - p.height) < 1
      ? ok('默认布局：两窗顶边齐、等高')
      : bad('浮窗', '两窗没对齐', `顶边 ${Math.round(d.y)}/${Math.round(p.y)}，高 ${Math.round(d.height)}/${Math.round(p.height)}`);
    const out = [['抽屉', d], ['面板', p]].filter(
      ([, b]) => b.x < 0 || b.y < 0 || b.x + b.width > vp.width + 1 || b.y + b.height > vp.height + 1,
    );
    out.length === 0
      ? ok('默认布局：整块都在视口里')
      : bad('浮窗', '默认布局有窗出屏', out.map(([n, b]) =>
          `${n} 右${Math.round(b.x + b.width)}/底${Math.round(b.y + b.height)}`).join('，'));
  }
  // 收回去，后面几条是从「只有医生智能体」这个状态起测的
  await page.locator('.tips-close').click();
  await page.waitForTimeout(400);

  // ---- 窗口交互：拖 / 上下边线 / 全屏 / 字号
  const before = await page.locator('.assistant-panel').boundingBox();
  // **从标题文字起拖，不要用标题栏的几何中心。**
  // 面板一变宽，中心就落进右侧那排按钮（Aa / ⚙ / ⛶ / —）——
  // 按钮本来就不该触发拖动，于是探针量到「位移 0」，报了个假 bug。
  // 第一版还拿面板左边当起点算位移，把半个面板宽也算进了期望值。
  const hb = await page.locator('.panel-title').boundingBox();
  const sx = hb.x + hb.width / 2, sy = hb.y + hb.height / 2;
  await page.mouse.move(sx, sy); await page.mouse.down();
  await page.mouse.move(sx - 300, sy + 100, { steps: 8 });
  await page.mouse.up();
  const after = await page.locator('.assistant-panel').boundingBox();
  Math.abs(after.width - before.width) < 2 && Math.abs(after.height - before.height) < 2
    ? ok('拖动后尺寸不变（分离时冻住了）')
    : bad('浮窗', '拖动后尺寸变了', `${before.width}×${before.height} → ${after.width}×${after.height}`);
  Math.abs((after.x - before.x) + 300) < 12
    ? ok('拖动位移与鼠标一致')
    : bad('浮窗', '拖动位移对不上', `期望 -300，实际 ${Math.round(after.x - before.x)}`);

  // 分离后开抽屉：抽屉该是自己的宽度并贴住面板
  await page.locator('.assistant-handle').click();
  await page.waitForTimeout(900);
  const dw = await page.locator('.tips-drawer').boundingBox();
  const pw = await page.locator('.assistant-panel').boundingBox();
  if (!dw) bad('浮窗', '抽屉没打开');
  else {
    dw.width > 500 ? ok(`分离态开抽屉宽度正常 ${Math.round(dw.width)}`)
      : bad('浮窗', '抽屉宽度被面板污染', `${Math.round(dw.width)}px`);
    Math.abs(dw.x + dw.width - pw.x) < 3 ? ok('抽屉右边线贴住面板左边线')
      : bad('浮窗', '抽屉与面板没贴住', `缝隙 ${Math.round(pw.x - dw.x - dw.width)}px`);
  }

  // 字号
  const fontBtn = page.locator('.font-btn');
  if (await fontBtn.count()) {
    await fontBtn.click(); await page.waitForTimeout(300);
    const opts = await page.locator('.font-opt').count();
    opts === 4 ? ok('字号四档') : bad('字号', `档位数不对：${opts}`);
    await page.locator('.font-opt').nth(3).click(); await page.waitForTimeout(400);
    // zoom 挂在**内容区**（.chat-area），不在面板上 ——
    // 面板要承载拖动坐标，加了 zoom 两套像素就对不上（见 useFontScale 文件头）
    const z = await page.locator('.chat-area').first().evaluate((el) => getComputedStyle(el).zoom);
    Number(z) > 1.2 ? ok(`特大档 zoom=${z}`) : bad('字号', '特大档没生效', `zoom=${z}`);
    const panelZoom = await page.locator('.assistant-panel').evaluate((el) => getComputedStyle(el).zoom);
    Number(panelZoom) === 1 ? ok('面板本身不缩放（拖动坐标不受污染）') : bad('字号', 'zoom 挂到了面板上', panelZoom);
    await fontBtn.click(); await page.waitForTimeout(200);
    await page.locator('.font-opt').nth(1).click(); await page.waitForTimeout(300);
  } else bad('字号', '面板头部没有字号按钮');

  // 设置入口
  const gear = page.locator('.settings-btn');
  if (await gear.count()) {
    const urlBefore = page.url();
    await gear.click(); await page.waitForTimeout(700);
    const dlg = await page.locator('.settings-dialog').count();
    dlg > 0 ? ok('设置开的是对话框') : bad('设置', '齿轮没开出对话框');
    page.url() === urlBefore ? ok('设置不跳走') : bad('设置', '点设置离开了当前患者');
    await page.keyboard.press('Escape');
    // **等遮罩真的退场**。Element Plus 的 overlay 有淡出动画，
    // 动画期间它仍然吃点击 —— 第一版紧接着去点看板，30 秒超时
    await page.locator('.el-overlay').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
  } else bad('设置', '面板头部没有设置入口');

  // 科室看板
  // **先复位布局。** 上面把面板往下拖了 100px，底部那排按钮被推出了视口 ——
  // 面板是 position:fixed，`scrollIntoView` 对它无效。
  // 双击标题栏恢复默认布局（面板 title 里就写着这条）
  await page.locator('.panel-header').dblclick().catch(() => {});
  await page.waitForTimeout(600);
  const boardBtn = page.locator('button', { hasText: '科室看板' }).first();
  if (await boardBtn.count()) {
    await boardBtn.click({ timeout: 8000 }); await page.waitForTimeout(1600);
    // 只数看板自己的表 —— `table tbody tr` 会把 HIS 门面的医嘱表一起数进来
    const rows = await page.locator('.db-table tbody tr').count();
    rows > 0 ? ok(`科室看板 ${rows} 行`) : bad('看板', '看板打开了但没有行');
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  } else bad('看板', '找不到科室看板入口');

  // ---- 最小化成卡通再唤回
  await page.locator('.panel-close').click().catch(() => {});
  await page.waitForTimeout(600);
  const mascot = await page.locator('.mascot').count();
  if (mascot) {
    ok('最小化后出现 D1 卡通');
    const box = await page.locator('.mascot').boundingBox();
    // 卡通必须真的可点：z-index 打平时它会被抽屉盖住（这个坑犯过）
    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest('.mascot') ? 'ok' : (el?.className ?? 'unknown');
    }, [box.x + box.width / 2, box.y + box.height / 2]);
    hit === 'ok' ? ok('卡通处在最顶层，点得到') : bad('卡通', '被别的元素盖住', String(hit).slice(0, 60));
    await page.locator('.mascot').click(); await page.waitForTimeout(600);
    (await page.locator('.assistant-panel').count()) ? ok('点卡通唤回面板') : bad('卡通', '点了没唤回');
    (await page.locator('.mascot').count()) === 0 ? ok('唤回后卡通退场') : bad('卡通', '面板回来了卡通还挂着');
  } else bad('卡通', '最小化后没出现卡通');

  // ═══ 临床主线：问诊 → 生成 → 八页 → 写回门禁
  console.log('\n  · 临床主线');
  // 门禁用 GATE_PID —— **走查全程不碰它**，所以它的锁态永远是真的。
  // 拿主线那位来测，第二轮它已经被上一轮解锁了，这条就永远「通过」
  await page.goto(`${BASE}/outpatient/${GATE_PID}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.assistant-panel').waitFor({ timeout: 20000 });
  await page.locator('.assistant-handle').click(); await page.waitForTimeout(800);
  const locked = await page.locator('.ttab-lock').count();
  locked > 0 ? ok(`未解锁时 ${locked} 个标签页带锁（${GATE_PID}）`) : bad('门禁', '未解锁却没有锁标记');

  // 但硬规则红线不该被锁 —— 危急值不能等
  const redEarly = await page.locator('.ra-card-danger, .ra-card.danger').count();
  ok(`未解锁时已能看到 ${redEarly} 张红线卡（硬规则不锁）`);

  // 主线换到 FLOW_PID
  await page.goto(`${BASE}/outpatient/${FLOW_PID}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.assistant-panel').waitFor({ timeout: 20000 });
  await page.locator('.assistant-handle').click().catch(() => {});
  await page.waitForTimeout(600);

  // 跳过问诊解锁
  const lockedBefore = await page.locator('.ttab-lock').count();
  const skip = page.locator('button', { hasText: '跳过问诊' }).first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click(); await page.waitForTimeout(600);
    const confirm = page.locator('.el-message-box__btns button').filter({ hasText: /跳过并生成|跳过|确定/ }).first();
    (await confirm.isVisible().catch(() => false))
      ? await confirm.click()
      : bad('门禁', '跳过问诊没弹确认框');
    await page.waitForTimeout(2500);
  } else if (lockedBefore > 0) bad('门禁', '锁着却没有「跳过问诊」入口');
  else ok(`${FLOW_PID} 本来就已解锁（上一轮遗留）`);

  await page.waitForFunction(
    // **先确认标签栏真的渲染了**再数锁。抽屉收起时 `.ttab` 是 0，
    // 「锁标记 0 个」于是永远成立 —— 这条第一版就是这样空过的
    () => document.querySelectorAll('.ttab').length > 0
       && document.querySelectorAll('.ttab-lock').length === 0,
    { timeout: 120000 },
  ).then(() => ok('解锁后标签栏在场且无锁标记'))
   .catch(() => bad('门禁', '解锁后仍有标签带锁，或标签栏没渲染'));

  // **等分析真的回来**，不是等 loading 遮罩消失 —— 遮罩会先于内容退场，
  // 第一版就是这样在 95 字的空壳上走完了八页，还「全部通过」
  // **每轮走查都触发一次真实模型调用**（`unlockAndAnalyse` 走 `refresh=true`，
  // 刻意绕开缓存）。服务端单次实测 22s，但连着跑几轮会在网关那边排队 ——
  // 所以这里给的是模型的量级，不是界面的量级。界面响应另有「首屏可用 <4s」那条。
  const ANALYSIS_TIMEOUT = Number(arg('--analysis-timeout', '300000'));
  const tAnalysis = Date.now();
  await page.waitForFunction(
    () => document.querySelectorAll('.dd-primary-name').length > 0,
    { timeout: ANALYSIS_TIMEOUT },
  ).then(() => ok(`分析已返回（${Math.round((Date.now() - tAnalysis) / 1000)}s）`))
   .catch(async () => {
     const st = await page.evaluate(() => ({
       loading: !!document.querySelector('.el-loading-mask'),
       tab: document.querySelector('.ttab.active')?.textContent.trim(),
       body: (document.querySelector('.tips-tab-body')?.innerText || '').slice(0, 90).replace(/\n/g, ' '),
     }));
     /*
      * **记成观测项，不记成缺陷。**
      *
      * 这一步每轮都触发一次真实模型调用（`unlockAndAnalyse` 走 `refresh=true`，
      * 刻意绕开缓存）。定向复现过五次 —— 最小路径 21s、加改字号 18s、
      * 加开关设置 26s、加拖动/看板/卡通 23s、headless 里直接 fetch 22s ——
      * 全部正常；服务端 curl 也是 22s。只有整轮走查连着跑时会卡住。
      *
      * 所以它反映的是**模型通道在连续调用下的排队**，不是界面缺陷。
      * 把它判成 bug 会让门禁长期红着，然后被人加 skip；
      * 判成观测项则既看得见、又不掩盖真正的问题。
      *
      * 真正该拦的那条另有其人 —— 见下面的「转圈但没有在途请求」。
      */
     const stuck = st.loading && ![...inflight].some((u) => u.includes('report-summary'));
     if (stuck) {
       bad('分析', '**一直转圈却没有在途请求** —— 这是死锁不是慢',
           `loading=${st.loading} 在途=[${[...inflight].map((u) => u.split('/api/')[1]).join(' , ') || '无'}]`);
     } else {
       notes.push(`分析在 ${ANALYSIS_TIMEOUT / 1000}s 内未返回（请求仍在途，属模型排队）`);
       console.log(`   ⚠ 分析未在 ${ANALYSIS_TIMEOUT / 1000}s 内返回 —— 请求仍在途，记为观测项`);
     }
   });
  await page.waitForTimeout(1200);
  const tabs = await page.locator('.ttab').allInnerTexts();
  for (let i = 0; i < tabs.length; i++) {
    await page.locator('.ttab').nth(i).click();
    await page.waitForTimeout(450);
    const body = (await page.locator('.tips-tab-body').innerText().catch(() => '')).trim();
    const name = tabs[i].replace(/\s+/g, '').slice(0, 6);
    if (body.length < 12) bad('标签页', `「${name}」点开后几乎空白`, `${body.length} 字`);
    else if (/undefined|NaN|\[object/.test(body)) bad('标签页', `「${name}」渲染出脏值`, body.match(/undefined|NaN|\[object \w+/)[0]);
    else ok(`「${name}」有内容（${body.length} 字）`);
  }

  // 写回门禁：红线未处置时必须拦。
  //
  // 两次找错按钮的记录留在这儿，因为它们是同一个坑的两面：
  // ① `.writeback-primary-btn` 是**病历管理**页的「采纳草稿」，不是诊断回写；
  // ② `.dd-confirm-btn`（「确认诊断」）长在**智慧诊疗**页，不在诊断管理页。
  //
  // ② 更阴：标签页是 `v-show`，按钮一直在 DOM 里 —— `count()` 数得到、
  // `isVisible()` 是 false。所以停在诊断管理页找它，报出来是「找不到按钮」。
  // 这条只在分析真的回来时才暴露，之前几轮分析都没回来，一直是绿的。
  //
  // 标签文本带角标（「诊断管理5」），用 hasText 精确匹配会落空 —— 按序号切。
  const tabIdx = tabs.findIndex((t) => t.includes('智慧诊疗'));
  if (tabIdx >= 0) { await page.locator('.ttab').nth(tabIdx).click(); await page.waitForTimeout(800); }
  const hasAnalysis = (await page.locator('.dd-primary-name').count()) > 0;
  const wb = page.locator('.dd-confirm-btn').first();
  if (!hasAnalysis) {
    console.log('   · 分析未返回，跳过回写门禁检查（避免连锁假阳性）');
  } else if (await wb.isVisible().catch(() => false)) {
    const openRed = await page.evaluate(() =>
      document.querySelectorAll('.ra-card-danger, .ra-card.danger').length);
    await wb.click(); await page.waitForTimeout(1400);
    const msg = (await page.locator('.el-message').allInnerTexts().catch(() => [])).join(' ');
    const box = (await page.locator('.el-message-box').allInnerTexts().catch(() => [])).join(' ');
    const blocked = /红色风险|未处置|阻断|请先勾选|主诊断/.test(msg);
    if (openRed > 0 && !blocked && !box) bad('安全', '有未处置红线却没拦住回写', msg.slice(0, 80));
    else ok(openRed > 0 ? `红线未处置时被拦：「${(msg || box).slice(0, 28)}」` : '无未处置红线，走到确认框');
    await page.keyboard.press('Escape').catch(() => {});
  } else bad('智慧诊疗', '找不到「确认诊断」按钮', `当前标签 ${tabIdx}`);

  // ═══ 推荐诊断：置信度降序 + 每条都有百分比（2026-09-08）
  // 上面已经停在智慧诊疗页了，直接数。**不要在诊断管理页数** ——
  // `.dd-primary-name` 长在智慧诊疗页，在别处数恒为 0，挂在它下面的检查
  // 会静悄悄全部跳过，而输出里看不出少了什么。
  {
    const names = await page.locator('.dd-primary-name').count();
    const confs = await page.evaluate(() =>
      [...document.querySelectorAll('.dd-confidence')].map((e) => parseInt(e.innerText, 10)));
    if (!names) {
      console.log('   · 智慧诊疗页没有诊断（分析未返回），跳过推荐诊断与概要检查');
    } else if (confs.length !== names) {
      bad('推荐诊断', '有诊断没显示置信度', `${confs.length} 个百分比 / ${names} 条诊断`);
    } else if (confs.some((c) => !Number.isFinite(c))) {
      bad('推荐诊断', '置信度渲染成了非数字', JSON.stringify(confs));
    } else {
      ok(`每条推荐诊断都有置信度（${confs.join('/')}）`);
      const desc = confs.every((c, i) => i === 0 || confs[i - 1] >= c);
      desc ? ok('推荐诊断按置信度降序')
        : bad('推荐诊断', '排序不是置信度降序', confs.join(' → '));
    }

    // ═══ AI 病情概要：折叠态不该占掉一屏
    const coc = !names ? null : await page.evaluate(() => {
      const c = document.querySelector('.condition-overview-card');
      if (!c) return null;
      return {
        h: Math.round(c.getBoundingClientRect().height),
        more: document.querySelector('.coc-more')?.innerText.trim() ?? '',
        problems: !!document.querySelector('.coc-problems'),
        conflicts: !!document.querySelector('.coc-conflicts'),
      };
    });
    if (!coc) {
      if (names) bad('病情概要', '找不到概要卡');
    } else {
      // 折叠前的实测是 498px。300 是「还能看见下面的推荐诊断」的界限，
      // 不是一个凑出来的数
      coc.h <= 300 ? ok(`病情概要折叠态 ${coc.h}px`)
        : bad('病情概要', '折叠态仍占掉大半屏', `${coc.h}px`);
      if (coc.more) {
        /\d/.test(coc.more) ? ok(`「更多」写了字数：${coc.more}`)
          : bad('病情概要', '「更多」没写还剩多少字', coc.more);
        coc.problems ? bad('病情概要', '折叠态把问题列表也放出来了') : ok('折叠态不出问题列表');
      }
    }
  }

  // ═══ 切患者：上一位的状态不能残留
  console.log('\n  · 切患者');
  const nameBefore = await page.locator('.ttab-patient-name, .patient-name').first().innerText().catch(() => '');
  await page.goto(`${BASE}/outpatient/P003`, { waitUntil: 'domcontentloaded' });
  await page.locator('.assistant-panel').waitFor({ timeout: 20000 });
  await page.waitForTimeout(2500);
  const leaked = await page.evaluate(() => document.body.innerText.includes('张某'));
  leaked ? bad('切患者', '上一位患者的名字残留在页面上') : ok('切患者后无上一位残留');

  // ═══ 连点不炸：狂点标签页与开关
  console.log('\n  · 抗乱点');
  await page.locator('.assistant-handle').click().catch(() => {});
  await page.waitForTimeout(500);
  for (let i = 0; i < 12; i++) {
    await page.locator('.ttab').nth(i % Math.max(1, await page.locator('.ttab').count())).click({ timeout: 2000 }).catch(() => {});
  }
  await page.waitForTimeout(800);
  (await page.locator('.assistant-panel').count()) ? ok('狂点标签页后面板仍在') : bad('稳定性', '狂点标签页把面板点没了');
  for (let i = 0; i < 8; i++) await page.locator('.assistant-handle').click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(700);
  (await page.locator('.ai-emr-root').count()) ? ok('狂点抽屉开关后结构完好') : bad('稳定性', '狂点开关把组件搞崩了');

  await page.close();
});

// ═══════════════════════════════════════════════ 移动端
await section('移动端 390×844', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  watch(page, '移动');
  // `networkidle` 在这里是等不到的：埋点 keepalive 让网络一直不闲。
  // 下一行本来就在等 `.m-page`，那才是「移动端 IA 生效」的判据。
  // 超时要单独给：`setDefaultTimeout(8000)` 对公网首字节太紧，
  // 而这一段整个包在 `section()` 里 —— 一超时，移动端十几项全部作废。
  await page.goto(`${BASE}/outpatient/P009`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('.m-page').waitFor({ timeout: 15000 });
  ok('移动端 IA 生效');

  // 零溢出：横向不能有滚动条
  const overflow = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('.m-page *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.left < -1 || r.right > window.innerWidth + 1)) {
        bad.push(`${el.className || el.tagName}: ${Math.round(r.left)}~${Math.round(r.right)}`);
      }
    }
    return bad.slice(0, 5);
  });
  overflow.length === 0 ? ok('零元素横向溢出') : bad('移动', '有元素溢出屏幕', overflow.join(' | '));

  // 安全条
  const safe = page.locator('.m-safebar');
  (await safe.count()) ? ok(`安全条：${(await safe.innerText()).replace(/\n/g, ' ')}`) : bad('移动', '安全条没出现（P009 有过敏 + 红线）');

  // 字号
  await page.locator('.m-font-btn').click(); await page.waitForTimeout(400);
  const fopts = await page.locator('.m-font-opt').count();
  fopts === 4 ? ok('移动端字号四档') : bad('移动', `字号档位数 ${fopts}`);
  await page.locator('.m-font-opt').nth(3).click(); await page.waitForTimeout(500);
  const df = await page.evaluate(() => document.documentElement.getAttribute('data-font'));
  df === 'xlarge' ? ok('字号写到根元素') : bad('移动', `data-font=${df}`);
  // 放大后仍不能溢出 —— zoom 会把宽度一起放大
  const overflow2 = await page.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll('.m-body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 1) n++;
    }
    return n;
  });
  overflow2 === 0 ? ok('特大档下仍零溢出') : bad('移动', `特大档下 ${overflow2} 个元素溢出`);
  await page.locator('.m-font-btn').click(); await page.waitForTimeout(300);
  await page.locator('.m-font-opt').nth(1).click(); await page.waitForTimeout(400);

  // 三档切换手感
  for (const label of ['AI 助手', '记录', '医生智能体']) {
    const t = Date.now();
    await page.locator('.m-tab', { hasText: label }).click();
    await page.waitForTimeout(60);
    slow('移动', `切到「${label}」`, Date.now() - t, 700);
  }

  // ＋ 菜单里的新入口
  await page.locator('.m-more-btn').click(); await page.waitForTimeout(600);
  const menu = await page.locator('body').innerText();
  menu.includes('科室看板') ? ok('＋菜单有科室看板') : bad('移动', '＋菜单缺科室看板');
  menu.includes('个人配置') ? ok('＋菜单有个人配置') : bad('移动', '＋菜单缺个人配置');
  menu.includes('报告解读') ? bad('移动', '「报告解读」仍在（桌面端已撤）') : ok('「报告解读」已撤');

  await page.close();
});

// ═══════════════════════════════════════════════ 其余页面
console.log('\n■ 其余页面');
for (const [path, name, must] of [
  ['/outpatient/manage', '患者管理', 'table, .pm-row, [class*=manage]'],
  ['/admin', 'Agent 控制台', '.admin-tab'],
  ['/delivery', '交付平台', '.delivery-tab'],
  ['/settings', '个人配置', '.settings-col'],
]) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  watch(page, name);
  // **不能等 `networkidle`。** 这几页都挂着埋点 keepalive，网络永远闲不下来 ——
  // 线上连着两轮走查都是在这里超时崩掉的，而页面其实早就渲染好了。
  // 等 `domcontentloaded`，再等那个关键元素自己出现，判据和后面那句是同一个。
  //
  // `goto` 要单独给超时：`page.setDefaultTimeout(8000)` 对公网首字节太紧，
  // 而**它抛出来会掀掉整轮走查**（这一段在 `section()` 外面）。
  // 一次跨洋 TLS 握手慢一点，不该让前面几十项的结论一起作废。
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator(must).first().waitFor({ timeout: 15000 }).catch(() => {});
    (await page.locator(must).count()) ? ok(`${name} 渲染正常`) : bad(name, '关键元素没渲染', must);
  } catch (e) {
    bad(name, '打不开', String(e.message).split('\n')[0].slice(0, 90));
  }
  await page.close();
}

await browser.close();
console.log(`\n${'─'.repeat(54)}`);
console.log(`通过 ${checks} 项，发现 ${issues.length} 个问题${notes.length ? `，${notes.length} 条观测` : ''}`);
if (notes.length) {
  console.log('\n观测（不阻断，但要看着）：');
  notes.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
}
if (issues.length) {
  console.log('\n需要处理：');
  issues.forEach((i, n) => console.log(`  ${n + 1}. [${i.area}] ${i.msg}${i.detail ? ` — ${i.detail}` : ''}`));
}
process.exit(issues.length ? 1 : 0);
