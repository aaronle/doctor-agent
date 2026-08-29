# Doctor Agent 广州 MVP 部署

## 目标架构

`da.aaronhealth.cn` 由宿主机 Nginx 终止 HTTPS，反向代理到只监听回环地址的
`doctor-agent-mvp` 单容器。容器同时提供 Vue 构建产物、FastAPI 产品 API、
六个接真实 Claude Haiku 的智能体，以及 SQLite 持久化。

```text
公网 443 -> 宿主机 Nginx -> 127.0.0.1:3400 -> doctor-agent-mvp:8000
                                                -> /app/data/doctor-agent.db
                                                -> https://www.meatdc.com/v1（模型网关，出网）
```

本 MVP 不运行 AgentScope、本地大模型、PostgreSQL、Redis、向量数据库或
Langfuse，且不允许使用真实患者数据。

## 服务器目录

```text
/opt/doctor-agent/
├── source/
├── config/.env.runtime
└── data/doctor-agent.db
```

`.env.runtime` 以 `env.runtime.example` 为模板，权限必须为 `600`，其中包含
`AI_API_KEY`。该文件不进 Git、不进日志、不下发前端、不出现在健康接口。

## 候选验证

```sh
docker compose -f deploy/tencent-guangzhou/docker-compose.yml build
docker compose -f deploy/tencent-guangzhou/docker-compose.yml up -d
curl -fsS http://127.0.0.1:3400/api/health
curl -fsSI http://127.0.0.1:3400/
```

健康接口必须返回：

| 字段 | 期望值 |
| --- | --- |
| `release` | `0.3.0-mvp` |
| `database` | `ready` |
| `ai` | `configured`（未配置密钥时为 `unconfigured`，全部岗位降级为本地规则） |
| `agents` | 6 个岗位 |
| `runtime_mode` | `live` |
| `data_classification` | `MOCK_ONLY_NO_REAL_PATIENT_DATA` |

再逐一验证七个功能：候诊列表 → 进入工作站 → 智慧诊疗聚合 → 预警评估处置 →
病历流式生成 → 诊断勾选与回写门禁 → 共病与营养会诊 → 语音问诊一轮。

## 出网依赖

容器需要访问模型网关 `https://www.meatdc.com/v1`。发布前先在服务器上实测：

```sh
curl -fsS -o /dev/null -w '%{http_code} %{time_total}s\n' https://www.meatdc.com/v1/models
```

不通则全部岗位会降级为本地规则 —— 界面仍可用且会显式标注降级，但不是预期状态。

## 域名和 HTTPS

1. 在 DNSPod 新建 `da.aaronhealth.cn -> 81.71.155.220` A 记录（**尚未创建**）。
2. 将 `nginx-da.aaronhealth.cn.conf.example` 安装为宿主机 Nginx 站点。
3. 执行 `nginx -t` 后重载 Nginx。
4. 用 Certbot 为 `da.aaronhealth.cn` 签发独立证书。
5. 公网逐功能验收。

Nginx 需要为两个 SSE 端点关闭缓冲（`proxy_buffering off`），否则病历流式
生成与语音追问会积压到结束才一次性吐出。

## 隔离约束

不得重启或修改同机 `aits-app`、`aaronhealth-site` 或 `comorbidity-mvp`；
`3400` 之外的端口不碰。
