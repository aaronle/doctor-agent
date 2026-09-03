#!/usr/bin/env node
/**
 * 把线上环境重置到**演示初始态**。
 *
 * ## 为什么需要它
 *
 * 演示的主线叙事是「一进来只有医生智能体 → 问诊结束 → AI 助手自动展开、
 * 八页解锁」。而任何一次试跑（包括测试脚本）都会把患者解锁 ——
 * 下一次演示进去就直接看到全部结论，**那个卖点当场消失**，
 * 而界面上没有任何地方提示「这是上一轮留下的状态」。
 *
 * 2026-09-03 演示前就撞上了：全部六位患者都是已解锁态。
 *
 * ## 它清什么、不清什么
 *
 * | 清 | 不清 |
 * | --- | --- |
 * | `analysis_unlock`（解锁态） | 患者档案、检验、检查（种子） |
 * | 问诊记录 `voice_sessions` | 药品字典、评估目录 |
 * | 病历草稿 `record_drafts` | Agent 配置版本（控制台改的 Prompt） |
 * | 本次开的医嘱 / 转诊 / 住院 | `agent_runs`（运行记账，是历史证据） |
 * | 患者重新入队 | 审计日志（同上） |
 *
 * **不清 agent_runs 与审计日志**：它们是「这个系统跑过什么」的证据，
 * 演示时控制台那一页正要展示它们。清了反而没东西看。
 *
 * 用法：
 *   node scripts/demo-reset.mjs          # 预演，只报告要改什么
 *   node scripts/demo-reset.mjs --apply  # 真的改
 */
import { spawnSync } from 'node:child_process';

const HOST = process.env.DA_HOST || 'ubuntu@81.71.155.220';
const KEY = process.env.DA_SSH_KEY || `${process.env.HOME}/.ssh/id_ed25519`;
const DB = '/opt/doctor-agent/data/doctor-agent.db';
const APPLY = process.argv.includes('--apply');

// 在服务器上跑的那段 Python。写成字符串是因为容器 rootfs 只读，
// docker cp 进不去；宿主机自带 python3，数据库就在挂载卷上。
const script = `
import sqlite3, json, sys, shutil, datetime, subprocess
APPLY = ${APPLY ? 'True' : 'False'}
DB = "${DB}"

# 初始是否在候诊队列**以 fixture 为准**，不是一律入队。
#
# P007 在 fixture 里显式标了 in_queue: false —— 那是有意的：
# 「患者管理」页的「重新入队」功能需要一个不在队列的人才演得出来。
# 一律设成 1 会把那个功能的演示素材抹掉。
raw = subprocess.run(
    ["docker", "exec", "doctor-agent-mvp", "cat",
     "/app/references/ui-demo/extracted/fixtures/patients.json"],
    capture_output=True, text=True)
if raw.returncode == 0:
    INQ = {p["id"]: p.get("in_queue", True) is not False for p in json.loads(raw.stdout)}
else:
    print("! 读不到 fixture，in_queue 保持原样：", raw.stderr.strip()[:120])
    INQ = None

if APPLY:
    bk = DB + ".bak-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(DB, bk)
    print("已备份 →", bk)

c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

locked = []
for r in c.execute("select id, name, payload, in_queue from patients").fetchall():
    p = json.loads(r["payload"] or "{}")
    why = []
    if "analysis_unlock" in p: why.append("已解锁")
    # 「不在队列」对 P007 是**初始设定**，不是要修的东西 —— 见下面 INQ
    if not r["in_queue"] and (INQ is None or INQ.get(r["id"], True)):
        why.append("被移出队列")
    if why: locked.append((r["id"], r["name"], "、".join(why)))

counts = {t: c.execute(f"select count(*) from [{t}]").fetchone()[0]
          for t in ("voice_sessions", "record_drafts", "orders", "referrals", "admissions")}

print()
print("要重置的患者：")
for pid, name, why in locked or [("—","（无）","")]:
    print(f"  {pid} {name}  {why}")
print()
print("要清空的运行时数据：")
for t, n in counts.items():
    print(f"  {t:16} {n} 行")
print()
print("保留：patients 档案 / seed_documents / agent_versions / agent_runs / audit_logs")

if not APPLY:
    print()
    print("这是预演。加 --apply 才会真的改。")
    sys.exit(0)

for r in c.execute("select id, payload, in_queue from patients").fetchall():
    p = json.loads(r["payload"] or "{}")
    p.pop("analysis_unlock", None)
    inq = (1 if INQ.get(r["id"], True) else 0) if INQ is not None else r["in_queue"]
    c.execute("update patients set payload=?, in_queue=? where id=?",
              (json.dumps(p, ensure_ascii=False), inq, r["id"]))
for t in counts:
    c.execute(f"delete from [{t}]")
c.commit()

print()
print("已重置。复核：")
for r in c.execute("select id, name, payload, in_queue from patients").fetchall():
    p = json.loads(r["payload"] or "{}")
    print(f"  {r['id']} {r['name']:6} 解锁={'analysis_unlock' in p} 在队列={bool(r['in_queue'])}")
for t in counts:
    print(f"  {t:16} {c.execute(f'select count(*) from [{t}]').fetchone()[0]} 行")
`;

console.log(`演示重置 → ${HOST}${APPLY ? '' : '（预演）'}\n`);
const r = spawnSync('ssh', ['-i', KEY, HOST, 'python3', '-'], { encoding: 'utf8', input: script });
process.stdout.write(r.stdout || '');
if (r.stderr) process.stderr.write(r.stderr);
if (r.status !== 0) { console.error('✗ 重置失败'); process.exit(1); }
if (APPLY) console.log('\n✓ 演示环境已回到初始态');
