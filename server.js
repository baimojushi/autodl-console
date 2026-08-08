const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const AUTODL_HOST = "https://api.autodl.com";
const APP_VERSION = "2026-08-mobile-status-fix";
const AUTODL_TOKEN = process.env.AUTODL_TOKEN;
const INSTANCE_UUID = process.env.AUTODL_INSTANCE_UUID;
const DASHBOARD_KEY = process.env.DASHBOARD_KEY || "";

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireDashboardKey(req, res, next) {
  if (!DASHBOARD_KEY) return next();
  const supplied = req.get("x-dashboard-key") || req.body?.dashboard_key;
  if (!safeEqual(supplied, DASHBOARD_KEY)) {
    return res.status(401).json({ code: "Unauthorized", message: "请输入控制台访问密钥" });
  }
  next();
}

function requireAutoDLConfig(req, res, next) {
  if (!AUTODL_TOKEN || !INSTANCE_UUID) {
    return res.status(503).json({
      code: "MissingConfig",
      message: "Railway 尚未配置 AUTODL_TOKEN 或 AUTODL_INSTANCE_UUID",
    });
  }
  next();
}

function autoDLRequest(method, endpoint, data) {
  return axios.request({
    method,
    baseURL: AUTODL_HOST,
    url: endpoint,
    data,
    // AutoDL 文档示例使用 GET + JSON body，但部分网关会忽略 GET body。
    // 同时发送 query 参数，兼容两种实现。
    params: method.toUpperCase() === "GET" ? data : undefined,
    headers: {
      Authorization: AUTODL_TOKEN,
      "Content-Type": "application/json",
    },
    timeout: 20000,
    validateStatus: () => true,
  });
}

async function autoDLRead(endpoint, body) {
  let response = await autoDLRequest("GET", endpoint, body);
  const code = response.data?.code;
  // 某些部署只接受 POST 读取接口；仅在接口返回失败时尝试兼容路径。
  if (response.status === 405 || response.status === 415 || (response.status === 200 && code && code !== "Success")) {
    const fallback = await autoDLRequest("POST", endpoint, body);
    if (fallback.status >= 200 && fallback.status < 300 && fallback.data?.code === "Success") {
      response = fallback;
    }
  }
  if (response.status < 200 || response.status >= 300 || response.data?.code !== "Success") {
    console.warn("AutoDL read failed", {
      endpoint,
      httpStatus: response.status,
      code: response.data?.code,
      message: response.data?.msg || response.data?.message,
    });
  }
  return response;
}

function sendAutoDLResponse(res, response) {
  if (response.status < 200 || response.status >= 300) {
    return res.status(response.status).json({
      code: "AutoDLHttpError",
      message: response.data?.msg || response.data?.message || `AutoDL HTTP ${response.status}`,
      detail: response.data,
    });
  }
  return res.status(200).json(response.data);
}

function domainUrl(domain, protocol = "https") {
  if (!domain) return null;
  const value = String(domain).trim();
  return /^https?:\/\//i.test(value) ? value : `${protocol}://${value}`;
}

function sanitizeSnapshot(payload) {
  const data = payload?.data || {};
  const usage = data.usage_info || {};
  return {
    regionSign: data.region_sign || null,
    gpuName: data.snapshot_gpu_alias_name || null,
    gpuPrice: data.payg_price ?? null,
    originPrice: data.origin_pay_price ?? null,
    cpuArch: data.cpu_arch || null,
    sshCommand: data.ssh_command || null,
    status: usage.valid === false ? null : usage.valid,
    usage: {
      cpuPercent: usage.cpu_usage_percent ?? null,
      memoryPercent: usage.mem_usage_percent ?? null,
      memoryUsed: usage.mem_usage ?? null,
      memoryLimit: usage.mem_limit ?? null,
      rootUsed: usage.root_fs_used_size ?? null,
      rootTotal: usage.root_fs_total_size ?? null,
      imageProgress: usage.pull_image_progress ?? null,
    },
    links: {
      jupyter: domainUrl(data.jupyter_domain),
      jupyterToken: data.jupyter_token || null,
      service6006: domainUrl(data.service_6006_domain, data.service_6006_port_protocol || "https"),
      service6008: domainUrl(data.service_6008_domain, data.service_6008_port_protocol || "https"),
    },
    raw: {
      jupyterDomain: data.jupyter_domain || null,
      service6006Domain: data.service_6006_domain || null,
      service6008Domain: data.service_6008_domain || null,
    },
  };
}

app.get("/health", (req, res) => {
  res.json({ ok: true, version: APP_VERSION, configured: Boolean(AUTODL_TOKEN && INSTANCE_UUID) });
});

app.get("/api/config", requireDashboardKey, (req, res) => {
  res.json({
    configured: Boolean(AUTODL_TOKEN && INSTANCE_UUID),
    instanceUuid: INSTANCE_UUID || null,
    protected: Boolean(DASHBOARD_KEY),
  });
});

app.get("/api/status", requireDashboardKey, requireAutoDLConfig, async (req, res) => {
  try {
    const response = await autoDLRead("/api/v1/dev/instance/pro/status", {
      instance_uuid: INSTANCE_UUID,
    });
    sendAutoDLResponse(res, response);
  } catch (error) {
    res.status(502).json({ code: "AutoDLUnavailable", message: error.message });
  }
});

app.get("/api/snapshot", requireDashboardKey, requireAutoDLConfig, async (req, res) => {
  try {
    const response = await autoDLRead("/api/v1/dev/instance/pro/snapshot", {
      instance_uuid: INSTANCE_UUID,
    });
    if (response.status < 200 || response.status >= 300) return sendAutoDLResponse(res, response);
    res.json({ code: response.data?.code || "Success", data: sanitizeSnapshot(response.data) });
  } catch (error) {
    res.status(502).json({ code: "AutoDLUnavailable", message: error.message });
  }
});

app.post("/api/power-on", requireDashboardKey, requireAutoDLConfig, async (req, res) => {
  try {
    const response = await autoDLRequest("POST", "/api/v1/dev/instance/pro/power_on", {
      instance_uuid: INSTANCE_UUID,
      payload: "gpu",
      start_command: String(req.body?.start_command || "sleep 1").slice(0, 1000),
    });
    sendAutoDLResponse(res, response);
  } catch (error) {
    res.status(502).json({ code: "AutoDLUnavailable", message: error.message });
  }
});

app.post("/api/power-off", requireDashboardKey, requireAutoDLConfig, async (req, res) => {
  try {
    const response = await autoDLRequest("POST", "/api/v1/dev/instance/pro/power_off", {
      instance_uuid: INSTANCE_UUID,
    });
    sendAutoDLResponse(res, response);
  } catch (error) {
    res.status(502).json({ code: "AutoDLUnavailable", message: error.message });
  }
});

// Keep SPA routing working when Railway serves a direct path.
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AutoDL console listening on ${PORT}`);
});
