"use strict";
/* LYCO metered chat client. No shell, privileged Harness Host, or model API key. */
(function () {
  const $ = id => document.getElementById(id);
  const DB = "lyco_harness_client_v1";
  const JWT_KEY = "lyco_ai_login_token";
  const MODEL = "lyco-qwen2.5-1.5b-abliterated";
  const MAX_CALLS = 500;
  const MAX_CONTEXT_CHARS = 2200;
  const nf = new Intl.NumberFormat("zh-CN");
  let db, jwt = sessionStorage.getItem(JWT_KEY) || "", user = null, wallet = null;
  let currentSession = null, calls = [], sessions = [], view = "chat", inFlight = false, activeCallId = null, selectedTraceId = null, currentOwner = null, pointsPack = 50, order = null, notifyTimer;
  const safeId = () => (globalThis.crypto && typeof crypto.randomUUID === "function") ? crypto.randomUUID() : "lyco-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const fmt = value => nf.format(Number(value || 0));
  const timestamp = raw => { try { const t = typeof raw === "number" ? new Date(raw * 1000) : new Date(raw); return Number.isNaN(t.getTime()) ? String(raw || "") : t.toLocaleString("zh-CN"); } catch { return String(raw || ""); } };
  const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = String(text); return e; };
  const notice = (msg) => { const el = $("toast"); el.textContent = String(msg); el.classList.add("visible"); clearTimeout(notifyTimer); notifyTimer = setTimeout(() => el.classList.remove("visible"), 5200); };
  const readableError = e => String((e && e.message) || e || "未知错误");
  const numberOrNull = x => typeof x === "number" && Number.isFinite(x) ? x : null;
  const truncate = (s, n) => String(s || "").slice(0, n);

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error("浏览器不支持 IndexedDB"));
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains("calls")) {
          const records = database.createObjectStore("calls", { keyPath: "id" });
          records.createIndex("byStarted", "startedAt");
          records.createIndex("bySession", "sessionId");
        }
        if (!database.objectStoreNames.contains("sessions")) {
          const records = database.createObjectStore("sessions", { keyPath: "id" });
          records.createIndex("byUpdated", "updatedAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("无法打开本地记录库"));
      req.onblocked = () => reject(new Error("其他标签页阻止升级本地记录库"));
    });
  }
  function dbPut(store, value) {
    if (!db) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  function dbAll(store) {
    if (!db) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly"), req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  function dbDeleteCalls(ids) {
    if (!db || !ids.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("calls", "readwrite");
      const object = tx.objectStore("calls");
      ids.forEach(id => object.delete(id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  async function loadPrivateRecords() {
    if (!db || !currentOwner) {
      calls = []; sessions = []; currentSession = null; selectedTraceId = null;
      renderSessions(); renderConversation(); renderTraces();
      return;
    }
    calls = (await dbAll("calls")).filter(c => c.owner === currentOwner)
      .sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_CALLS);
    sessions = (await dbAll("sessions")).filter(s => s.owner === currentOwner)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 80);
    for (const c of calls) {
      if (c.status === "running") {
        c.status = "error"; c.completedAt = Date.now(); c.durationMs = c.completedAt - c.startedAt;
        c.error = "浏览器在请求期间关闭，服务端是否完成及积分结算未知，请检查官方积分流水";
        await dbPut("calls", c);
      }
    }
    currentSession = sessions[0] || null; selectedTraceId = null;
    renderSessions(); renderConversation(); renderTraces();
  }
  async function trimCalls() {
    if (!db || calls.length <= MAX_CALLS) return;
    const extras = calls.slice(MAX_CALLS);
    const tx = db.transaction("calls", "readwrite");
    const store = tx.objectStore("calls");
    extras.forEach(item => store.delete(item.id));
    calls = calls.slice(0, MAX_CALLS);
  }

  async function api(path, { method = "GET", body, timeout = 120000, idempotency } = {}) {
    const headers = { "Accept": "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (jwt) headers.Authorization = "Bearer " + jwt;
    if (idempotency) headers["Idempotency-Key"] = idempotency;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, { method, headers, credentials: "same-origin", cache: "no-store", signal: controller.signal, body: body === undefined ? undefined : JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const reason = payload.detail || payload.message || payload.error || "HTTP " + response.status;
        const err = new Error(typeof reason === "string" ? reason : "请求失败");
        err.status = response.status;
        throw err;
      }
      return payload;
    } finally { clearTimeout(timer); }
  }

  function selectView(next) {
    view = ["chat", "trace", "points"].includes(next) ? next : "chat";
    document.querySelectorAll(".view").forEach(e => { e.hidden = e.id !== "view-" + view; e.classList.toggle("active", !e.hidden); });
    document.querySelectorAll("[data-view]").forEach(e => e.classList.toggle("active", e.dataset.view === view));
    $("page-title").textContent = ({ chat: "AI 对话", trace: "调用记录", points: "积分中心" })[view];
    $("sidebar").classList.remove("open"); $("scrim").hidden = true;
    if (view === "trace") renderTraces();
    if (view === "points") refreshWallet();
    if (view === "chat") scrollChat();
  }
  document.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => selectView(b.dataset.view)));
  $("open-nav").onclick = () => { $("sidebar").classList.add("open"); $("scrim").hidden = false; };
  $("scrim").onclick = () => { $("sidebar").classList.remove("open"); $("scrim").hidden = true; };
  $("top-credits").onclick = () => selectView("points");
  $("clear-chat").onclick = () => createSession();
  $("new-session").onclick = () => createSession();

  function openLogin() { $("login-error").textContent = ""; $("login-modal").hidden = false; $("username").focus(); }
  function closeLogin() { $("login-modal").hidden = true; $("password").value = ""; }
  $("dismiss-login").onclick = closeLogin;
  $("login-modal").addEventListener("click", e => { if (e.target === $("login-modal")) closeLogin(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeLogin(); });
  function resetAuth() {
    jwt = ""; user = null; wallet = null;
    currentOwner = null; calls = []; sessions = []; currentSession = null; selectedTraceId = null;
    sessionStorage.removeItem(JWT_KEY);
    renderSessions(); renderConversation(); renderTraces(); renderLedger();
    $("account").textContent = "登录";
    $("top-balance").textContent = "—";
    $("wallet-balance").textContent = "—";
    $("wallet-name").textContent = "登录后查看";
  }
  $("account").onclick = () => { if (!user) openLogin(); else if (confirm("确认退出当前账号？本机聊天及调用记录将保留。")) { resetAuth(); notice("已退出登录"); } };
  $("login-form").addEventListener("submit", async e => {
    e.preventDefault(); const b = $("login-submit"); b.disabled = true; $("login-error").textContent = "";
    try {
      const result = await api("/studio/api/login", { method: "POST", body: { username: $("username").value.trim(), password: $("password").value }, timeout: 12000 });
      if (!result.ok || typeof result.token !== "string") throw new Error("登录响应异常");
      jwt = result.token;
      sessionStorage.setItem(JWT_KEY, jwt);
      await refreshWallet();
      if (!user) throw new Error("无法确认账户，请重试");
      closeLogin(); notice("已登录 LYCO");
    } catch (error) { $("login-error").textContent = readableError(error); }
    finally { b.disabled = false; }
  });
  async function refreshWallet() {
    if (!jwt) { $("wallet-name").textContent = "登录后查看"; renderLedger(); return; }
    try {
      const data = await api("/studio/api/points", { timeout: 15000 });
      if (!data.ok || !data.points) throw new Error("无法读取积分信息");
      user = { name: String(data.username || "网站账户") };
      const scope = user.name.trim().toLocaleLowerCase();
      if (!scope || scope === "网站账户") throw new Error("缺少有效账号标识，无法隔离本地会话");
      if (currentOwner !== scope) {
        if (inFlight) throw new Error("请求尚未结束，暂时不能切换账号");
        currentOwner = scope;
        await loadPrivateRecords();
      }
      wallet = data.points;
      $("account").textContent = truncate(user.name, 16);
      $("wallet-name").textContent = "账户 · " + user.name;
      $("wallet-balance").textContent = fmt(wallet.balance);
      $("top-balance").textContent = fmt(wallet.balance);
      renderLedger();
    } catch (err) {
      if (err.status === 401 || err.status === 403) { resetAuth(); notice("登录已失效，请重新登录"); }
      else notice("积分加载失败：" + readableError(err));
    }
  }
  $("refresh-points").onclick = refreshWallet;
  function renderLedger() {
    const element = $("ledger"); element.replaceChildren();
    const list = wallet && Array.isArray(wallet.entries) ? wallet.entries : [];
    let income = 0, spent = 0;
    list.forEach(e => { const d = Number(e.delta || 0); if (d >= 0) income += d; else spent -= d; });
    $("recent-in").textContent = wallet ? fmt(income) : "—";
    $("recent-out").textContent = wallet ? fmt(spent) : "—";
    if (!list.length) { element.append(node("div", "empty", jwt ? "暂无可显示的积分流水" : "登录后查看官方流水")); return; }
    list.slice(0, 50).forEach(entry => {
      const r = node("div", "ledger-row"), amount = Number(entry.delta || 0);
      r.append(node("span", "reason", String(entry.reason || "积分结算")));
      r.append(node("span", amount < 0 ? "negative" : "positive", (amount > 0 ? "+" : "") + fmt(amount)));
      r.append(node("span", "date", timestamp(entry.created_at)));
      element.append(r);
    });
  }
  document.querySelectorAll("[data-points]").forEach(b => b.onclick = () => {
    pointsPack = Number(b.dataset.points);
    document.querySelectorAll("[data-points]").forEach(e => e.classList.toggle("selected", e === b));
    $("create-order").textContent = "创建 " + pointsPack + " 积分订单";
    $("order-summary").hidden = true; order = null;
  });
  $("create-order").onclick = async () => {
    if (!jwt) { openLogin(); return; }
    const b = $("create-order"); b.disabled = true;
    try {
      const result = await api("/studio/api/points/topup", { method: "POST", body: { points: pointsPack }, timeout: 20000 });
      if (!result.ok || !result.order_no || !result.wallet) throw new Error("充值订单响应不完整");
      order = result;
      $("order-no").textContent = String(result.order_no);
      $("order-network").textContent = String(result.network || "请以服务端订单为准");
      $("order-amount").textContent = String(result.amount_usdt) + " USDT";
      $("order-address").textContent = String(result.wallet);
      $("order-summary").hidden = false;
      notice("订单已创建，请核对收款地址和金额后付款");
    } catch (err) { notice(readableError(err)); }
    finally { b.disabled = false; }
  };
  $("copy-order").onclick = async () => {
    if (!order) return;
    try {
      await navigator.clipboard.writeText("订单：" + order.order_no + "\n网络：" + order.network + "\n金额：" + order.amount_usdt + " USDT\n收款地址：" + order.wallet);
      notice("付款信息已复制");
    } catch { notice("复制失败，请手动复制订单信息"); }
  };

  const scrollChat = () => { const c = $("conversation"); c.scrollTop = c.scrollHeight; };
  function messageNode(role, content, meta) {
    const message = node("div", "message " + role);
    const avatar = node("div", "message-avatar", role === "user" ? "我" : "✦");
    const body = node("div", "message-body"), title = node("div", "message-title", role === "user" ? "你" : "LYCO AI");
    const text = node("div", "message-content", content);
    body.append(title, text);
    if (meta) body.append(node("div", "message-meta", meta));
    message.append(avatar, body);
    return { element: message, text };
  }
  async function saveSession(session) {
    session.updatedAt = Date.now();
    if (!currentOwner || session.owner !== currentOwner) return;
    await dbPut("sessions", session);
    sessions = sessions.filter(s => s.id !== session.id);
    sessions.unshift(session);
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    renderSessions();
  }
  function createSession() {
    if (inFlight) { notice("请求进行中，请稍后新建对话"); return; }
    currentSession = { id: safeId(), owner: currentOwner, title: "新对话", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    if (currentOwner) saveSession(currentSession).catch(() => notice("本地保存失败"));
    renderConversation(); selectView("chat"); $("prompt").focus();
  }
  function renderSessions() {
    const list = $("sessions"); list.replaceChildren();
    if (!sessions.length) { list.append(node("div", "empty", "尚无本地会话")); return; }
    sessions.slice(0, 80).forEach(s => {
      const btn = node("button", "session-button" + (currentSession && currentSession.id === s.id ? " selected" : ""), truncate(s.title, 31));
      btn.type = "button";
      btn.append(node("span", "session-sub", timestamp(s.updatedAt)));
      btn.onclick = () => { if (inFlight) { notice("请等待当前请求完成"); return; } currentSession = s; renderConversation(); renderSessions(); selectView("chat"); };
      list.append(btn);
    });
  }
  function renderConversation() {
    const c = $("conversation"); c.querySelectorAll(".message").forEach(e => e.remove());
    $("welcome").hidden = Boolean(currentSession && currentSession.messages.length);
    if (currentSession) currentSession.messages.forEach(m => c.append(messageNode(m.role, m.content, m.meta).element));
    scrollChat();
  }
  document.querySelectorAll("[data-suggest]").forEach(b => b.onclick = () => { selectView("chat"); $("prompt").value = b.dataset.suggest || ""; $("prompt").focus(); });
  $("prompt").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  $("send").onclick = () => send();

  function buildContext(messages) {
    const recent = messages.map(x => ({ role: x.role, content: x.content }));
    while (recent.length > 1 && recent.reduce((n, x) => n + x.content.length, 0) > MAX_CONTEXT_CHARS) recent.shift();
    if (recent.reduce((n, x) => n + x.content.length, 0) > 2400) throw new Error("上下文超限，请新建对话");
    return recent;
  }
  function isSevereLoop(text) {
    // Warning only; the server is the authority for rejection and points refund.
    const clean = String(text || "").replace(/\s+/g, "");
    if (clean.length < 100) return false;
    for (let n = 6; n <= 20; n++) {
      for (let i = 0; i + n * 4 <= clean.length; i++) {
        const segment = clean.slice(i, i + n);
        if (clean.slice(i + n, i + n * 4) === segment.repeat(3)) return true;
      }
    }
    return false;
  }
  async function putCall(call) {
    await dbPut("calls", call);
    calls = [call].concat(calls.filter(x => x.id !== call.id));
    calls.sort((a, b) => b.startedAt - a.startedAt);
    $("call-counter").textContent = fmt(calls.length);
    trimCalls().catch(() => {});
    if (view === "trace") renderTraces();
  }
  async function send() {
    if (inFlight) return;
    const text = $("prompt").value.trim();
    if (!text) return;
    if (!jwt) { openLogin(); notice("请先登录 LYCO 账号"); return; }
    if (!user) await refreshWallet();
    if (!user || !currentOwner) { openLogin(); return; }
    if (!currentSession || currentSession.owner !== currentOwner) createSession();
    const before = currentSession.messages.slice();
    let context;
    try { context = buildContext(before.concat({ role: "user", content: text })); } catch (error) { notice(readableError(error)); return; }
    inFlight = true; $("send").disabled = true; $("prompt").disabled = true; $("prompt").value = "";
    if (before.length === 0) currentSession.title = truncate(text, 25);
    currentSession.messages.push({ role: "user", content: text });
    await saveSession(currentSession);
    $("welcome").hidden = true; renderConversation();
    const pending = messageNode("assistant", "正在生成回答…");
    pending.element.classList.add("pending"); $("conversation").append(pending.element); scrollChat();
    const requestId = safeId(), startedAt = Date.now(), idempotency = safeId(), model = MODEL;
    let call = {
      id: requestId, owner: currentOwner, sessionId: currentSession.id, model,
      path: "/ai-api/chat", startedAt, completedAt: null, durationMs: null, httpStatus: null,
      status: "running", clientRequestId: idempotency,
      request: { messages: context, temperature: 0.55, max_tokens: 180, stream: false },
      response: null, output: "", error: "", usage: null, billing: null, serverResponseId: null
    };
    try { await putCall(call); } catch { notice("本地调用日志暂不可用"); }
    activeCallId = requestId;
    try {
      const result = await api("/ai-api/chat", { method: "POST", idempotency, body: { model, ...call.request }, timeout: 120000 });
      const content = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("模型返回了空内容，请检查积分流水");
      const loop = isSevereLoop(content);
      const warning = loop ? " ⚠ 检测到循环回答；请检查积分流水，不要重复发送" : "";
      const tokenCount = Number(result.usage && result.usage.total_tokens);
      const charged = Number(result.billing && result.billing.points_charged);
      const meta = (Number.isFinite(tokenCount) ? fmt(tokenCount) + " Token · " : "") + (Number.isFinite(charged) ? "消耗 " + fmt(charged) + " 积分" : "结算数据不可用") + warning;
      pending.text.textContent = content; pending.element.classList.remove("pending");
      pending.element.querySelector(".message-body").append(node("div", "message-meta", meta));
      currentSession.messages.push({ role: "assistant", content, meta });
      await saveSession(currentSession);
      call = { ...call, status: loop ? "warning" : "success", httpStatus: 200, output: content,
        serverResponseId: result.id || null, usage: result.usage || null, billing: result.billing || null, response: { finishReason: result.choices[0].finish_reason || null, content } };
      if (loop) notice("回答疑似重复循环；当前记录已标注，服务端计费请以流水为准");
      await refreshWallet();
    } catch (err) {
      pending.element.classList.remove("pending"); pending.element.classList.add("error");
      pending.text.textContent = "请求失败。请检查调用记录与积分流水；为避免重复扣费，系统不会自动重试。";
      call = { ...call, status: "error", httpStatus: numberOrNull(err.status), error: readableError(err) };
      notice(err.status === 402 ? "积分不足，请前往积分中心充值" : readableError(err));
      await refreshWallet();
    } finally {
      call.completedAt = Date.now(); call.durationMs = call.completedAt - call.startedAt;
      try { await putCall(call); } catch { notice("这次本地调用记录保存失败"); }
      inFlight = false; activeCallId = null; $("send").disabled = false; $("prompt").disabled = false; scrollChat(); $("prompt").focus();
    }
  }

  function renderTraces() {
    const rows = $("trace-list"); rows.replaceChildren();
    $("call-counter").textContent = fmt(calls.length);
    $("stat-total").textContent = fmt(calls.length);
    $("stat-success").textContent = fmt(calls.filter(c => c.status === "success").length);
    $("stat-tokens").textContent = fmt(calls.reduce((n, c) => n + Number(c.usage && c.usage.total_tokens || 0), 0));
    $("stat-points").textContent = fmt(calls.reduce((n, c) => n + Number(c.billing && c.billing.points_charged || 0), 0));
    const search = $("trace-search").value.trim().toLocaleLowerCase();
    const status = $("trace-status").value;
    const list = calls.filter(c => (status === "all" || c.status === status)
      && (!search || JSON.stringify({ model: c.model, req: c.request, output: c.output, error: c.error }).toLocaleLowerCase().includes(search)));
    if (!list.length) { rows.append(node("div", "empty", currentOwner ? "没有符合条件的调用记录" : "登录后查看当前账号的本地调用记录")); return; }
    list.slice(0, 300).forEach(c => {
      const el = node("button", "trace-item" + (selectedTraceId === c.id ? " selected" : ""));
      el.type = "button"; const row = node("div", "row"), content = c.request && c.request.messages || [];
      row.append(node("span", "title", "#" + truncate(c.id, 8)), node("span", "status " + (c.status === "success" ? "success" : c.status === "error" ? "error" : ""), c.status));
      el.append(row, node("p", "", truncate(content.length ? content[content.length - 1].content : "", 160)), node("small", "", timestamp(c.startedAt) + " · " + (c.durationMs != null ? c.durationMs + " ms" : "进行中")));
      el.onclick = () => { selectedTraceId = c.id; renderTraces(); renderTraceDetails(c); };
      rows.append(el);
    });
  }
  $("trace-search").oninput = renderTraces;
  $("trace-status").onchange = renderTraces;
  function renderTraceDetails(call) {
    const e = $("trace-detail"); e.replaceChildren();
    e.append(node("div", "detail-title", "请求 · " + call.id));
    e.append(node("div", "detail-caption", call.model + " · " + timestamp(call.startedAt) + " · " + call.status));
    const stats = node("div", "detail-stats");
    [[ "耗时", call.durationMs == null ? "—" : (call.durationMs / 1000).toFixed(2) + "s" ],
      [ "Tokens", call.usage ? fmt(call.usage.total_tokens) : "—" ],
      [ "积分", call.billing ? fmt(call.billing.points_charged) : "—" ]]
      .forEach(([k, v]) => { const box = node("div"); box.append(node("small", "", k), node("strong", "", v)); stats.append(box); });
    e.append(stats);
    const line1 = node("div", "timeline", "请求发起：" + timestamp(call.startedAt)), line2 = node("div", "timeline", call.completedAt ? "请求完成：" + timestamp(call.completedAt) : "请求仍在进行或页面已中断");
    e.append(line1, line2);
    const sections = [
      ["请求信息", { endpoint: call.path, model: call.model, clientRequestId: call.clientRequestId, httpStatus: call.httpStatus, startedAt: call.startedAt, completedAt: call.completedAt, durationMs: call.durationMs, ttft: "未提供真实流式时间，不计入" }],
      ["模型输入", call.request],
      ["模型输出", call.response || { content: call.output, error: call.error }],
      ["用量与结算", { usage: call.usage, billing: call.billing }],
    ];
    sections.forEach(([title, value]) => { const block = node("div", "detail-section"); block.append(node("h3", "", title), node("pre", "", JSON.stringify(value, null, 2))); e.append(block); });
  }
  $("export-traces").onclick = async () => {
    if (!currentOwner) { openLogin(); return; }
    const data = { schema: "lyco-harness-client-v1", exportedAt: new Date().toISOString(), account: currentOwner, note: "Contains user prompts and model outputs. Contains no passwords or JWTs.", calls, sessions };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a"), url = URL.createObjectURL(blob);
    a.href = url; a.download = "lyco-client-traces-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); notice("调用轨迹已导出为 JSON，包含对话内容，请妥善保管");
  };
  $("clear-traces").onclick = async () => {
    if (!confirm("确定清空此浏览器内保存的调用记录？此操作不可撤销，但不会删除服务器上的积分流水。")) return;
    try { if (!currentOwner) { openLogin(); return; } await dbDeleteCalls(calls.map(c => c.id)); calls = []; selectedTraceId = null; $("trace-detail").replaceChildren(node("div", "detail-intro", "本地调用记录已清空")); renderTraces(); notice("已清空当前账号的本地记录"); }
    catch (err) { notice("清理失败：" + readableError(err)); }
  };

  async function modelHealth() {
    try {
      const response = await api("/ai-api/model-status", { timeout: 6500 });
      const ok = Boolean(response.online);
      $("state-dot").className = "state-dot " + (ok ? "online" : "offline");
      $("model-status").textContent = ok ? "Radxa A7A 已连接" : "推理服务暂不可用";
    } catch {
      $("state-dot").className = "state-dot offline";
      $("model-status").textContent = "模型状态待确认";
    }
  }
  async function boot() {
    try {
      db = await openDatabase();
      // Never expose another website account's locally cached conversations.
      if (jwt) await refreshWallet();
      else await loadPrivateRecords();
    } catch (error) { notice("本地轨迹不可用：" + readableError(error)); }
    if (!currentSession) createSession(); else { renderSessions(); renderConversation(); }
    selectView("chat"); modelHealth(); if (!jwt) renderTraces();
    setInterval(modelHealth, 55000);
  }
  boot();
})();
