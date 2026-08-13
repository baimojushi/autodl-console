# AutoDL Console

当前安全加固版本：`2026-08-boot-guard`

Railway 托管的 AutoDL Pro 实例控制台。AutoDL Token 只保存在服务端。

## Boot Guard

Boot Guard 用于阻止绕过 Railway 控制台的 AutoDL 开机请求。

工作流程：

1. 用户通过 Railway 控制台调用 `/api/power-on`。
2. Railway 为这一次启动生成随机 nonce，并使用 `BOOT_GUARD_SECRET` 对启动凭证做 HMAC-SHA256 签名。
3. Railway 把一次性启动凭证加入 AutoDL `start_command`。
4. AutoDL 开机后下载仓库中的 `boot-guard-client.py`，通过 WSS 连接 `/ws/boot-guard`。
5. Railway 校验签名，并从 AutoDL `/list` API 读取当前实例 `started_at`，确认凭证属于当前这次启动。
6. 首次认证成功后，Railway 换发绑定当前 `started_at` 的 session token；后续 Railway 重启/重连使用它，旧启动凭证无法授权下一次启动。
7. AutoDL 保持 WebSocket 心跳.
8. Railway 独立轮询 AutoDL 状态。发现实例处于 `running`，却没有当前启动对应的合法 WebSocket attestation，超过短暂启动/重连宽限期后自动调用 `power_off`。

AutoDL API 不会把 `power_on` 调用者的来源 URL 传给实例。HMAC 启动凭证用于证明该启动由这台 Railway 服务授权，比依赖 Origin 或来源 IP 更可靠。

## Railway Variables

至少配置：

```text
AUTODL_TOKEN=你的AutoDL开发者Token
AUTODL_INSTANCE_UUID=pro-你的实例ID
DASHBOARD_KEY=至少7字节的随机值
BOOT_GUARD_SECRET=至少32字节的独立随机值
AUTODL_START_COMMAND=bash /root/zealman-app/start-comfyui.sh && bash /root/zealman-app/start-services.sh
```

生成 Boot Guard Secret：

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Railway 会自动提供 `RAILWAY_PUBLIC_DOMAIN`。使用自定义域名时，可显式设置：

```text
BOOT_GUARD_PUBLIC_ORIGIN=https://your-console.example.com
```

建议把 `AUTODL_TOKEN`、`BOOT_GUARD_SECRET` 设置成 Railway Sealed Variables。

## 安全变化

- `DASHBOARD_KEY` 强制配置，长度至少 7 字节。
- 控制台密钥只接受 `x-dashboard-key` 请求头。
- 浏览器不再控制 `start_command`；开机命令统一由 `AUTODL_START_COMMAND` 管理。
- `/api/power-on` 与 `/api/power-off` 增加轻量级内存限流。
- 鉴权连续失败会临时封禁来源 IP。
- 电源操作、鉴权失败和 Boot Guard 事件写入 `SECURITY_AUDIT` 日志。
- 增加 CSP、HSTS、frame protection、no-sniff、referrer/permissions policy。
- readiness probe 禁止跟随重定向，并默认只允许 `*.autodl.com`。
- 不新增 npm 依赖；WebSocket 服务端使用 Node 内置 HTTP upgrade，AutoDL 客户端只使用 Python 标准库。

## Boot Guard 默认时序

```text
轮询 AutoDL 状态：15 秒
新开机等待 WebSocket：90 秒
WebSocket 心跳失联容忍：120 秒
Railway 自身重启后的重连宽限：90 秒
启动凭证与 AutoDL started_at 最大间隔：20 分钟
```

## 日志排查

Railway 日志中搜索：

```text
SECURITY_AUDIT
power_on_requested
power_on_result
boot_guard_attestation_accepted
boot_guard_attestation_rejected
boot_guard_forced_power_off
dashboard_auth_failed
```

`boot_guard_forced_power_off` 的常见 reason：

- `missing_valid_railway_boot_attestation`
- `websocket_heartbeat_timeout`

日志不会输出 `AUTODL_TOKEN`、`BOOT_GUARD_SECRET` 或完整 boot token。

## 部署

覆盖仓库中的：

```text
server.js
.env.example
README.md
public/index.html
```

新增：

```text
public/boot-guard-client.py
```

保留现有：

```text
public/app.js
public/styles.css
package.json
package-lock.json
railway.json
```

部署前先在 Railway Variables 增加 `BOOT_GUARD_SECRET`。

测试顺序：

1. 从 Railway 页面正常开机，日志应出现 `boot_guard_attestation_accepted`。
2. 正常关机。
3. 从 AutoDL 官网直接开机一次。
4. 约 90–120 秒后，日志应出现 `boot_guard_forced_power_off`，实例自动关机。
