/* UXP panel. Browser rendering and PSD generation happen in the local helper. */
const HELPER_URL = "http://127.0.0.1:38417";
const TERMINAL = new Set(["completed", "done", "partial", "failed", "error", "cancelled", "canceled"]);

function errorText(error) { return error && error.message ? error.message : String(error); }
function relativeOutputPath(filePath, folderPath) {
  if (typeof filePath !== "string" || typeof folderPath !== "string" || /\0/.test(filePath)) throw new Error("结果中的 PSD 路径无效。");
  const clean = path => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = clean(filePath);
  const folder = clean(folderPath);
  const windows = /^[A-Za-z]:\//.test(folder) || folder.startsWith("//");
  const compare = value => windows ? value.toLowerCase() : value;
  if (!folder || !compare(file).startsWith(compare(folder + "/"))) throw new Error("PSD 不在选中的保存文件夹内，请重新选择保存位置。");
  const relative = file.slice(folder.length + 1);
  if (!relative || relative.split("/").some(part => !part || part === "." || part === ".." || part.includes(":")) || !/\.psd$/i.test(relative)) throw new Error("结果中的 PSD 路径无效。");
  return relative;
}

class HelperClient {
  constructor(fetchImpl, baseUrl = HELPER_URL) { this.fetch = fetchImpl; this.baseUrl = baseUrl; this.token = null; }
  async request(path, method = "GET", body) {
    if (path !== "/health" && !this.token) await this.health();
    const headers = { "Content-Type": "application/json" };
    if (path !== "/health") headers["X-HTML-Import-Token"] = this.token;
    let response;
    try { response = await this.fetch(this.baseUrl + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch (_) { throw new Error("无法连接渲染服务。请先运行“启动渲染服务.cmd”，然后点击“重新连接”。"); }
    let data;
    try { data = await response.json(); } catch (_) { throw new Error("渲染服务返回了无效结果，请重新启动渲染服务。"); }
    if (!response.ok) throw new Error(data.error && (data.error.message || data.error) || data.message || "渲染服务请求失败。");
    return data;
  }
  async health() {
    const data = await this.request("/health");
    if (!data.ready || typeof data.sessionToken !== "string" || !data.sessionToken) throw new Error("渲染服务尚未准备好，请查看服务窗口后重新连接。");
    this.token = data.sessionToken;
    this.version = data.version;
    return data;
  }
}

class ImportController {
  constructor({ client, fs, photoshop, onChange = () => {}, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    this.client = client; this.fs = fs; this.photoshop = photoshop; this.onChange = onChange; this.delay = delay;
    this.rootFolder = null; this.outputFolder = null; this.jobId = null; this.busy = false;
    this.state = { ready: false, service: "正在连接渲染服务…", rootPath: "", outputPath: "", pages: [], results: [], progress: 0, total: 0, status: "选择源文件夹和保存位置后开始。", busy: false, error: false };
  }
  update(patch = {}) { Object.assign(this.state, patch, { busy: this.busy }); this.onChange(this.state); }
  async connect() {
    try { const health = await this.client.health(); this.update({ ready: true, service: "渲染服务已连接 · " + health.version, error: false }); return true; }
    catch (error) { this.update({ ready: false, service: "渲染服务未连接", status: errorText(error), error: true }); return false; }
  }
  async chooseSource() {
    if (this.busy) return;
    const folder = await this.fs.getFolder();
    if (!folder) return;
    this.rootFolder = folder;
    this.update({ rootPath: folder.nativePath, pages: [], results: [], progress: 0, status: "正在扫描 HTML 文件…", error: false });
    await this.scan();
  }
  async chooseOutput() {
    if (this.busy) return;
    const folder = await this.fs.getFolder();
    if (!folder) return;
    this.outputFolder = folder;
    this.update({ outputPath: folder.nativePath, error: false });
  }
  async scan() {
    if (this.busy || !this.rootFolder) return;
    this.busy = true; this.update({ status: "正在扫描 HTML 文件…", error: false });
    try {
      const data = await this.client.request("/scan", "POST", { rootPath: this.rootFolder.nativePath });
      if (!Array.isArray(data.pages)) throw new Error("扫描结果无效，请重新启动渲染服务。");
      const previous = new Map(this.state.pages.map(page => [page.path, page.selected]));
      const pages = data.pages.filter(page => page && typeof page.path === "string").map(page => ({ ...page, selected: previous.has(page.path) ? previous.get(page.path) : true }));
      const warnings = Array.isArray(data.warnings) && data.warnings.length ? " 扫描提示：" + data.warnings.map(warningText).join("；") : "";
      this.update({ ready: true, service: "渲染服务已连接 · " + (this.client.version || "0.1.0"), pages, status: (pages.length ? "找到 " + pages.length + " 个 HTML，可手动勾选首页和二级页面。" : "文件夹中没有找到 HTML 文件。") + warnings, error: false });
    } catch (error) { this.update({ status: errorText(error), error: true }); }
    finally { this.busy = false; this.update(); }
  }
  selectPage(path, selected) { if (this.busy) return; const page = this.state.pages.find(page => page.path === path); if (page) page.selected = !!selected; this.update(); }
  selectAll(selected) { if (this.busy) return; this.state.pages.forEach(page => { page.selected = !!selected; }); this.update(); }
  collectFonts() {
    try {
      const fonts = this.photoshop.app.fonts;
      if (!fonts || typeof fonts.length !== "number") return undefined;
      const catalog = [];
      for (let i = 0; i < fonts.length; i++) { const font = fonts[i]; if (font && font.postScriptName) catalog.push({ family: font.family, style: font.style, name: font.name, postScriptName: font.postScriptName }); }
      return catalog.length ? catalog : undefined;
    } catch (_) { return undefined; }
  }
  async start({ width = 1440, height = 900, autoOpen = true, runScripts = false } = {}) {
    if (this.busy) return;
    if (!this.rootFolder || !this.outputFolder) throw new Error("请先选择源文件夹和 PSD 保存文件夹。");
    const pages = this.state.pages.filter(page => page.selected);
    if (!pages.length) throw new Error("请至少勾选一个 HTML 页面。");
    if (!Number.isInteger(width) || width < 320 || width > 30000 || !Number.isInteger(height) || height < 200 || height > 30000) throw new Error("默认视口宽度为 320–30000，高度为 200–30000，请输入整数。");
    this.busy = true; this.jobId = null; this.update({ results: [], progress: 0, total: pages.length, status: "正在创建导入任务…", error: false });
    try {
      const fonts = this.collectFonts();
      const job = await this.client.request("/jobs", "POST", { rootPath: this.rootFolder.nativePath, pagePaths: pages.map(page => page.path), defaults: { width, height }, runScripts: runScripts === true, outputDir: this.outputFolder.nativePath, ...(fonts ? { fonts } : {}) });
      if (!job.jobId || typeof job.jobId !== "string") throw new Error("导入任务创建失败，请重试。");
      this.jobId = job.jobId;
      let finished;
      do {
        finished = await this.client.request("/jobs/" + encodeURIComponent(this.jobId));
        const phaseNames = { queued: "等待渲染", rendering: "正在渲染", measuring: "正在测量页面", extracting: "正在提取图层", writing: "正在生成 PSD", generating: "正在生成 PSD" };
        const progress = Number(finished.progress) || 0;
        const total = Number(finished.total) || pages.length;
        const currentPage = finished.currentPage ? " · " + finished.currentPage : "";
        this.update({ progress, total, results: Array.isArray(finished.results) ? finished.results : [], status: (phaseNames[finished.phase] || finished.phase || "正在导入") + " " + progress + "/" + total + currentPage });
        if (!TERMINAL.has(finished.state)) await this.delay(700);
      } while (!TERMINAL.has(finished.state));
      if (finished.state === "failed" || finished.state === "error") throw new Error(errorText(finished.error || "导入失败，请检查结果提示后重试。"));
      if (finished.state === "cancelled" || finished.state === "canceled") { this.update({ status: "任务已取消。已完成的 PSD 保留在保存文件夹中。" }); return; }
      const successful = this.state.results.filter(result => result.path && !result.error);
      const failureCount = this.state.results.length - successful.length;
      this.update({ progress: totalCount(finished, pages.length), status: "导入完成：" + successful.length + " 个 PSD" + (failureCount ? "，" + failureCount + " 个页面失败。" : "。"), error: failureCount > 0 });
      if (autoOpen && successful.length) await this.openResults(successful);
    } catch (error) { this.update({ status: errorText(error), error: true }); }
    finally { this.busy = false; this.jobId = null; this.update(); }
  }
  async cancel() {
    if (!this.jobId) return;
    await this.client.request("/jobs/" + encodeURIComponent(this.jobId) + "/cancel", "POST", {});
    this.update({ status: "正在取消，请等待当前页面停止…" });
  }
  async openResults(results) {
    if (!this.outputFolder) throw new Error("请重新选择 PSD 保存文件夹。");
    const entries = [];
    const errors = [];
    for (const result of results) {
      try {
        const relative = relativeOutputPath(result.path, this.outputFolder.nativePath);
        let entry = this.outputFolder;
        for (const part of relative.split("/")) entry = await entry.getEntry(part);
        if (!entry || entry.isFolder) throw new Error("未找到 PSD 文件。");
        entries.push({ entry, result });
      } catch (error) { errors.push((result.page || result.name || "PSD") + ": " + errorText(error)); }
    }
    let opened = 0;
    if (entries.length) {
      await this.photoshop.core.executeAsModal(async executionContext => {
        for (const item of entries) {
          if (executionContext && executionContext.isCancelled) { errors.push("打开 PSD 已取消。"); break; }
          try { await this.photoshop.app.open(item.entry); opened++; }
          catch (error) { errors.push((item.result.page || item.result.name || "PSD") + ": " + errorText(error)); }
        }
      }, { commandName: "打开 HTML 导入生成的 PSD" });
    }
    const failedPages = this.state.results.filter(result => result.error).length;
    const failureNote = failedPages ? " " + failedPages + " 个页面导入失败，请查看结果提示。" : "";
    this.update({ status: (errors.length ? "已打开 " + opened + " 个 PSD。" + errors.join("；") : "已在 Photoshop 中打开 " + opened + " 个 PSD。") + failureNote, error: errors.length > 0 || failedPages > 0 });
    return { opened, errors };
  }
}
function totalCount(job, fallback) { return Number(job.total) || fallback; }
function warningText(warning) { return typeof warning === "string" ? warning : warning && (warning.message || warning.detail || warning.code) || "页面存在兼容性提示。"; }

function mountPanel(document, controller) {
  const get = id => document.getElementById(id);
  const clear = node => { while (node.firstChild) node.removeChild(node.firstChild); };
  const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
  let pageSignature = "";
  let resultSignature = "";
  controller.onChange = state => {
    get("service-status").textContent = state.service;
    get("service-status").className = state.ready ? "success" : "";
    get("service-help").style.display = state.ready ? "none" : "block";
    get("source-path").textContent = state.rootPath || "尚未选择";
    get("output-path").textContent = state.outputPath || "尚未选择";
    get("page-count").textContent = state.pages.filter(page => page.selected).length + " / " + state.pages.length + " 个 HTML";
    get("status").textContent = state.status;
    get("status").className = "status" + (state.error ? " error" : "");
    get("progress-fill").style.width = (state.total ? Math.min(100, Math.max(0, state.progress / state.total * 100)) : 0) + "%";
    ["source-button", "output-button", "connect-button", "scan-button", "select-all", "select-none", "default-width", "default-height", "auto-open", "run-scripts"].forEach(id => { get(id).disabled = state.busy; });
    get("scan-button").disabled = state.busy || !state.rootPath;
    get("import-button").disabled = state.busy || !state.rootPath || !state.outputPath || !state.pages.some(page => page.selected);
    get("cancel-button").disabled = !state.busy || !controller.jobId;
    const nextPageSignature = JSON.stringify([state.pages, state.busy]);
    if (nextPageSignature !== pageSignature) {
      pageSignature = nextPageSignature; clear(get("page-list"));
      if (!state.pages.length) get("page-list").appendChild(text("p", "选择包含 HTML 的文件夹后显示页面清单", "empty"));
      state.pages.forEach(page => {
        const row = document.createElement("label"); row.className = "page-row";
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = page.selected; checkbox.disabled = state.busy;
        checkbox.addEventListener("change", () => controller.selectPage(page.path, checkbox.checked));
        const label = document.createElement("span"); label.className = "page-text";
        label.appendChild(text("span", page.name || page.path, "page-name")); label.appendChild(text("span", page.path, "page-path"));
        row.appendChild(checkbox); row.appendChild(label); get("page-list").appendChild(row);
      });
    }
    const nextResultSignature = JSON.stringify([state.results, state.busy]);
    if (nextResultSignature !== resultSignature) {
      resultSignature = nextResultSignature; clear(get("results"));
      state.results.forEach(result => {
        const card = document.createElement("div"); card.className = "result";
        const heading = document.createElement("div"); heading.className = "result-heading";
        heading.appendChild(text("span", result.page || result.name || result.path || "页面", "result-title"));
        if (result.path && !result.error) {
          const button = text("button", "打开 PSD"); button.disabled = state.busy;
          button.addEventListener("click", () => safely(() => controller.openResults([result]))); heading.appendChild(button);
        }
        card.appendChild(heading);
        if (result.width && result.height) card.appendChild(text("p", result.width + " × " + result.height + " px"));
        if (result.error) card.appendChild(text("p", errorText(result.error), "error"));
        (Array.isArray(result.warnings) ? result.warnings : []).forEach(warning => card.appendChild(text("p", warningText(warning), "warning")));
        get("results").appendChild(card);
      });
    }
  };
  async function safely(action) { try { await action(); } catch (error) { controller.update({ status: errorText(error), error: true }); } }
  get("connect-button").addEventListener("click", () => safely(() => controller.connect()));
  get("source-button").addEventListener("click", () => safely(() => controller.chooseSource()));
  get("output-button").addEventListener("click", () => safely(() => controller.chooseOutput()));
  get("scan-button").addEventListener("click", () => safely(() => controller.scan()));
  get("select-all").addEventListener("click", () => controller.selectAll(true));
  get("select-none").addEventListener("click", () => controller.selectAll(false));
  get("advanced-toggle").addEventListener("change", () => { get("advanced-settings").style.display = get("advanced-toggle").checked ? "block" : "none"; });
  get("import-button").addEventListener("click", () => safely(() => controller.start({ width: Number(get("default-width").value), height: Number(get("default-height").value), autoOpen: get("auto-open").checked, runScripts: get("run-scripts").checked })));
  get("cancel-button").addEventListener("click", () => safely(() => controller.cancel()));
  controller.update();
  controller.connect();
  return controller;
}

if (typeof module !== "undefined") module.exports = { HELPER_URL, HelperClient, ImportController, relativeOutputPath, mountPanel, warningText };
if (typeof document !== "undefined") {
  const uxp = require("uxp");
  const photoshop = require("photoshop");
  mountPanel(document, new ImportController({ client: new HelperClient((...args) => fetch(...args)), fs: uxp.storage.localFileSystem, photoshop }));
}
