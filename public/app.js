const state = {
  key: sessionStorage.getItem("autodl_dashboard_key") || "",
  snapshot: null,
  status: "unknown",
  readiness: null,
  busy: false,
  refreshing: false,
};

const COST_REFRESH_MS = 5 * 60 * 1000;
const STARTED_AT_KEY = "autodl_started_at";
const SESSION_COST_KEY = "autodl_session_cost";
const TOTAL_COST_KEY = "autodl_total_cost";

function getStartedAt() {
  return Number(localStorage.getItem(STARTED_AT_KEY) || 0);
}

function setStartedAt(timestamp) {
  if (timestamp) localStorage.setItem(STARTED_AT_KEY, String(timestamp));
  else localStorage.removeItem(STARTED_AT_KEY);
}

function getSessionCost() {
  return Number(localStorage.getItem(SESSION_COST_KEY) || 0);
}

function setSessionCost(value) {
  localStorage.setItem(SESSION_COST_KEY, String(value));
}

function getTotalCost() {
  return Number(localStorage.getItem(TOTAL_COST_KEY) || 0);
}

function setTotalCost(value) {
  localStorage.setItem(TOTAL_COST_KEY, String(value));
}

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function headers() {
  return state.key ? { "x-dashboard-key": state.key } : {};
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));

  if (response.status === 401) {
    state.key = "";
    sessionStorage.removeItem("autodl_dashboard_key");
    openKeyDialog();
  }

  if (!response.ok || (data.code && data.code !== "Success" && data.code !== "Unauthorized")) {
    const detail = data.detail?.msg || data.detail?.message;
    throw new Error(data.message || data.msg || detail || data.error || `请求失败（${response.status}）`);
  }
  return data;
}

function openKeyDialog() {
  const dialog = $("key-dialog");
  if (!dialog.open) dialog.showModal();
}

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 3600);
}

function normalizeStatus(value) {
  if (typeof value === "string") return value.toLowerCase();
  if (value && typeof value === "object") return String(value.status || value.state || "unknown").toLowerCase();
  return "unknown";
}

function statusText(status) {
  return {
    running: "运行中",
    stopped: "已关机",
    stopping: "关机中",
    starting: "启动中",
    pending: "调度中",
    released: "已释放",
  }[status] || status || "未知";
}

function formatBytes(bytes) {
  if (bytes == null) return "—";
  const units = ["B", "GB", "TB"];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function setProgress(value, valueId, barId) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    $(valueId).textContent = "—";
    $(barId).style.width = "0";
    return;
  }
  const bounded = Math.max(0, Math.min(100, numeric));
  $(valueId).textContent = `${bounded.toFixed(1)}%`;
  $(barId).style.width = `${bounded}%`;
}

function renderStatus(status) {
  state.status = status;
  const indicator = $("status-indicator");
  indicator.className = `status-indicator ${status === "running" ? "running" : status === "stopped" ? "stopped" : "loading"}`;
  $("status-label").textContent = statusText(status);
  $("hero-status").textContent = status === "running" ? "ONLINE" : statusText(status).toUpperCase();
  $("power-on").disabled = ["running", "starting", "pending"].includes(status) || state.busy;
  $("power-off").disabled = ["stopped", "stopping", "released", "unknown"].includes(status) || state.busy;
  if (status === "running" && !getStartedAt()) setStartedAt(Date.now());
  if (status !== "running" && getStartedAt()) {
    setTotalCost(getTotalCost() + getSessionCost());
    setSessionCost(0);
    setStartedAt(null);
  }
  updateCostTimer();
}

function updateCostTimer() {
  const startedAt = getStartedAt();
  const uptimeEl = $("uptime");
  const costEl = $("cost");
  const totalEl = $("total-cost");
  if (!startedAt) {
    uptimeEl.textContent = "—";
    costEl.textContent = "—";
    totalEl.textContent = getTotalCost() > 0 ? `¥${getTotalCost().toFixed(2)}` : "—";
    return;
  }
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const hours = elapsedMs / 3600000;
  const h = Math.floor(hours);
  const m = Math.floor((elapsedMs % 3600000) / 60000);
  const s = Math.floor((elapsedMs % 60000) / 1000);
  uptimeEl.textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  const price = Number(state.snapshot?.gpuPrice);
  if (Number.isFinite(price) && price > 0) {
    const sessionCost = (price / 100) * hours;
    setSessionCost(sessionCost);
    costEl.textContent = `¥${sessionCost.toFixed(2)}`;
    totalEl.textContent = `¥${(getTotalCost() + sessionCost).toFixed(2)}`;
  } else {
    costEl.textContent = "—";
    totalEl.textContent = getTotalCost() > 0 ? `¥${getTotalCost().toFixed(2)}` : "—";
  }
}

function renderSnapshot(data) {
  if (!data) return;
  state.snapshot = data;
  $("gpu-name").textContent = data.gpuName || "—";
  $("region").textContent = data.regionSign || "自动调度";
  $("price").textContent = data.gpuPrice == null ? "—" : `${(Number(data.gpuPrice) / 100).toFixed(2)} 元 / 小时`;
  setProgress(data.usage?.cpuPercent, "cpu-value", "cpu-bar");
  setProgress(data.usage?.memoryPercent, "memory-value", "memory-bar");
  setProgress(data.usage?.rootTotal ? (data.usage.rootUsed / data.usage.rootTotal) * 100 : null, "disk-value", "disk-bar");
  $("memory-foot").textContent = data.usage?.memoryUsed == null
    ? "等待实例数据"
    : `${formatBytes(data.usage.memoryUsed)} / ${formatBytes(data.usage.memoryLimit)}`;
  $("instance-label").textContent = data.raw?.jupyterDomain
    ? `实例 ${window.__instanceUuid || ""}`
    : "实例地址将在开机后出现";
  $("ssh-command").textContent = data.sshCommand || "实例运行后会显示 SSH 命令";
  $("show-ssh").disabled = !data.sshCommand;
}

function setStep(id, stateName) {
  const step = $(id);
  step.classList.remove("done", "active", "pending");
  step.classList.add(stateName);
  const dot = step.querySelector(".step-dot");
  if (stateName === "done") dot.textContent = "✓";
  else if (stateName === "active") dot.textContent = "•";
  else dot.textContent = id === "step-instance" ? "1" : id === "step-comfyui" ? "2" : "3";
}

function serviceStateText(service) {
  if (!service) return "等待";
  if (service.ready) return "可用";
  if (service.httpStatus) return `启动中 · ${service.httpStatus}`;
  return "等待";
}

function renderReadiness(readiness) {
  state.readiness = readiness;
  const services = readiness?.services || {};
  const comfyKey = readiness?.comfyuiPort === "6006" ? "service6006" : "service6008";
  const comfyReady = Boolean(services[comfyKey]?.ready);
  const anyServiceReady = Boolean(services.service6006?.ready || services.service6008?.ready);
  const instanceReady = readiness?.instanceStatus === "running";

  setStep("step-instance", instanceReady ? "done" : readiness?.instanceStatus === "stopped" ? "pending" : "active");
  setStep("step-comfyui", comfyReady ? "done" : instanceReady ? "active" : "pending");
  setStep("step-services", anyServiceReady ? "done" : comfyReady ? "active" : "pending");

  const completed = [instanceReady, comfyReady, anyServiceReady].filter(Boolean).length;
  $("boot-percent").textContent = `${Math.round((completed / 3) * 100)}%`;
  $("boot-progress-bar").style.width = `${(completed / 3) * 100}%`;

  let title = "启动准备";
  let detail = "启动实例后，这里会显示实时准备进度。";
  if (!instanceReady && readiness?.instanceStatus !== "stopped") {
    title = "正在等待 GPU 调度";
    detail = "AutoDL 正在开机，实例可用后会继续检查 ComfyUI。";
  } else if (instanceReady && !comfyReady) {
    title = "ComfyUI 启动中";
    detail = `实例已经开机，正在等待 ${comfyKey === "service6006" ? "6006" : "6008"} 端口响应。请不要提前打开服务入口。`;
  } else if (comfyReady && !anyServiceReady) {
    title = "服务正在启动";
    detail = "ComfyUI 已响应，其他服务仍在启动中。";
  } else if (readiness?.ready) {
    title = "全部服务已就绪";
    detail = "现在可以安全打开 ComfyUI 和其他端口服务。";
  }
  $("boot-title").textContent = title;
  $("boot-detail").textContent = detail;
  $("boot-card").classList.toggle("ready", Boolean(readiness?.ready));

  const entries = [
    ["jupyter", "service-state-jupyter", "open-jupyter"],
    ["service6006", "service-state-6006", "open-6006"],
    ["service6008", "service-state-6008", "open-6008"],
  ];
  for (const [key, stateId, buttonId] of entries) {
    const service = services[key];
    $(stateId).textContent = serviceStateText(service);
    $(stateId).className = `service-state ${service?.ready ? "ready" : "waiting"}`;
    $(buttonId).disabled = !service?.ready || !state.snapshot?.links?.[key === "jupyter" ? "jupyter" : key];
  }
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const config = await api("/api/config");
    window.__instanceUuid = config.instanceUuid;
    if (!config.configured) throw new Error("Railway 尚未配置 AutoDL 环境变量");
    const readinessResponse = await api("/api/readiness");
    const readiness = readinessResponse.data;
    renderStatus(normalizeStatus(readiness.instanceStatus));
    if (readiness.snapshot) renderSnapshot(readiness.snapshot);
    renderReadiness(readiness);
    $("last-sync").textContent = `同步于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  } catch (error) {
    $("status-label").textContent = "连接异常";
    $("hero-status").textContent = "OFFLINE";
    showToast(error.message, true);
  } finally {
    state.refreshing = false;
  }
}

async function waitUntilReady() {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await refresh();
    if (state.readiness?.ready) {
      showToast("ComfyUI 和端口服务已就绪，可以打开了");
      state.busy = false;
      renderStatus(state.status);
      return true;
    }
    await sleep(3000);
  }
  state.busy = false;
  renderStatus(state.status);
  showToast("实例已启动，但服务超过 10 分钟仍未就绪，请查看 Zealman 日志", true);
  return false;
}

async function power(path, message) {
  state.busy = true;
  renderStatus(state.status || "starting");
  try {
    await api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_command: $("start-command").value }),
    });
    showToast(message);
    if (path === "/api/power-on") {
      await waitUntilReady();
    } else {
      state.busy = false;
      await refresh();
    }
  } catch (error) {
    state.busy = false;
    showToast(error.message, true);
    await refresh();
  }
}

function openService(type) {
  const service = state.readiness?.services?.[type];
  const url = state.snapshot?.links?.[type];
  if (!service?.ready || !url) {
    showToast("服务还在启动，请等待状态变为“可用”后再打开", true);
    refresh();
    return;
  }
  const target = type === "jupyter"
    ? `${url.replace(/\/$/, "")}/lab?token=${encodeURIComponent(state.snapshot.links.jupyterToken || "")}`
    : url;
  window.open(target, "_blank", "noopener");
}

$("key-form").addEventListener("submit", (event) => {
  event.preventDefault();
  state.key = $("dashboard-key").value.trim();
  sessionStorage.setItem("autodl_dashboard_key", state.key);
  $("key-dialog").close();
  refresh();
});
$("refresh-button").addEventListener("click", refresh);
$("power-on").addEventListener("click", () => power("/api/power-on", "启动请求已发送，正在等待实例和服务就绪…"));
$("power-off").addEventListener("click", () => {
  if (confirm("确认关机？关机后 AutoDL 才会停止按量计费。")) power("/api/power-off", "关机请求已发送");
});
$("open-jupyter").addEventListener("click", () => openService("jupyter"));
$("open-6006").addEventListener("click", () => openService("service6006"));
$("open-6008").addEventListener("click", () => openService("service6008"));
$("show-ssh").addEventListener("click", () => $("ssh-dialog").showModal());

refresh();
setInterval(refresh, 5000);
setInterval(updateCostTimer, 1000);
setInterval(() => {
  refresh();
  updateCostTimer();
}, COST_REFRESH_MS);
