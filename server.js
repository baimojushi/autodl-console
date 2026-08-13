const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const AUTODL_HOST = "https://api.autodl.com";
const APP_VERSION = "2026-08-boot-guard";

const AUTODL_TOKEN = String(process.env.AUTODL_TOKEN || "").trim();
const INSTANCE_UUID = String(process.env.AUTODL_INSTANCE_UUID || "").trim();
const DASHBOARD_KEY = String(process.env.DASHBOARD_KEY || "").trim();
const AUTODL_START_COMMAND =
  process.env.AUTODL_START_COMMAND ||
  "bash /root/zealman-app/start-comfyui.sh && bash /root/zealman-app/start-services.sh";

const COMFYUI_SERVICE_PORT = String(process.env.COMFYUI_SERVICE_PORT || "6006");
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 5000);
const AUTODL_SERVICE_HOST_SUFFIX = String(
  process.env.AUTODL_SERVICE_HOST_SUFFIX || ".autodl.com"
).toLowerCase();

const BOOT_GUARD_ENABLED = !["0", "false", "off", "no"].includes(
  String(process.env.BOOT_GUARD_ENABLED || "true").toLowerCase()
);
const BOOT_GUARD_SECRET = String(process.env.BOOT_GUARD_SECRET || "").trim();
const RAILWAY_PUBLIC_DOMAIN = String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
const BOOT_GUARD_PUBLIC_ORIGIN = String(
  process.env.BOOT_GUARD_PUBLIC_ORIGIN ||
    (RAILWAY_PUBLIC_DOMAIN ? `https://${RAILWAY_PUBLIC_DOMAIN}` : "")
).trim();

function envNumber(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

const BOOT_GUARD_POLL_MS = envNumber("BOOT_GUARD_POLL_MS", 15000, 5000, 300000);
const BOOT_GUARD_GRACE_MS = envNumber("BOOT_GUARD_GRACE_MS", 90000, 15000, 900000);
const BOOT_GUARD_HEARTBEAT_TIMEOUT_MS = envNumber(
  "BOOT_GUARD_HEARTBEAT_TIMEOUT_MS",
  120000,
  30000,
  900000
);
const BOOT_GUARD_RECONNECT_GRACE_MS = envNumber(
  "BOOT_GUARD_RECONNECT_GRACE_MS",
  90000,
  15000,
  900000
);
const BOOT_GUARD_AUTH_WINDOW_MS = envNumber(
  "BOOT_GUARD_AUTH_WINDOW_MS",
  20 * 60 * 1000,
  60000,
  60 * 60 * 1000
);
const BOOT_GUARD_PENDING_TTL_MS = envNumber(
  "BOOT_GUARD_PENDING_TTL_MS",
  5 * 60 * 1000,
  60000,
  15 * 60 * 1000
);

if (Buffer.byteLength(DASHBOARD_KEY, "utf8") < 7) {
  throw new Error("DASHBOARD_KEY must be configured and at least 7 bytes long");
}
if (BOOT_GUARD_ENABLED) {
  if (Buffer.byteLength(BOOT_GUARD_SECRET, "utf8") < 32) {
    throw new Error("BOOT_GUARD_SECRET must be configured and at least 32 bytes long");
  }
  if (!BOOT_GUARD_PUBLIC_ORIGIN) {
    throw new Error(
      "BOOT_GUARD_PUBLIC_ORIGIN or Railway-provided RAILWAY_PUBLIC_DOMAIN is required"
    );
  }
  const guardOrigin = new URL(BOOT_GUARD_PUBLIC_ORIGIN);
  if (guardOrigin.protocol !== "https:") {
    throw new Error("BOOT_GUARD_PUBLIC_ORIGIN must use https://");
  }
}

app.set("trust proxy", 1);
app.disable("x-powered-by");

const serverStartedAt = Date.now();
const powerRateBuckets = new Map();
const authFailureBuckets = new Map();

const guardState = {
  socket: null,
  bootStartedAtMs: null,
  tokenIssuedAtMs: null,
  nonce: null,
  connectedAtMs: null,
  lastSeenAtMs: null,
  localServices: null,
  pendingNonce: null,
  pendingIssuedAtMs: null,
};
let guardPollInFlight = false;
let guardPowerOffInFlight = false;
let guardLastForcedBootStartedAtMs = null;

function requestIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 120);
}

function audit(event, req, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    requestId: req?.requestId || null,
    ip: req ? requestIp(req) : null,
    method: req?.method || null,
    path: req?.originalUrl?.split("?")[0] || null,
    userAgent: req ? String(req.get("user-agent") || "").slice(0, 240) : null,
    ...extra,
  };
  console.log(`SECURITY_AUDIT ${JSON.stringify(entry)}`);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function consumeBucket(map, key, max, windowMs) {
  const now = Date.now();
  let item = map.get(key);
  if (!item || item.resetAt <= now) {
    item = { count: 0, resetAt: now + windowMs };
    map.set(key, item);
  }
  item.count += 1;
  return { allowed: item.count <= max, retryAfterMs: Math.max(0, item.resetAt - now) };
}

function powerRateLimit(req, res, next) {
  const result = consumeBucket(powerRateBuckets, requestIp(req), 8, 60_000);
  if (!result.allowed) {
    audit("power_rate_limited", req);
    res.set("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
    return res.status(429).json({ code: "RateLimited", message: "电源操作过于频繁，请稍后重试" });
  }
  next();
}

function requireDashboardKey(req, res, next) {
  const ip = requestIp(req);
  const existing = authFailureBuckets.get(ip);
  if (existing && existing.blockedUntil > Date.now()) {
    res.set("Retry-After", String(Math.ceil((existing.blockedUntil - Date.now()) / 1000)));
    return res.status(429).json({ code: "RateLimited", message: "鉴权失败次数过多，请稍后重试" });
  }

  const supplied = req.get("x-dashboard-key") || "";
  if (!safeEqual(supplied, DASHBOARD_KEY)) {
    const now = Date.now();
    let failure = authFailureBuckets.get(ip);
    if (!failure || failure.resetAt <= now) {
      failure = { count: 0, resetAt: now + 10 * 60_000, blockedUntil: 0 };
    }
    failure.count += 1;
    if (failure.count >= 8) failure.blockedUntil = now + 10 * 60_000;
    authFailureBuckets.set(ip, failure);
    audit("dashboard_auth_failed", req, { failures: failure.count });
    return res.status(401).json({ code: "Unauthorized", message: "请输入正确的控制台访问密钥" });
  }

  authFailureBuckets.delete(ip);
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

app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.set("X-Request-Id", req.requestId);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "no-referrer");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' wss:; " +
      "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  if (RAILWAY_PUBLIC_DOMAIN) {
    res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (req.path.startsWith("/api/")) {
    res.set("Cache-Control", "no-store");
  }
  next();
});

app.use(express.json({ limit: "16kb", strict: true }));
app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
    dotfiles: "deny",
    fallthrough: true,
  })
);

function autoDLRequest(method, endpoint, data) {
  return axios.request({
    method,
    baseURL: AUTODL_HOST,
    url: endpoint,
    data,
    params: method.toUpperCase() === "GET" ? data : undefined,
    headers: {
      Authorization: AUTODL_TOKEN,
      "Content-Type": "application/json",
      "User-Agent": `autodl-console/${APP_VERSION}`,
    },
    timeout: 20000,
    maxContentLength: 2 * 1024 * 1024,
    validateStatus: () => true,
  });
}

async function autoDLRead(endpoint, body) {
  let response = await autoDLRequest("GET", endpoint, body);
  const code = response.data?.code;
  if (
    response.status === 405 ||
    response.status === 415 ||
    (response.status === 200 && code && code !== "Success")
  ) {
    const fallback = await autoDLRequest("POST", endpoint, body);
    if (
      fallback.status >= 200 &&
      fallback.status < 300 &&
      fallback.data?.code === "Success"
    ) {
      response = fallback;
    }
  }
  if (
    response.status < 200 ||
    response.status >= 300 ||
    response.data?.code !== "Success"
  ) {
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
  const httpOk = response.status >= 200 && response.status < 300;
  const apiOk = !response.data?.code || response.data.code === "Success";
  if (!httpOk || !apiOk) {
    return res.status(httpOk ? 400 : response.status).json({
      code: response.data?.code || "AutoDLHttpError",
      message: response.data?.msg || response.data?.message || "AutoDL API error",
      detail: response.data,
    });
  }
  return res.status(200).json(response.data);
}

function domainUrl(domain) {
  if (!domain) return null;
  const value = String(domain).trim().replace(/^http:\/\//i, "https://");
  const result = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(result);
    if (parsed.protocol !== "https:") return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
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
      service6006: domainUrl(data.service_6006_domain),
      service6008: domainUrl(data.service_6008_domain),
    },
    raw: {
      jupyterDomain: data.jupyter_domain || null,
      service6006Domain: data.service_6006_domain || null,
      service6008Domain: data.service_6008_domain || null,
    },
  };
}

async function fetchSnapshot() {
  const response = await autoDLRead("/api/v1/dev/instance/pro/snapshot", {
    instance_uuid: INSTANCE_UUID,
  });
  if (
    response.status < 200 ||
    response.status >= 300 ||
    response.data?.code !== "Success"
  ) {
    const error = new Error(response.data?.msg || response.data?.message || "无法获取实例详情");
    error.status = response.status;
    throw error;
  }
  return sanitizeSnapshot(response.data);
}

function isAllowedProbeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (!AUTODL_SERVICE_HOST_SUFFIX) return false;
    if (AUTODL_SERVICE_HOST_SUFFIX.startsWith(".")) {
      const bare = AUTODL_SERVICE_HOST_SUFFIX.slice(1);
      return host === bare || host.endsWith(AUTODL_SERVICE_HOST_SUFFIX);
    }
    return host === AUTODL_SERVICE_HOST_SUFFIX;
  } catch {
    return false;
  }
}

async function probeService(url) {
  if (!url) return { ready: false, phase: "waiting", httpStatus: null };
  if (!isAllowedProbeUrl(url)) {
    return { ready: false, phase: "blocked", httpStatus: null };
  }
  try {
    const response = await axios.get(url, {
      timeout: PROBE_TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: 512 * 1024,
      validateStatus: () => true,
      headers: { "User-Agent": "autodl-console-readiness/2.0" },
    });
    const ready =
      (response.status >= 200 && response.status < 400) ||
      response.status === 401 ||
      response.status === 403;
    return { ready, phase: ready ? "ready" : "starting", httpStatus: response.status };
  } catch (error) {
    return {
      ready: false,
      phase: "starting",
      httpStatus: error.response?.status || null,
    };
  }
}

function freshLocalServiceTelemetry() {
  if (!guardState.localServices || !guardState.lastSeenAtMs) return null;
  if (Date.now() - guardState.lastSeenAtMs > BOOT_GUARD_HEARTBEAT_TIMEOUT_MS) return null;
  return guardState.localServices;
}

function localServiceResult(local, port) {
  const item = local?.[port];
  if (!item || typeof item.listening !== "boolean") return null;
  return {
    ready: item.listening,
    phase: item.listening ? "ready" : "starting",
    httpStatus: null,
    source: "autodl-local",
    latencyMs: Number.isFinite(item.latencyMs) ? item.latencyMs : null,
  };
}

async function buildReadiness(status) {
  if (status !== "running") {
    return {
      instanceStatus: status,
      ready: false,
      comfyuiPort: COMFYUI_SERVICE_PORT,
      services: {
        jupyter: { ready: false, phase: "waiting", httpStatus: null },
        service6006: { ready: false, phase: "waiting", httpStatus: null },
        service6008: { ready: false, phase: "waiting", httpStatus: null },
      },
    };
  }

  const snapshot = await fetchSnapshot();
  const local = freshLocalServiceTelemetry();
  const [jupyter, ext6006, ext6008] = await Promise.all([
    probeService(snapshot.links.jupyter),
    local ? Promise.resolve(null) : probeService(snapshot.links.service6006),
    local ? Promise.resolve(null) : probeService(snapshot.links.service6008),
  ]);

  const service6006 = localServiceResult(local, "6006") || ext6006 ||
    { ready: false, phase: "waiting", httpStatus: null };
  const service6008 = localServiceResult(local, "6008") || ext6008 ||
    { ready: false, phase: "waiting", httpStatus: null };
  const services = { jupyter, service6006, service6008 };

  const preferred = COMFYUI_SERVICE_PORT === "6008" ? "service6008" : "service6006";
  const fallback = preferred === "service6006" ? "service6008" : "service6006";
  const comfyuiKey = services[preferred].ready ? preferred :
    (services[fallback].ready ? fallback : preferred);
  const comfyuiPort = comfyuiKey === "service6006" ? "6006" : "6008";

  return {
    instanceStatus: status,
    ready: services[comfyuiKey].ready,
    comfyuiPort,
    readinessSource: local ? "autodl-local-websocket" : "railway-public-probe",
    services,
    snapshot,
  };
}

async function fetchInstanceRecord() {
  const response = await autoDLRequest("POST", "/api/v1/dev/instance/pro/list", {
    page_index: 1,
    page_size: 100,
  });
  if (
    response.status < 200 ||
    response.status >= 300 ||
    response.data?.code !== "Success"
  ) {
    throw new Error(
      response.data?.msg || response.data?.message || `AutoDL list HTTP ${response.status}`
    );
  }
  const list = Array.isArray(response.data?.data?.list) ? response.data.data.list : [];
  return list.find((item) => item?.uuid === INSTANCE_UUID) || null;
}

function parseStartedAt(record) {
  const started = record?.started_at;
  const value =
    started && typeof started === "object"
      ? started.Valid === false
        ? null
        : started.Time
      : started;
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeInstanceStatus(record) {
  return String(record?.status || "unknown").toLowerCase();
}

function bootGuardOrigin() {
  return new URL(BOOT_GUARD_PUBLIC_ORIGIN);
}

function bootGuardWsUrl() {
  const origin = bootGuardOrigin();
  origin.protocol = "wss:";
  origin.pathname = "/ws/boot-guard";
  origin.search = "";
  origin.hash = "";
  return origin.toString();
}

function bootGuardClientUrl() {
  const origin = bootGuardOrigin();
  origin.pathname = "/boot-guard-client.py";
  origin.search = "";
  origin.hash = "";
  return origin.toString();
}

function signGuardToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", BOOT_GUARD_SECRET)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function createBootToken() {
  const payload = {
    v: 1,
    kind: "boot",
    instance: INSTANCE_UUID,
    aud: BOOT_GUARD_PUBLIC_ORIGIN.replace(/\/$/, ""),
    iat: Date.now(),
    nonce: crypto.randomBytes(18).toString("base64url"),
  };
  return { token: signGuardToken(payload), payload };
}

function createSessionToken(bootStartedAtMs, nonce) {
  return signGuardToken({
    v: 1,
    kind: "session",
    instance: INSTANCE_UUID,
    aud: BOOT_GUARD_PUBLIC_ORIGIN.replace(/\/$/, ""),
    bootStartedAt: bootStartedAtMs,
    issuedAt: Date.now(),
    nonce,
  });
}

function verifyBootToken(token) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, suppliedSignatureText] = parts;
  let suppliedSignature;
  try {
    suppliedSignature = Buffer.from(suppliedSignatureText, "base64url");
  } catch {
    return null;
  }
  const expectedSignature = crypto
    .createHmac("sha256", BOOT_GUARD_SECRET)
    .update(encoded)
    .digest();
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (
    payload?.v !== 1 ||
    payload?.instance !== INSTANCE_UUID ||
    payload?.aud !== BOOT_GUARD_PUBLIC_ORIGIN.replace(/\/$/, "") ||
    !["boot", "session"].includes(payload?.kind) ||
    typeof payload?.nonce !== "string"
  ) {
    return null;
  }

  if (payload.kind === "boot") {
    if (!Number.isFinite(payload.iat)) return null;
    if (payload.iat > Date.now() + 60_000) return null;
  } else if (!Number.isFinite(payload.bootStartedAt)) {
    return null;
  }

  return payload;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function buildGuardedStartCommand(bootToken) {
  if (!BOOT_GUARD_ENABLED) return AUTODL_START_COMMAND;

  const clientUrl = bootGuardClientUrl();
  const wsUrl = bootGuardWsUrl();
  const downloadCode =
    `import urllib.request; ` +
    `urllib.request.urlretrieve(${JSON.stringify(clientUrl)}, "/tmp/autodl-boot-guard.py")`;

  const bootstrap =
    `(python3 -c ${shellQuote(downloadCode)} && ` +
    `nohup python3 /tmp/autodl-boot-guard.py ` +
    `--url ${shellQuote(wsUrl)} ` +
    `--token ${shellQuote(bootToken)} ` +
    `--instance ${shellQuote(INSTANCE_UUID)} ` +
    `>/tmp/autodl-boot-guard.log 2>&1 </dev/null &)`;

  return `${bootstrap} && ${AUTODL_START_COMMAND}`;
}

function guardAuthorizedFor(startedAtMs) {
  if (!guardState.bootStartedAtMs || !guardState.lastSeenAtMs) return false;
  if (Math.abs(guardState.bootStartedAtMs - startedAtMs) > 2000) return false;
  return Date.now() - guardState.lastSeenAtMs <= BOOT_GUARD_HEARTBEAT_TIMEOUT_MS;
}

function clearPendingBoot() {
  guardState.pendingNonce = null;
  guardState.pendingIssuedAtMs = null;
}

function clearGuardState(socket = null) {
  if (socket && guardState.socket !== socket) return;
  guardState.socket = null;
  guardState.bootStartedAtMs = null;
  guardState.tokenIssuedAtMs = null;
  guardState.nonce = null;
  guardState.connectedAtMs = null;
  guardState.lastSeenAtMs = null;
  guardState.localServices = null;
}

function normalizeLocalServices(value) {
  if (!value || typeof value !== "object") return null;
  const output = {};
  for (const port of ["6006", "6008"]) {
    const item = value[port];
    if (!item || typeof item !== "object" || typeof item.listening !== "boolean") continue;
    output[port] = {
      listening: item.listening,
      latencyMs: Number.isFinite(item.latencyMs) ? Math.max(0, Math.min(5000, item.latencyMs)) : null,
    };
  }
  return Object.keys(output).length ? output : null;
}

async function forcePowerOff(reason, bootStartedAtMs) {
  if (guardPowerOffInFlight) return;
  if (
    guardLastForcedBootStartedAtMs &&
    Math.abs(guardLastForcedBootStartedAtMs - bootStartedAtMs) <= 2000
  ) {
    return;
  }

  guardPowerOffInFlight = true;
  try {
    const response = await autoDLRequest("POST", "/api/v1/dev/instance/pro/power_off", {
      instance_uuid: INSTANCE_UUID,
    });
    if (
      response.status >= 200 &&
      response.status < 300 &&
      response.data?.code === "Success"
    ) {
      guardLastForcedBootStartedAtMs = bootStartedAtMs;
      audit("boot_guard_forced_power_off", null, {
        reason,
        instance: INSTANCE_UUID,
        bootStartedAt: new Date(bootStartedAtMs).toISOString(),
        autodlRequestId: response.data?.request_id || null,
      });
    } else {
      console.warn("Boot guard failed to power off instance", {
        reason,
        httpStatus: response.status,
        code: response.data?.code,
        message: response.data?.msg || response.data?.message,
      });
    }
  } catch (error) {
    console.warn("Boot guard power-off request failed", { reason, message: error.message });
  } finally {
    guardPowerOffInFlight = false;
  }
}

async function bootGuardPoll() {
  if (!BOOT_GUARD_ENABLED || !AUTODL_TOKEN || !INSTANCE_UUID || guardPollInFlight) return;
  guardPollInFlight = true;
  try {
    const record = await fetchInstanceRecord();
    if (!record) {
      console.warn("Boot guard could not find configured instance", { instance: INSTANCE_UUID });
      return;
    }

    const status = normalizeInstanceStatus(record);
    if (
      guardState.pendingIssuedAtMs &&
      Date.now() - guardState.pendingIssuedAtMs > BOOT_GUARD_PENDING_TTL_MS
    ) {
      clearPendingBoot();
    }
    if (status !== "running") {
      if (["stopped", "stopping", "released"].includes(status)) {
        clearGuardState();
        guardLastForcedBootStartedAtMs = null;
      }
      return;
    }

    const startedAtMs = parseStartedAt(record);
    if (!startedAtMs) {
      console.warn("Boot guard saw running instance without started_at");
      return;
    }

    if (guardAuthorizedFor(startedAtMs)) return;

    const now = Date.now();
    const railwayAge = now - serverStartedAt;
    const bootAge = now - startedAtMs;

    if (railwayAge < BOOT_GUARD_RECONNECT_GRACE_MS) return;
    if (bootAge >= 0 && bootAge < BOOT_GUARD_GRACE_MS) return;

    const reason =
      guardState.bootStartedAtMs &&
      Math.abs(guardState.bootStartedAtMs - startedAtMs) <= 2000
        ? "websocket_heartbeat_timeout"
        : "missing_valid_railway_boot_attestation";

    await forcePowerOff(reason, startedAtMs);
  } catch (error) {
    console.warn("Boot guard poll failed", { message: error.message });
  } finally {
    guardPollInFlight = false;
  }
}

function wsAcceptValue(secWebSocketKey) {
  return crypto
    .createHash("sha1")
    .update(`${secWebSocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function wsFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    throw new Error("WebSocket payload too large");
  }
  return Buffer.concat([header, body]);
}

function wsSendJson(socket, value) {
  if (!socket.destroyed) {
    socket.write(wsFrame(0x1, JSON.stringify(value)));
  }
}

function wsClose(socket, code = 1000, reason = "") {
  if (socket.destroyed) return;
  const reasonBuffer = Buffer.from(String(reason).slice(0, 100), "utf8");
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  try {
    socket.write(wsFrame(0x8, payload));
  } finally {
    socket.end();
  }
}

function attachWsParser(socket, onText) {
  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (!fin || !masked) {
        wsClose(socket, 1002, "protocol error");
        return;
      }

      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        wsClose(socket, 1009, "frame too large");
        return;
      }

      if (length > 8192) {
        wsClose(socket, 1009, "frame too large");
        return;
      }
      if (buffer.length < offset + 4 + length) return;

      const mask = buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + length);

      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        socket.write(wsFrame(0xA, payload));
        continue;
      }
      if (opcode !== 0x1) {
        wsClose(socket, 1003, "text only");
        return;
      }

      Promise.resolve(onText(payload.toString("utf8"))).catch((error) => {
        console.warn("Boot guard WebSocket message failed", { message: error.message });
        wsClose(socket, 1011, "server error");
      });
    }
  });
}

async function attestGuardSocket(req, socket, message) {
  let data;
  try {
    data = JSON.parse(message);
  } catch {
    wsClose(socket, 1008, "invalid json");
    return false;
  }

  if (
    data?.type !== "boot-attest" ||
    data?.instance !== INSTANCE_UUID ||
    typeof data?.token !== "string"
  ) {
    wsClose(socket, 1008, "invalid attestation");
    return false;
  }

  const payload = verifyBootToken(data.token);
  if (!payload) {
    audit("boot_guard_attestation_rejected", req, { reason: "invalid_signature_or_payload" });
    wsClose(socket, 1008, "invalid token");
    return false;
  }

  let record;
  try {
    record = await fetchInstanceRecord();
  } catch (error) {
    wsSendJson(socket, { type: "boot-attest-ack", ok: false, retry: true });
    wsClose(socket, 1013, "autodl unavailable");
    return false;
  }

  if (!record || normalizeInstanceStatus(record) !== "running") {
    wsClose(socket, 1008, "instance not running");
    return false;
  }

  const startedAtMs = parseStartedAt(record);
  if (!startedAtMs) {
    wsClose(socket, 1008, "missing started_at");
    return false;
  }

  if (payload.kind === "boot") {
    const tokenAgeMs = Date.now() - payload.iat;
    const deltaMs = startedAtMs - payload.iat;
    const pendingAgeMs = guardState.pendingIssuedAtMs
      ? Date.now() - guardState.pendingIssuedAtMs
      : Number.POSITIVE_INFINITY;
    const pendingMatches =
      guardState.pendingNonce && safeEqual(guardState.pendingNonce, payload.nonce);

    if (
      !pendingMatches ||
      pendingAgeMs < -60_000 ||
      pendingAgeMs > BOOT_GUARD_PENDING_TTL_MS ||
      tokenAgeMs < -60_000 ||
      tokenAgeMs > BOOT_GUARD_PENDING_TTL_MS ||
      deltaMs < -60_000 ||
      deltaMs > BOOT_GUARD_PENDING_TTL_MS
    ) {
      audit("boot_guard_attestation_rejected", req, {
        reason: pendingMatches ? "initial_token_expired" : "no_matching_pending_railway_boot",
        tokenIssuedAt: new Date(payload.iat).toISOString(),
        bootStartedAt: new Date(startedAtMs).toISOString(),
        deltaMs,
        tokenAgeMs,
        pendingAgeMs: Number.isFinite(pendingAgeMs) ? pendingAgeMs : null,
      });
      wsClose(socket, 1008, "no matching Railway boot");
      return false;
    }
  } else if (Math.abs(payload.bootStartedAt - startedAtMs) > 2000) {
    audit("boot_guard_attestation_rejected", req, {
      reason: "session_token_not_for_current_boot",
      tokenBootStartedAt: new Date(payload.bootStartedAt).toISOString(),
      bootStartedAt: new Date(startedAtMs).toISOString(),
    });
    wsClose(socket, 1008, "session token not for current boot");
    return false;
  }

  if (guardState.socket && guardState.socket !== socket && !guardState.socket.destroyed) {
    wsClose(guardState.socket, 1000, "replaced");
  }

  guardState.socket = socket;
  guardState.bootStartedAtMs = startedAtMs;
  guardState.tokenIssuedAtMs = payload.iat || payload.issuedAt || Date.now();
  guardState.nonce = payload.nonce;
  guardState.connectedAtMs = Date.now();
  guardState.lastSeenAtMs = Date.now();
  guardState.localServices = null;
  if (payload.kind === "boot") clearPendingBoot();
  guardLastForcedBootStartedAtMs = null;

  socket.setTimeout(BOOT_GUARD_HEARTBEAT_TIMEOUT_MS + 30_000);
  socket.on("timeout", () => socket.destroy());

  audit("boot_guard_attestation_accepted", req, {
    instance: INSTANCE_UUID,
    tokenKind: payload.kind,
    bootStartedAt: new Date(startedAtMs).toISOString(),
    nonce: payload.nonce,
  });

  wsSendJson(socket, {
    type: "boot-attest-ack",
    ok: true,
    sessionToken: createSessionToken(startedAtMs, payload.nonce),
    heartbeatMs: Math.min(20_000, Math.floor(BOOT_GUARD_HEARTBEAT_TIMEOUT_MS / 3)),
  });
  return true;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    configured: Boolean(AUTODL_TOKEN && INSTANCE_UUID),
    bootGuardEnabled: BOOT_GUARD_ENABLED,
  });
});

app.get("/api/config", requireDashboardKey, (req, res) => {
  res.json({
    configured: Boolean(AUTODL_TOKEN && INSTANCE_UUID),
    instanceUuid: INSTANCE_UUID || null,
    protected: true,
    bootGuard: {
      enabled: BOOT_GUARD_ENABLED,
      connected: Boolean(guardState.socket && !guardState.socket.destroyed),
      lastSeenAt: guardState.lastSeenAtMs
        ? new Date(guardState.lastSeenAtMs).toISOString()
        : null,
      bootStartedAt: guardState.bootStartedAtMs
        ? new Date(guardState.bootStartedAtMs).toISOString()
        : null,
    },
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
    res.json({ code: "Success", data: await fetchSnapshot() });
  } catch (error) {
    res
      .status(error.status && error.status >= 400 ? error.status : 502)
      .json({ code: "AutoDLUnavailable", message: error.message });
  }
});

app.get("/api/readiness", requireDashboardKey, requireAutoDLConfig, async (req, res) => {
  try {
    const statusResponse = await autoDLRead("/api/v1/dev/instance/pro/status", {
      instance_uuid: INSTANCE_UUID,
    });
    if (
      statusResponse.status < 200 ||
      statusResponse.status >= 300 ||
      statusResponse.data?.code !== "Success"
    ) {
      return sendAutoDLResponse(res, statusResponse);
    }
    const status =
      typeof statusResponse.data.data === "string"
        ? statusResponse.data.data.toLowerCase()
        : "unknown";
    res.json({ code: "Success", data: await buildReadiness(status) });
  } catch (error) {
    res
      .status(error.status && error.status >= 400 ? error.status : 502)
      .json({ code: "ReadinessUnavailable", message: error.message });
  }
});

app.post(
  "/api/power-on",
  requireDashboardKey,
  powerRateLimit,
  requireAutoDLConfig,
  async (req, res) => {
    try {
      const boot = BOOT_GUARD_ENABLED ? createBootToken() : null;
      const startCommand = buildGuardedStartCommand(boot?.token);
      if (boot) {
        guardState.pendingNonce = boot.payload.nonce;
        guardState.pendingIssuedAtMs = Date.now();
      }

      audit("power_on_requested", req, {
        instance: INSTANCE_UUID,
        bootGuardEnabled: BOOT_GUARD_ENABLED,
        bootNonce: boot?.payload?.nonce || null,
      });

      const response = await autoDLRequest("POST", "/api/v1/dev/instance/pro/power_on", {
        instance_uuid: INSTANCE_UUID,
        payload: "gpu",
        start_command: startCommand,
      });

      audit("power_on_result", req, {
        instance: INSTANCE_UUID,
        httpStatus: response.status,
        code: response.data?.code || null,
        autodlRequestId: response.data?.request_id || null,
      });

      if (
        response.status < 200 ||
        response.status >= 300 ||
        response.data?.code !== "Success"
      ) {
        clearPendingBoot();
      }

      sendAutoDLResponse(res, response);
    } catch (error) {
      clearPendingBoot();
      audit("power_on_error", req, { message: error.message });
      res.status(502).json({ code: "AutoDLUnavailable", message: error.message });
    }
  }
);

app.post(
  "/api/power-off",
  requireDashboardKey,
  powerRateLimit,
  requireAutoDLConfig,
  async (req, res) => {
    try {
      clearPendingBoot();
      audit("power_off_requested", req, { instance: INSTANCE_UUID });
      const response = await autoDLRequest("POST", "/api/v1/dev/instance/pro/power_off", {
        instance_uuid: INSTANCE_UUID,
      });
      audit("power_off_result", req, {
        instance: INSTANCE_UUID,
        httpStatus: response.status,
        code: response.data?.code || null,
        autodlRequestId: response.data?.request_id || null,
      });
      sendAutoDLResponse(res, response);
    } catch (error) {
      audit("power_off_error", req, { message: error.message });
      res.status(502).json({ code: "AutoDLUnavailable", message: error.message });
    }
  }
);

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);

server.on("upgrade", (req, socket) => {
  if (!BOOT_GUARD_ENABLED) {
    socket.destroy();
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(req.url, "https://boot-guard.invalid");
  } catch {
    socket.destroy();
    return;
  }

  if (requestUrl.pathname !== "/ws/boot-guard") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade || "").toLowerCase();
  const version = String(req.headers["sec-websocket-version"] || "");
  if (!key || upgrade !== "websocket" || version !== "13") {
    socket.destroy();
    return;
  }

  const forwardedFor = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const requestLike = {
    requestId: crypto.randomUUID(),
    ip: forwardedFor || req.socket.remoteAddress,
    socket: req.socket,
    method: "WS",
    originalUrl: requestUrl.pathname,
    get(name) {
      return req.headers[String(name).toLowerCase()] || "";
    },
  };

  const accept = wsAcceptValue(String(key));
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      "\r\n"
  );

  let attested = false;
  socket.setTimeout(15_000);
  socket.on("timeout", () => socket.destroy());

  socket.on("close", () => {
    if (guardState.socket === socket) {
      guardState.socket = null;
    }
  });

  attachWsParser(socket, async (text) => {
    if (!attested) {
      attested = await attestGuardSocket(requestLike, socket, text);
      return;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      wsClose(socket, 1008, "invalid json");
      return;
    }

    if (message?.type !== "heartbeat") {
      wsClose(socket, 1008, "heartbeat required");
      return;
    }
    guardState.lastSeenAtMs = Date.now();
    guardState.localServices = normalizeLocalServices(message.services);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AutoDL console listening on ${PORT} (${APP_VERSION})`);
  if (BOOT_GUARD_ENABLED) {
    console.log(`Boot guard enabled for ${BOOT_GUARD_PUBLIC_ORIGIN}`);
  }
});

if (BOOT_GUARD_ENABLED) {
  setTimeout(() => {
    bootGuardPoll();
  }, 10_000).unref();

  setInterval(() => {
    bootGuardPoll();
  }, BOOT_GUARD_POLL_MS).unref();
}
