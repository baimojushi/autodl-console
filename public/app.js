const state = { key: sessionStorage.getItem("autodl_dashboard_key") || "", snapshot: null, status: null, busy: false };
const $ = (id) => document.getElementById(id);

function headers() {
  return state.key ? { "x-dashboard-key": state.key } : {};
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    state.key = "";
    sessionStorage.removeItem("autodl_dashboard_key");
    openKeyDialog();
  }
  if (!response.ok) throw new Error(data.message || data.msg || data.error || `请求失败（${response.status}）`);
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
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 3400);
}

function statusText(status) {
  return { running: "运行中", stopped: "已关机", stopping: "关机中", starting: "启动中", released: "已释放" }[status] || status || "未知";
}

function formatBytes(bytes) {
  if (bytes == null) return "—";
  const units = ["B", "GB", "TB"];
  let value = Number(bytes); let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

function setProgress(value, valueId, barId) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) { $(valueId).textContent = "—"; $(barId).style.width = "0"; return; }
  const bounded = Math.max(0, Math.min(100, numeric));
  $(valueId).textContent = `${bounded.toFixed(1)}%`;
  $(barId).style.width = `${bounded}%`;
}

function renderStatus(status) {
  state.status = status;
  const indicator = $("status-indicator");
  indicator.className = `status-indicator ${status === "running" ? "running" : status === "stopped" ? "stopped" : ""}`;
  $("status-label").textContent = statusText(status);
  $("hero-status").textContent = status === "running" ? "ONLINE" : statusText(status).toUpperCase();
  $("power-on").disabled = ["running", "starting"].includes(status) || state.busy;
  $("power-off").disabled = ["stopped", "stopping", "released"].includes(status) || state.busy;
}

function renderSnapshot(data) {
  state.snapshot = data;
  $("gpu-name").textContent = data.gpuName || "—";
  $("region").textContent = data.regionSign || "自动调度";
  $("price").textContent = data.gpuPrice == null ? "—" : `${data.gpuPrice} / 小时`;
  setProgress(data.usage.cpuPercent, "cpu-value", "cpu-bar");
  setProgress(data.usage.memoryPercent, "memory-value", "memory-bar");
  setProgress(data.usage.rootTotal ? (data.usage.rootUsed / data.usage.rootTotal) * 100 : null, "disk-value", "disk-bar");
  $("memory-foot").textContent = data.usage.memoryUsed == null ? "等待实例数据" : `${formatBytes(data.usage.memoryUsed)} / ${formatBytes(data.usage.memoryLimit)}`;
  $("instance-label").textContent = data.raw?.jupyterDomain ? `实例 ${window.__instanceUuid || ""}` : "实例地址将在开机后出现";
  $("open-jupyter").disabled = !data.links.jupyter;
  $("open-6006").disabled = !data.links.service6006;
  $("open-6008").disabled = !data.links.service6008;
  $("show-ssh").disabled = !data.sshCommand;
  $("ssh-command").textContent = data.sshCommand || "实例运行后会显示 SSH 命令";
}

async function refresh() {
  if (state.busy) return;
  try {
    const config = await api("/api/config");
    window.__instanceUuid = config.instanceUuid;
    if (!config.configured) throw new Error("Railway 尚未配置 AutoDL 环境变量");
    const statusResponse = await api("/api/status");
    renderStatus(statusResponse.data);
    if (statusResponse.data === "running") {
      const snapshotResponse = await api("/api/snapshot");
      renderSnapshot(snapshotResponse.data);
    }
    $("last-sync").textContent = `同步于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  } catch (error) {
    $("status-label").textContent = "连接异常";
    $("hero-status").textContent = "OFFLINE";
    showToast(error.message, true);
  }
}

async function power(path, message) {
  state.busy = true; renderStatus(state.status || "starting");
  try {
    await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ start_command: $("start-command").value }) });
    showToast(message);
    await refresh();
  } catch (error) { showToast(error.message, true); }
  finally { state.busy = false; await refresh(); }
}

function openService(type) {
  const url = state.snapshot?.links?.[type];
  if (!url) return showToast("实例尚未运行，暂时没有可用入口", true);
  const target = type === "jupyter" ? `${url.replace(/\/$/, "")}/lab?token=${encodeURIComponent(state.snapshot.links.jupyterToken || "")}` : url;
  window.open(target, "_blank", "noopener");
}

$("key-form").addEventListener("submit", (event) => { event.preventDefault(); state.key = $("dashboard-key").value.trim(); sessionStorage.setItem("autodl_dashboard_key", state.key); $("key-dialog").close(); refresh(); });
$("refresh-button").addEventListener("click", refresh);
$("power-on").addEventListener("click", () => power("/api/power-on", "启动请求已发送，正在等待实例上线…"));
$("power-off").addEventListener("click", () => { if (confirm("确认关机？关机后 AutoDL 才会停止按量计费。")) power("/api/power-off", "关机请求已发送"); });
$("open-jupyter").addEventListener("click", () => openService("jupyter"));
$("open-6006").addEventListener("click", () => openService("service6006"));
$("open-6008").addEventListener("click", () => openService("service6008"));
$("show-ssh").addEventListener("click", () => $("ssh-dialog").showModal());

refresh();
setInterval(refresh, 10000);
