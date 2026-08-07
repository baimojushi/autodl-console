# AutoDL Console

一个适合部署到 Railway 的 AutoDL Pro 实例网页控制台。它把 AutoDL Token 保存在服务端，网页只负责查看状态、控制电源和打开实例服务入口。

## 功能

- 查询实例状态、GPU、区域、按量价格、CPU / 内存 / 系统盘使用率
- 启动实例（可填写开机命令）和关机
- 打开 JupyterLab、6006、6008 服务
- 自动每 10 秒刷新
- 可选的 `DASHBOARD_KEY` 访问保护
- Railway 健康检查：`/health`

## Railway 部署

1. 将这个 GitHub 仓库连接到 Railway，使用 Node.js / Nixpacks 构建。
2. 在 Railway Variables 添加：

   ```text
   AUTODL_TOKEN=你的AutoDL开发者Token
   AUTODL_INSTANCE_UUID=pro-你的实例ID
   DASHBOARD_KEY=一段足够长的随机密钥
   ```

3. Railway 会自动执行 `npm start`。打开 Railway 域名即可使用。

如果使用 GitHub Actions，仓库自带的 `.github/workflows/ci.yml` 会在每次推送和 Pull Request 时检查依赖安装与 JavaScript 语法。

`DASHBOARD_KEY` 为空时网页不要求登录；公开部署时强烈建议设置它。

## 本地运行

```bash
npm install
cp .env.example .env
# 编辑 .env
npm start
```

然后访问 <http://localhost:3000>。

## AutoDL 端口

你的应用需要在 AutoDL 容器内监听 `0.0.0.0:6006` 或 `0.0.0.0:6008`，并在 AutoDL 控制台中启用对应端口映射。服务地址由 AutoDL 的 snapshot API 动态返回，控制台不会硬编码域名。

## 计费提醒

这是按量计费实例控制台。停止使用后请点击“关机”；释放实例前必须先关机。项目没有放置“释放实例”按钮，避免误删实例。

## 安全

- 不要把 `AUTODL_TOKEN` 写入前端或提交到 GitHub。
- 只在 Railway Variables 中设置 Token。
- `DASHBOARD_KEY` 会通过请求头发送，并保存在当前浏览器会话的 `sessionStorage` 中。
- 生产环境建议再加 Railway / Cloudflare 的访问控制。
