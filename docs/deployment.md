# 部署与安全说明

## 1. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8765` | 生产端口 |
| `HOST` | `127.0.0.1` | 监听地址。**改成 `0.0.0.0` 前必须先配置 `APP_AUTH_TOKEN`** |
| `APP_SECRET_KEY` | 无 | 敏感字段加密密钥（≥8 字符）。未配置时 AI Key / webhook 明文落库 |
| `APP_AUTH_TOKEN` | 无 | 访问令牌（≥8 字符）。配置后除 `/api/health` 外都需凭据 |
| `ENABLE_MONITOR` | 开启 | 设为 `0` 关闭收盘后自动调度 |
| `DATA_DIR` | `./data` | SQLite 与运行数据目录 |
| `CACHE_DIR` | `./.cache` | 行情与份额缓存目录 |
| `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` | 无 | AI 配置的环境变量回退（数据库配置优先） |

## 2. 安全边界

**必须做的：**

1. `APP_SECRET_KEY` 设为随机长串（例如 `openssl rand -base64 32`）；
2. 对外监听（`HOST=0.0.0.0`）时**必须**设置 `APP_AUTH_TOKEN`，否则任何人可调用回测、触发 AI（消耗你的 token）；
3. 反向代理加 TLS，不要用明文 HTTP 暴露到公网；
4. `data/app.db` 与 `.cache/` 只给服务账号读权限。

**实现说明：**

- 敏感字段（AI apiKey、通知 webhook / botToken / secret）用 AES-256-GCM 加密后落库，密钥由 `APP_SECRET_KEY` 经 scrypt 派生；
- 未配置密钥时**降级为明文并在启动日志告警**——不静默假装安全；
- 历史明文数据在配置密钥后仍可读（解密函数识别非加密前缀原样返回），但不会自动重新加密；如需彻底加密，重新保存一次对应配置即可；
- 鉴权支持 `Authorization: Bearer <token>`、`X-Auth-Token`、`?token=` 三种方式；比较用常量时间；
- 前端把 token 存 `localStorage`，401 时提示一次输入。

**当前已知限制：**

- 单用户，无角色与多租户；
- 无速率限制（公网部署建议在反向代理层限流）；
- 无审计日志（仅通知发送有日志）；
- 密钥轮换需要重新保存相关配置（旧密文无法用新密钥解密）。

## 3. Linux（systemd）

```ini
# /etc/systemd/system/sse-etf-viewer.service
[Unit]
Description=SSE ETF Wyckoff Strategy
After=network-online.target

[Service]
Type=simple
User=etf
WorkingDirectory=/opt/sse-etf-viewer
Environment=NODE_ENV=production
Environment=PORT=8765
Environment=HOST=127.0.0.1
Environment=APP_SECRET_KEY=请替换为随机值
# 对外暴露时再打开：
# Environment=HOST=0.0.0.0
# Environment=APP_AUTH_TOKEN=请替换为随机值
ExecStart=/usr/bin/node server/prod.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
npm ci
npm run build
sudo systemctl daemon-reload
sudo systemctl enable --now sse-etf-viewer
journalctl -u sse-etf-viewer -f
```

调度依赖进程常驻。服务停机期间的信号不会实时推送，重启后会补算最新交易日；落后过多的模拟盘订单会被标记 `missed` 而不是伪造成交。

## 4. Windows

用任务计划或 NSSM 让 `node server/prod.js` 常驻：

```powershell
# NSSM 示例
nssm install SseEtfViewer "C:\Program Files\nodejs\node.exe" "server\prod.js"
nssm set SseEtfViewer AppDirectory "E:\github-project\sse-etf-viewer"
nssm set SseEtfViewer AppEnvironmentExtra APP_SECRET_KEY=请替换为随机值
nssm start SseEtfViewer
```

用任务计划时选「不管用户是否登录都运行」，并设置失败重启。

## 5. 反向代理（Nginx）

```nginx
server {
  listen 443 ssl http2;
  server_name etf.example.com;

  ssl_certificate     /etc/ssl/etf.crt;
  ssl_certificate_key /etc/ssl/etf.key;

  location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 300s;   # 长区间回测与 AI 调用可能较慢
  }
}
```

鉴权可以两层：Nginx 的 Basic Auth 挡在外面，应用内 `APP_AUTH_TOKEN` 作为第二道。

## 6. 备份

需要备份的只有 `data/app.db`（策略、版本、模拟盘、信号、配置）与 `.cache/`（可重建，非必须）。

```bash
sqlite3 data/app.db ".backup 'backup-$(date +%F).db'"
```

若 `APP_SECRET_KEY` 丢失，备份中的加密字段将无法解密——把密钥一起纳入密钥管理。

## 7. 健康检查

`GET /api/health` 免鉴权，返回 `{"ok":true}`，适合作为负载均衡与监控探活。
