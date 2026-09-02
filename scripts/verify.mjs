#!/usr/bin/env node
/**
 * 门禁总控。`npm run verify` 的入口。
 *
 * 它替换的是原来那串 `npm run a && npm run b && ...`。换掉的理由只有一个：
 * **那串命令的结果只存在于终端里。** 失败了要靠人复述，过了也说不清各项耗时多少。
 * 交付平台要展示门禁，就必须有人把结果写成结构化的东西。
 *
 * 行为与原来那串 `&&` 完全一致：同样的门禁、同样的顺序、**同样的 fail-fast**，
 * 任一项非零立即停止并以非零退出。别的都可以变，这条不能 —— 门禁的价值就在于挡住。
 *
 * 上报是**尽力而为**：`DELIVERY_API` 与 `DELIVERY_INGEST_TOKEN` 都配了才上报，
 * 上报失败只打一行警告，绝不影响门禁结论。门禁是目的，遥测不是。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'build', 'gates');

const API = process.env.DELIVERY_API || '';
const TOKEN = process.env.DELIVERY_INGEST_TOKEN || '';

/** 取最后一行有内容的输出。所有 extract 失败时的兜底。 */
const lastLine = (s) => s.trim().split('\n').filter((l) => l.trim()).pop() || '';

/** 从输出里抓一个正则，抓不到就退回最后一行 —— 不编，也不留空。 */
const grab = (re, fmt) => (out) => {
  const m = out.match(re);
  return m ? fmt(m) : lastLine(out);
};

const dirSizeMb = (dir) => {
  let bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else bytes += statSync(p).size;
    }
  };
  try { walk(dir); } catch { return ''; }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

/**
 * 门禁清单。`stage` 是流水线看板上的粗粒度阶段，多个门禁可以落在同一阶段 ——
 * 看板要一眼看完，制品详情才逐项展开。两种粒度各有其用，不必强行统一。
 */
const GATES = [
  {
    key: 'typecheck', stage: '类型与单测', label: '类型检查',
    cmd: 'npm', args: ['run', '--silent', 'typecheck'],
    extract: (out) => (out.trim() ? lastLine(out) : 'vue-tsc 通过 · 0 error'),
  },
  {
    key: 'test:web', stage: '类型与单测', label: '前端单测',
    cmd: 'npm', args: ['run', '--silent', 'test:web'],
    extract: grab(/Tests\s+(\d+) passed[^\n]*/, (m) => `${m[1]} passed`),
  },
  {
    key: 'test:api', stage: '类型与单测', label: '后端单测',
    cmd: 'npm', args: ['run', '--silent', 'test:api'],
    extract: grab(/(\d+) passed/, (m) => `${m[1]} passed`),
  },
  {
    key: 'build', stage: '构建', label: '前端构建',
    cmd: 'npm', args: ['run', '--silent', 'build'],
    extract: () => `dist ${dirSizeMb(join(ROOT, 'apps', 'web', 'dist'))}`,
  },
  {
    key: 'contracts', stage: '契约导出', label: '契约导出',
    cmd: 'npm', args: ['run', '--silent', 'contracts:export'],
    extract: grab(/(\d+)\s*个路径/, (m) => `OpenAPI ${m[1]} 路径`),
  },
  {
    key: 'fidelity', stage: '界面还原度', label: '界面还原度',
    cmd: 'npm', args: ['run', '--silent', 'fidelity'],
    extract: grab(
      /合计比对 (\d+) 个元素：一致 (\d+)，有差异 (\d+)，缺失 (\d+)/,
      (m) => `${m[1]} 元素 · 一致 ${m[2]} · 差异 ${m[3]} · 缺失 ${m[4]}`,
    ),
  },
  {
    key: 'coverage', stage: '类名覆盖率', label: '类名覆盖率',
    cmd: 'npm', args: ['run', '--silent', 'coverage'],
    extract: grab(/合计缺失 (\d+) 个类名/, (m) => (m[1] === '0' ? '八页零缺失' : `缺失 ${m[1]} 个类名`)),
  },
];

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

function gitMeta() {
  const status = git('status', '--porcelain');
  const files = status ? status.split('\n').filter(Boolean).length : 0;
  const stat = git('diff', '--shortstat', 'HEAD');
  return {
    commit: git('rev-parse', '--short', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    subject: git('log', '-1', '--pretty=%s'),
    dirty_files: files,
    diffstat: stat,
  };
}

/**
 * 上报一次快照。失败只警告 —— 门禁是目的，遥测不是。
 *
 * 重试一次：界面还原度那一关要跑八九分钟，跑完紧接着的那次上报**每次都
 * `fetch failed`** —— keep-alive 的连接早被对端回收了，而 Node 的 fetch
 * 会先拿这条死连接试一次。隔一下重来就好。
 * 只重一次：它是遥测，不值得为它拖住门禁。
 */
async function report(payload) {
  if (!API || !TOKEN) return;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(`${API}/api/delivery/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-delivery-token': TOKEN, connection: 'close' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return;
      console.warn(`  ⚠ 上报失败 HTTP ${res.status}（不影响门禁）`);
      return; // 服务端明确拒绝了，重试没有意义
    } catch (err) {
      if (attempt === 2) console.warn(`  ⚠ 上报失败 ${err.message}（不影响门禁）`);
      else await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

const meta = gitMeta();
// **key 只认提交号，不掺工作区状态。**
// 早先把 clean/dirty 拼进 key，结果在 verify 与 deploy 之间随手改一个文档，
// key 就从 clean 翻成 dirty —— 同一次交付被拆成两条记录，看板上门禁全是「未开始」，
// 而门禁明明刚跑完全绿。工作区脏不脏是这次运行的**属性**，不是它的身份。
const runKey = `feature-${meta.commit || 'nogit'}`;
const results = [];

/** 粗粒度阶段快照：一个阶段下所有门禁都过才算过，有一个跑挂了就算挂。 */
function stageSnapshot() {
  const order = [...new Set(GATES.map((g) => g.stage))];
  // 两个数字口径不同，标清楚：working tree 含未跟踪文件，diffstat 只算已跟踪的。
  // 不标的话看板上会出现「28 个文件 · 18 files changed」这种自相矛盾的一行。
  const changed = [
    `工作区 ${meta.dirty_files} 个文件`,
    meta.diffstat ? `已跟踪 ${meta.diffstat.trim()}` : '',
  ].filter(Boolean).join(' · ');
  const stages = [{ name: '改动', status: 'passed', detail: changed, elapsed_ms: 0 }];
  for (const stage of order) {
    const own = results.filter((r) => r.stage === stage);
    const total = GATES.filter((g) => g.stage === stage).length;
    let status = 'idle';
    if (own.some((r) => !r.ok)) status = 'failed';
    else if (own.length === total && total > 0) status = 'passed';
    else if (own.length > 0) status = 'running';
    stages.push({
      name: stage,
      status,
      detail: own.map((r) => r.detail).filter(Boolean).join(' · '),
      elapsed_ms: own.reduce((a, r) => a + r.elapsed_ms, 0),
    });
  }
  return stages;
}

const payload = (status) => ({
  run_key: runKey,
  lane: 'feature',
  title: `${meta.commit}  ${meta.subject}`.trim(),
  subtitle: `分支 ${meta.branch}${meta.dirty_files ? ` · 工作区有 ${meta.dirty_files} 个未提交改动` : ''}`,
  status,
  stages: stageSnapshot(),
  meta: { ...meta, gates: results },
});

console.log(`门禁 · ${runKey}`);
if (!API || !TOKEN) console.log('（未配置 DELIVERY_API / DELIVERY_INGEST_TOKEN，本次不上报）');

let failed = null;
for (const gate of GATES) {
  process.stdout.write(`  ▸ ${gate.label} … `);
  const t0 = Date.now();
  const r = spawnSync(gate.cmd, gate.args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  const elapsed = Date.now() - t0;
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const ok = r.status === 0;
  // 失败时不要用 extract —— 它抓的是成功输出的形状，抓不到会退回最后一行，
  // 而失败时最后一行往往是无信息的 "npm ERR!"。直接给尾部原文更有用。
  const detail = ok ? gate.extract(out) : out.trim().split('\n').slice(-6).join(' ⏎ ').slice(0, 400);

  // **每一关的完整输出都落盘，通过的也落。**
  //
  // 一开始只在失败时打印尾部，结果第一次遇到「界面还原度报了缺失 14 但脚本 exit 0」
  // 时，那 14 个是谁全都没留下来 —— 只能重跑一遍去猜。
  // 通过与否是结论，输出是证据；证据不该因为结论是「过」就扔掉。
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${gate.key.replace(/[^\w.-]/g, '_')}.log`), out);

  results.push({ key: gate.key, label: gate.label, stage: gate.stage, ok, detail, elapsed_ms: elapsed });
  console.log(`${ok ? '✓' : '✗'} ${detail}  (${(elapsed / 1000).toFixed(1)}s)`);
  if (!ok) console.log(out.trim().split('\n').slice(-40).join('\n'));

  await report(payload(ok ? 'running' : 'failed'));
  if (!ok) { failed = gate; break; }
}

const status = failed ? 'failed' : 'passed';
await report(payload(status));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, 'latest.json'),
  `${JSON.stringify({ run_key: runKey, status, meta, gates: results, stages: stageSnapshot() }, null, 2)}\n`,
);

const total = results.reduce((a, r) => a + r.elapsed_ms, 0);
console.log(`\n${failed ? `✗ 门禁未过：${failed.label}` : '✓ 门禁全部通过'} · 合计 ${(total / 1000).toFixed(1)}s`);
console.log(`结果已写入 build/gates/latest.json`);

process.exit(failed ? 1 : 0);
