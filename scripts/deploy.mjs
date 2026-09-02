#!/usr/bin/env node
/**
 * 部署到广州，并把每个阶段上报给交付平台。
 *
 * **这个脚本跑在开发机上，不在平台里。** 生产凭据（`~/.ssh/id_ed25519`）在这台机器上，
 * 平台没有也不该有 —— 交付平台负责触发与观测，不负责持有钥匙。
 * 界面上那句「本地执行」说的就是这件事，别把它当成待办事项。
 *
 * 阶段与 `deploy/tencent-guangzhou/GO-LIVE.md` 一一对应。README 里的四个坑
 * 已经落在这里的命令里，改命令前先去看那四条。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HOST = process.env.DA_HOST || 'ubuntu@81.71.155.220';
const KEY = process.env.DA_SSH_KEY || `${process.env.HOME}/.ssh/id_ed25519`;
const PUBLIC = process.env.DA_PUBLIC || 'https://da.aaronhealth.cn';
const API = process.env.DELIVERY_API || PUBLIC;
const TOKEN = process.env.DELIVERY_INGEST_TOKEN || '';
const COMPOSE = 'deploy/tencent-guangzhou/docker-compose.yml';

const git = (...a) => {
  try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; }
};
const commit = git('rev-parse', '--short', 'HEAD') || 'nogit';
const subject = git('log', '-1', '--pretty=%s');
// 与 verify.mjs 用同一条规则：key 只认提交号。两边不一致就配不上对，
// 门禁与部署会落在两条记录上。
const runKey = `feature-${commit}`;
const dirtyFiles = (git('status', '--porcelain') || '').split('\n').filter(Boolean).length;

const log = [];
const stages = [];
const stamp = () => new Date().toISOString().slice(11, 19);

const push = (name, status, detail, ms = 0) => {
  const at = stages.findIndex((s) => s.name === name);
  const row = { name, status, detail, elapsed_ms: ms };
  if (at >= 0) stages[at] = row; else stages.push(row);
};

async function report(status) {
  if (!TOKEN) return;
  try {
    const res = await fetch(`${API}/api/delivery/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-delivery-token': TOKEN },
      body: JSON.stringify({
        run_key: runKey, lane: 'feature',
        title: `${commit}  ${subject}`, subtitle: `分支 ${git('rev-parse', '--abbrev-ref', 'HEAD')}${dirtyFiles ? ` · 工作区有 ${dirtyFiles} 个未提交改动` : ''}`,
        status, stages, meta: { commit, subject, log: log.slice(-40) },
      }),
    });
    if (!res.ok) console.warn(`  ⚠ 上报失败 HTTP ${res.status}`);
  } catch (err) {
    // 部署中途容器会重启，这几秒上报必然失败。这不是错误，是这条链路的常态。
    console.warn(`  ⚠ 上报失败 ${err.message}（部署期间容器重启会导致此现象）`);
  }
}

function run(label, cmd, args, { tone = 'dim' } = {}) {
  process.stdout.write(`  ▸ ${label} … `);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  const ms = Date.now() - t0;
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  for (const line of out.split('\n').filter(Boolean).slice(-12)) {
    log.push([stamp(), line.slice(0, 160), r.status === 0 ? tone : 'err']);
  }
  console.log(`${r.status === 0 ? '✓' : '✗'} (${(ms / 1000).toFixed(1)}s)`);
  if (r.status !== 0) console.log(out.split('\n').slice(-30).join('\n'));
  return { ok: r.status === 0, out, ms };
}

/** 远端脚本从 stdin 送进 `bash -s`，避免为了引号转义把命令拧成一团。 */
function sshRun(label, script, tone = 'dim') {
  process.stdout.write(`  ▸ ${label} … `);
  const t0 = Date.now();
  const r = spawnSync('ssh', ['-i', KEY, HOST, 'bash', '-s'], { encoding: 'utf8', input: script });
  const ms = Date.now() - t0;
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  for (const line of out.split('\n').filter(Boolean).slice(-14)) {
    log.push([stamp(), line.slice(0, 160), r.status === 0 ? tone : 'err']);
  }
  console.log(`${r.status === 0 ? '✓' : '✗'} (${(ms / 1000).toFixed(1)}s)`);
  if (r.status !== 0) console.log(out.split('\n').slice(-30).join('\n'));
  return { ok: r.status === 0, out, ms };
}

console.log(`部署 ${runKey} → ${HOST}`);
if (!TOKEN) console.log('（未配置 DELIVERY_INGEST_TOKEN，本次不上报到交付平台）');

push('改动', 'passed', `${commit} ${subject}`);
await report('running');

// ── 1. rsync ───────────────────────────────────────────────────────────────
// **排除模式一律加前导斜杠锚定到根。** 写 `data` 会连 apps/api/app/data 一起排掉，
// 那是种子数据，少了它服务能起来但没有任何病例（README 坑之四）。
// node_modules 是有意不锚定的 —— 每个 workspace 下都有一份。
push('部署', 'running', 'rsync 源码');
await report('running');
const rs = run('rsync 源码 → /tmp/da-src', 'rsync', [
  '-az', '--delete',
  '--exclude', '/.git', '--exclude', 'node_modules', '--exclude', '/.venv',
  '--exclude', '/apps/web/dist', '--exclude', '/.env', '--exclude', '/data',
  '--exclude', '/build',
  '-e', `ssh -i ${KEY}`,
  './', `${HOST}:/tmp/da-src/`,
]);
if (!rs.ok) { push('部署', 'failed', 'rsync 失败'); await report('failed'); process.exit(1); }

// ── 2~4. 安装、构建、重建 ──────────────────────────────────────────────────
// --delete 的作用域必须只有 source/，绝不能指向 /opt/doctor-agent/ ——
// 持久化的 SQLite 在 /opt/doctor-agent/data 下，那一刀下去就没了。
const build = sshRun(
  '安装 → docker build → 重建容器',
  `set -e
rsync -a --delete /tmp/da-src/ /opt/doctor-agent/source/
cd /opt/doctor-agent/source
docker compose -f ${COMPOSE} build
docker compose -f ${COMPOSE} up -d --force-recreate doctor-agent
sleep 8
docker ps --format '{{.Names}}\t{{.Status}}'
`,
  'ok',
);
if (!build.ok) { push('部署', 'failed', '构建或重建失败'); await report('failed'); process.exit(1); }

// ── 5. 公网复验 ────────────────────────────────────────────────────────────
// 健康接口**不读** assessment_catalog.json 与 knowledge_base.json，
// 也不装配编排层 —— 这三个端点必须单独打一次（README 坑之四同类问题）。
const CHECKS = [
  ['health', '/api/health'],
  ['catalog', '/api/emr/assessment-catalog'],
  ['knowledge', '/api/emr/knowledge'],
  ['topology', '/api/orchestration/topology'],
  ['delivery', '/api/delivery/pipelines'],
  ['production', '/api/delivery/production'],
];
/**
 * 复验一个端点，最多三次、间隔 2 秒。
 *
 * 容器刚 `--force-recreate` 完，连接层会有几百毫秒的抖动：实测 health 刚过，
 * 紧接着 assessment-catalog 就抛了 —— 而单独再打三次全是 200 / 0.16s。
 * **一次抖动不该判定发布失败**：那会拦下发布记录，让一次成功的部署看着像坏的。
 *
 * 但重试次数要克制，且**首次失败必须留在日志里**。给到三次是因为它足够区分
 * 「正在起来」和「真的坏了」—— 一个两秒后还不响应的端点，就是坏的。
 * 抹掉重试痕迹的话，一个天天要重试两次的端点会一直看着很健康。
 */
async function probe(name, path) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${PUBLIC}${path}`, { signal: AbortSignal.timeout(30000) });
      if (res.status === 200) return { code: 200, attempt };
      if (attempt === 3) return { code: res.status, attempt };
      log.push([stamp(), `${name} 第 ${attempt} 次 HTTP ${res.status}，重试`, 'fix']);
    } catch (err) {
      if (attempt === 3) return { code: 0, attempt, error: err.message };
      log.push([stamp(), `${name} 第 ${attempt} 次失败（${err.message}），重试`, 'fix']);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { code: 0, attempt: 3 };
}

let bad = 0;
for (const [name, path] of CHECKS) {
  const { code, attempt, error } = await probe(name, path);
  const ok = code === 200;
  if (!ok) {
    bad += 1;
    if (error) log.push([stamp(), `${name} ${path} 请求失败：${error}`, 'err']);
  }
  // 重试过就把次数标出来，别让「第三次才通」看起来和「一次就通」一样
  const retried = attempt > 1 ? `  (第 ${attempt} 次才通)` : '';
  log.push([stamp(), `${name.padEnd(11)} ${code || '—'}  ${path}${retried}`, ok ? 'ok' : 'err']);
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(11)} ${code || '—'}  ${path}${retried}`);
}

// ── 5b. 分享卡片的 meta 真的按路由变了吗 ───────────────────────────────────
//
// 这一步查的是**一个不会报错的失效**：构建把 index.html 里的 SEO 标记吃掉之后，
// 注入静默退化成「所有页面共用同一张卡片」，页面本身完全正常、状态码全 200。
// 只有比对两条路径的 title 才看得出来。
{
  const titleOf = async (p) => {
    try {
      const html = await (await fetch(`${PUBLIC}${p}`, { signal: AbortSignal.timeout(20000) })).text();
      return (html.match(/<title>(.*?)<\/title>/) || [, ''])[1];
    } catch { return ''; }
  };
  const [home, admin] = await Promise.all([titleOf('/'), titleOf('/admin')]);
  const ok = home && admin && home !== admin;
  if (!ok) bad += 1;
  log.push([stamp(), `分享卡片  ${ok ? '按路由生效' : '未按路由生效'}：/ = ${home || '空'}｜/admin = ${admin || '空'}`, ok ? 'ok' : 'err']);
  console.log(`  ${ok ? '✓' : '✗'} 分享卡片    / = ${home || '(空)'}  |  /admin = ${admin || '(空)'}`);
}

// ── 6. 不能伤到邻居 ────────────────────────────────────────────────────────
// 同机还有 aits(3100) 与个人站(3200)。禁止 compose down、禁止 prune -a。
const neighbours = sshRun(
  '确认没伤到邻居',
  `curl -fsS -o /dev/null -w 'aits %{http_code}\\n' 'http://127.0.0.1:3100/api/app?resource=health' || echo 'aits FAIL'
curl -fsS -o /dev/null -w 'site %{http_code}\\n' http://127.0.0.1:3200/ || echo 'site FAIL'
systemctl is-active nginx
`,
  'ok',
);
if (!neighbours.ok || /FAIL|inactive/.test(neighbours.out)) bad += 1;

const ok = bad === 0;
push('部署', ok ? 'passed' : 'failed', ok ? '公网复验全绿' : `${bad} 项复验未过`, build.ms + rs.ms);
await report(ok ? 'deployed' : 'failed');

// 复验没全过就不记发布 —— 发布记录是「这一版在生产上跑着且是好的」，
// 不是「我推过一次」。记错了，回滚时会挑中一个本来就坏的版本。
if (ok && TOKEN) {
  try {
    await fetch(`${API}/api/delivery/releases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-delivery-token': TOKEN },
      body: JSON.stringify({
        commit,
        title: `${commit} ${subject}`,
        detail: `公网复验 ${CHECKS.length} 项全绿`,
        image: 'doctor-agent:0.3.0-mvp',
        meta: { checks: CHECKS.map(([n]) => n) },
      }),
    });
    console.log('  ✓ 已记入发布历史');
  } catch (err) {
    console.warn(`  ⚠ 发布记录写入失败：${err.message}`);
  }
}

console.log(`\n${ok ? '✓ 部署完成，公网复验全绿' : `✗ 部署完成但有 ${bad} 项复验未过`}`);
process.exit(ok ? 0 : 1);
