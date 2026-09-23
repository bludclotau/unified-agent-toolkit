function renderNodes() {
  $("models").innerHTML = state.catalog.nodes.map((n) => {
    const h = state.health[n.id];
    const slots = state.slots[n.id] || [];
    const busy = slots.filter((s) => s.is_processing).length;
    const on = state.selected.has(n.id);
    const cls = `node${on ? " on" : ""}${h && !h.ok ? " offline" : ""}`;
    const processing = busy > 0;
    const dot = !h ? "wait" : !h.ok ? "bad" : processing ? "busy" : "ok";
    const status = !h ? "checking…" : !h.ok ? "offline" : `${h.model || "ready"}${slots.length ? ` · ${busy}/${slots.length} busy` : ""}`;
    return `<button class="${cls}" data-model="${esc(n.id)}" type="button">
      <i class="dot ${dot}"></i>
      <b>${esc(n.name)}</b>
      <span>${esc(n.host)} · ${esc(status)}</span>
    </button>`;
  }).join("") || `<span class="hint">No nodes in catalog.json</span>`;

  $("personas").innerHTML = Object.entries(state.catalog.personas).map(([name, spec]) => {
    const model = spec.model || spec;
    const on = !state.selected.size && state.persona === name;
    return `<button class="chip${on ? " on" : ""}" data-persona="${esc(name)}" type="button">${esc(name)} <span class="meta">→ ${esc(model)}</span></button>`;
  }).join("");

  $("tasks").innerHTML = Object.entries(state.catalog.tasks).map(([name, model]) => {
    const on = state.task === name;
    return `<button class="chip${on ? " on" : ""}" data-task="${esc(name)}" type="button">${esc(name)} <span class="meta">→ ${esc(model)}</span></button>`;
  }).join("");

  $("selPills").innerHTML = targets().map((n) => {
    const via = !state.selected.size && state.persona ? `${state.persona} → ` : "";
    const path = $("viaRouter").checked ? "router" : "direct";
    return `<span class="pill">${esc(via + n.name)} · ${path}</span>`;
  }).join("") || `<span class="pill">no node selected</span>`;
}

function renderThreads() {
  $("threads").innerHTML = state.threads.map((t) => {
    const on = t.id === state.active ? " on" : "";
    const when = new Date(t.created).toLocaleString();
    return `<div class="thread${on}" data-thread="${t.id}"><button class="ghost" data-thread="${t.id}" type="button" style="border:0;background:none;padding:0;text-align:left">${esc(t.title)}<span class="when">${esc(when)}</span></button><button class="del" data-del="${t.id}" type="button" title="Delete">×</button></div>`;
  }).join("");
}

function renderMessages() {
  const t = thread();
  const box = $("chats");
  if (!t || !t.messages.length) {
    box.innerHTML = `<div class="empty">Pick a node or persona, then send a message. Direct mode streams from llama.cpp. Personas use the prompts from gguf-router.</div>`;
    return;
  }
  box.innerHTML = "";
  for (const m of t.messages) box.appendChild(msgEl(m));
  box.scrollTop = box.scrollHeight;
}

function msgEl(m) {
  const el = document.createElement("div");
  el.className = `msg ${m.role}`;
  const who = m.role === "user" ? "you" : (m.who || "assistant");
  const meta = [m.model, m.via, m.ms ? `${(m.ms / 1000).toFixed(1)}s` : ""].filter(Boolean).join(" · ");
  const body = m.showRaw ? (m.raw || m.content) : m.content;
  const inner = m.error
    ? `<span class="err">${esc(body || "")}</span>`
    : (m.role === "assistant" ? fmt(body || "") : esc(body || ""));
  el.innerHTML = `<div class="who">${esc(who)}${meta ? `<span class="meta">${esc(meta)}</span>` : ""}</div>
    <div class="bubble">${inner}</div>`;
  if (m.role === "assistant" && m.raw && m.raw !== m.content) {
    const row = document.createElement("div");
    row.style.marginTop = "6px";
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.type = "button";
    btn.style.padding = "2px 8px";
    btn.style.fontSize = "11px";
    btn.textContent = m.showRaw ? "show cleaned" : "show raw";
    btn.onclick = () => { m.showRaw = !m.showRaw; renderMessages(); save(); };
    row.appendChild(btn);
    el.appendChild(row);
  }
  return el;
}

function addLive(who) {
  const empty = document.querySelector(".empty");
  if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="who">${esc(who)}</div><div class="bubble typing"></div>`;
  $("chats").appendChild(el);
  $("chats").scrollTop = $("chats").scrollHeight;
  return el.querySelector(".bubble");
}

function renderCluster() {
  const r = state.catalog.router || {};
  const routerCard = `<div class="card">
    <h3><i class="dot ${state.router.ok ? "ok" : state.router.ok === false ? "bad" : "wait"}"></i> ${esc(r.name || "gguf-router")}</h3>
    <div class="kv">
      <span>host</span><div class="mono">${esc(r.host || "")} (${esc(r.label || "")})</div>
      <span>health</span><div>${esc(state.router.status || "…")}</div>
      <span>repo</span><div class="mono"><a href="${esc(r.repo || "#")}" style="color:var(--blue)">${esc(r.repo || "")}</a></div>
      <span>API</span><div class="mono">GET /health · POST /route · POST /tool</div>
      <span>fallback</span><div>if Qwen /health fails, /route uses Dolphin</div>
    </div>
  </div>`;

  const nodeCards = state.catalog.nodes.map((n) => {
    const h = state.health[n.id];
    const p = state.props[n.id] || {};
    const slots = state.slots[n.id] || [];
    const dgs = p.default_generation_settings || {};
    const params = dgs.params || {};
    const busy = slots.filter((s) => s.is_processing).length;
    const slotHtml = slots.map((s) => `<div class="slot${s.is_processing ? " busy" : ""}">
      slot ${s.id}<br>${s.is_processing ? "busy" : "idle"}<br>ctx ${s.n_ctx || "?"}
    </div>`).join("") || `<span class="hint">no slot data</span>`;
    return `<div class="card">
      <h3><i class="dot ${h?.ok ? (busy ? "busy" : "ok") : h && !h.ok ? "bad" : "wait"}"></i> ${esc(n.name)}</h3>
      <div class="kv">
        <span>proxy</span><div class="mono">/api/nodes/${esc(n.id)}/ → ${esc(n.host)}</div>
        <span>model</span><div>${esc(h?.model || basename(p.model_path) || "…")}</div>
        <span>path</span><div class="mono">${esc(p.model_path || "")}</div>
        <span>quant</span><div>${esc(p.model_ftype || "")}</div>
        <span>ctx</span><div>${esc(dgs.n_ctx ?? "")}</div>
        <span>slots</span><div>${busy}/${slots.length || p.total_slots || 0} busy</div>
        <span>defaults</span><div>temp ${params.temperature ?? "?"} · top_p ${params.top_p ?? "?"} · top_k ${params.top_k ?? "?"}</div>
        <span>build</span><div class="mono">${esc(p.build_info || "")}</div>
        <span>sleeping</span><div>${p.is_sleeping ? "yes" : "no"}</div>
      </div>
      <div class="slots">${slotHtml}</div>
    </div>`;
  }).join("");

  $("cluster").innerHTML = routerCard + `<div class="grid2">${nodeCards}</div>
    <p class="hint">Live data from node <span class="mono">/health</span>, <span class="mono">/props</span>, <span class="mono">/slots</span> and router <span class="mono">/health</span>. Catalog maps come from gguf-router.</p>`;
}

function renderPersonaCards() {
  $("personaCards").innerHTML = Object.entries(state.catalog.personas).map(([name, spec]) => {
    const model = spec.model || spec;
    const prompt = spec.prompt || "";
    return `<div class="card">
      <h3>${esc(name)} <span class="pill">${esc(model)}</span></h3>
      <div class="prompt">${esc(prompt)}</div>
      <button class="send" data-use-persona="${esc(name)}" type="button">Chat as ${esc(name)}</button>
    </div>`;
  }).join("");
}

async function loadCatalog() {
  const r = await fetch("/catalog.json", { cache: "no-store" });
  if (!r.ok) throw new Error("catalog.json " + r.status);
  const j = await r.json();
  state.catalog = {
    router: j.router || {},
    nodes: j.nodes || [],
    personas: j.personas || {},
    tasks: j.tasks || {},
    tools: j.tools || [],
  };
}

async function jsonGet(url, ms = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function probeRouter() {
  try {
    const j = await jsonGet("/api/router/health");
    state.router = { ok: true, status: j.status || "ok" };
  } catch {
    state.router = { ok: false, status: "offline" };
  }
}

async function probeOne(node) {
  try {
    const r = await jsonGet(`/api/nodes/${node.id}/health`);
    if (!r || r.status !== "ok") throw new Error("health");
    let model = "";
    try {
      const m = await jsonGet(`/api/nodes/${node.id}/v1/models`);
      model = basename(m?.data?.[0]?.id || m?.models?.[0]?.name || m?.models?.[0]?.model || "");
    } catch {}
    try { state.props[node.id] = await jsonGet(`/api/nodes/${node.id}/props`, 3000); } catch {}
    try { state.slots[node.id] = await jsonGet(`/api/nodes/${node.id}/slots`, 3000); } catch { state.slots[node.id] = []; }
    state.health[node.id] = { ok: true, model };
  } catch {
    state.health[node.id] = { ok: false, model: "" };
    state.selected.delete(node.id);
  }
}

async function probe() {
  if (!state.catalog.nodes.length) {
    try { await loadCatalog(); } catch { renderHealth(); renderNodes(); return; }
  }
  await Promise.all([probeRouter(), ...state.catalog.nodes.map(probeOne)]);
  const online = state.catalog.nodes.filter((n) => state.health[n.id]?.ok);
  if (!state.didPick && !state.selected.size && !state.persona && online[0]) {
    state.selected.add(online[0].id);
  }
  state.didPick = true;
  state.selected = new Set([...state.selected].filter((id) => state.health[id]?.ok));
  renderHealth();
  renderNodes();
  if (state.view === "cluster") renderCluster();
}
