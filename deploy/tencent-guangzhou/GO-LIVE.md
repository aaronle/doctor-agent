# da.aaronhealth.cn 上线收尾

> **状态：已于 2026-08-31 全部走完，站点在线。** 本文件转为重建/排障参照，步骤保持可复现。
> 第 3 步的 certbot 实际连挫三次才成，那不是配置问题 —— 原因与零成本探测方法见
> [`README.md`](README.md) 的「坑之四」。

原始背景：容器已在广州跑通并通过回环验收（`6e40c98`）。本文件只覆盖「让公网进得来」这一段。

前置参数全部来自工作区根目录的 `AARONHEALTH-CN-GUANGZHOU-RUNBOOK.md`，那是这台机器的权威档案。

| 参数 | 值 |
| --- | --- |
| 服务器 | 腾讯云轻量 `aaronhealth-cn-guangzhou-01`，`81.71.155.220`，Ubuntu 24.04，2C/4G |
| SSH | `ssh -i ~/.ssh/id_ed25519 ubuntu@81.71.155.220` |
| 本服务回环端口 | `127.0.0.1:3400` |
| 容器 / 镜像 | `doctor-agent-mvp` / `doctor-agent:0.3.0-mvp` |
| 同机勿动 | `aits-app`（3100）、`aaronhealth-site`（3200）、`comorbidity-mvp` |
| 备案 | `粤ICP备2026119734号`，主体乐颖 —— 子域名沿用主域名备案，不必另办 |

> SSH 私钥只在本机 `~/.ssh/id_ed25519`，**不得复制进工作区或 Git**。因此下列步骤必须在
> 本机执行，沙箱环境无出网、也拿不到私钥。

## 第 0 步 · 先确认容器还活着

改 DNS 之前先确认后端是好的，免得后面分不清是域名问题还是服务问题。

```sh
ssh -i ~/.ssh/id_ed25519 ubuntu@81.71.155.220 '
  sudo docker ps --filter name=doctor-agent-mvp --format "{{.Names}}\t{{.Status}}\t{{.Ports}}"
  curl -fsS http://127.0.0.1:3400/api/health
'
```

健康接口应返回 `release=0.3.0-mvp`、`database=ready`、`ai=configured`、6 个岗位、
`runtime_mode=live`、`data_classification=MOCK_ONLY_NO_REAL_PATIENT_DATA`。

`ai` 若是 `unconfigured`，说明 `.env.runtime` 里的 `AI_API_KEY` 没生效，全部岗位会降级为
本地规则 —— 界面能用但不是预期状态，先解决再往下走。

## 第 1 步 · DNSPod 加 A 记录（只能人工）

工作区和服务器上都没有 DNSPod API 凭据，脚本加不了。登录 DNSPod 控制台，在
`aaronhealth.cn` 下新增：

| 主机记录 | 类型 | 线路 | 记录值 | TTL |
| --- | --- | --- | --- | --- |
| `da` | A | 默认 | `81.71.155.220` | 600 |

加完等待生效，然后验证。**必须看到正确 IP 再往下走**，否则 certbot 的 HTTP-01 验证必失败：

```sh
dig +short da.aaronhealth.cn
# 期望输出：81.71.155.220
```

## 第 2 步 · 安装 Nginx 站点

```sh
scp -i ~/.ssh/id_ed25519 \
  deploy/tencent-guangzhou/nginx-da.aaronhealth.cn.conf.example \
  ubuntu@81.71.155.220:/tmp/da.aaronhealth.cn

ssh -i ~/.ssh/id_ed25519 ubuntu@81.71.155.220 '
  sudo mv /tmp/da.aaronhealth.cn /etc/nginx/sites-available/da.aaronhealth.cn
  sudo ln -sfn /etc/nginx/sites-available/da.aaronhealth.cn \
               /etc/nginx/sites-enabled/da.aaronhealth.cn
  sudo nginx -t && sudo systemctl reload nginx
'
```

`nginx -t` 不过就停下来看报错，别硬 reload —— 同机还有两个在跑的站点，配置错误会一起遭殃。

HTTP 通了先验一次：

```sh
curl -fsS http://da.aaronhealth.cn/api/health
```

## 第 3 步 · Certbot 签证书

同机已装 Certbot 2.9.0 + Nginx 插件，`certbot.timer` 已启用，续期是自动的。
签**独立证书**，不要并进 `aaronhealth.cn` 那张：

```sh
ssh -i ~/.ssh/id_ed25519 ubuntu@81.71.155.220 '
  sudo certbot --nginx -d da.aaronhealth.cn --non-interactive --agree-tos \
       --redirect --cert-name da.aaronhealth.cn
  sudo certbot certificates
'
```

**签完必须回头查一件事**：certbot 会改写站点配置来插入 443 server 块，要确认三个
`location` 块的特殊参数都活着 —— 尤其是 SSE 那两个端点的 `proxy_buffering off`。

```sh
ssh -i ~/.ssh/id_ed25519 ubuntu@81.71.155.220 \
  "sudo grep -n 'proxy_buffering\|proxy_read_timeout\|listen' /etc/nginx/sites-available/da.aaronhealth.cn"
```

丢了就手工补回 443 块再 `nginx -t && systemctl reload nginx`。漏掉这一步的症状是：
病历生成和语音追问不再逐字出现，而是转半天后一次性糊上来。

## 第 4 步 · 公网验收

```sh
curl -fsS https://da.aaronhealth.cn/api/health
curl -fsSI https://da.aaronhealth.cn/
```

再按 `README.md` 的口径逐功能过一遍：候诊列表 → 进入工作站 → 智慧诊疗聚合 →
预警评估处置 → 病历流式生成 → 诊断勾选与回写门禁 → 共病与营养会诊 → 语音问诊一轮。

SSE 是否真流式，用 `-N` 关掉 curl 自己的缓冲来看：

```sh
curl -N -X POST https://da.aaronhealth.cn/api/emr/copilot/chat \
  -H 'Content-Type: application/json' \
  -d '{"patient_id":"P001","messages":[{"role":"user","content":"风险如何"}]}'
```

token 应逐个到达，而不是最后一次性涌出。

## 第 5 步 · 确认没伤到邻居

```sh
ssh -i ~/.ssh/id_ed25519 ubuntu@81.71.155.220 '
  sudo docker ps --format "{{.Names}}\t{{.Status}}"
  curl -fsS -o /dev/null -w "aits   %{http_code}\n" http://127.0.0.1:3100/api/app?resource=health
  curl -fsS -o /dev/null -w "site   %{http_code}\n" http://127.0.0.1:3200/
  systemctl is-active nginx
'
```

## 回滚

只停自己的容器，不碰别人：

```sh
ssh -i ~/.ssh/id_ed25519 ubuntu@81.71.155.220 '
  cd /opt/doctor-agent/source
  sudo docker compose -f deploy/tencent-guangzhou/docker-compose.yml stop doctor-agent
'
```

禁止 `docker compose down`、`docker system prune -a`，以及对 `/opt/doctor-agent/data`
用 `rsync --delete`。三条都会波及同机其他服务或抹掉 SQLite。

站点要下线就摘软链后 reload，保留 `sites-available` 里的文件：

```sh
ssh -i ~/.ssh/id_ed25519 ubuntu@81.71.155.220 '
  sudo rm -f /etc/nginx/sites-enabled/da.aaronhealth.cn
  sudo nginx -t && sudo systemctl reload nginx
'
```
