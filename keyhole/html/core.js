const STORE = "lan-llm-chat-v4";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s)
  .replace(/&/g, "\u0026amp;")
  .replace(/</g, "\u0026lt;")
  .replace(/>/g, "\u0026gt;");
const fmt = (s) => esc(s)
  .replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`)
  .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
const nowId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const basename = (id) => String(id || "").split(/[\\/]/).pop();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  view: "chat",
  catalog: { router: {}, nodes: [], personas: {}, tasks: {}, tools: [] },
  health: {},
  props: {},
  slots: {},
  router: { ok: null, status: "" },
  selected: new Set(),
  didPick: false,
  persona: null,
  task: "general",
  threads: [],
  active: null,
  abort: null,
  toolContext: "",
  toolRaw: null,
};

function nodeById(id) {
  return state.catalog.nodes.find((n) => n.id === id);
}

function personaModel(name) {
  const p = state.catalog.personas[name];
  return p && typeof p === "object" ? p.model : p;
}

function personaPrompt(name) {
  const p = state.catalog.personas[name];
  return p && typeof p === "object" ? (p.prompt || "") : "";
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "{}");
    state.threads = Array.isArray(raw.threads) ? raw.threads : [];
    state.active = raw.active || null;
    if (raw.system) $("system").value = raw.system;
    if (raw.maxTok) $("maxTok").value = raw.maxTok;
    if (raw.temp) $("temp").value = raw.temp;
    if (raw.viaRouter) $("viaRouter").checked = true;
    if (Array.isArray(raw.selected)) state.selected = new Set(raw.selected);
    if (raw.persona) state.persona = raw.persona;
    if (raw.task) state.task = raw.task;
    if (raw.routeUser) $("routeUser").value = raw.routeUser;
    if (raw.routeBot) $("routeBot").value = raw.routeBot;
    if (raw.threads || raw.selected || raw.persona || raw.task) state.didPick = true;
  } catch {}
  if (!state.threads.length) newThread(false);
  if (!state.active || !state.threads.some((t) => t.id === state.active)) {
    state.active = state.threads[0].id;
  }
}

function save() {
  localStorage.setItem(STORE, JSON.stringify({
    threads: state.threads,
    active: state.active,
    system: $("system").value,
    maxTok: $("maxTok").value,
    temp: $("temp").value,
    viaRouter: $("viaRouter").checked,
    selected: [...state.selected],
    persona: state.persona,
    task: state.task,
    routeUser: $("routeUser").value,
    routeBot: $("routeBot").value,
  }));
}

function thread() {
  return state.threads.find((t) => t.id === state.active);
}

function newThread(select = true) {
  const t = { id: nowId(), title: "New chat", created: Date.now(), messages: [] };
  state.threads.unshift(t);
  if (select) state.active = t.id;
  save();
  return t;
}

function targets() {
  if (state.selected.size) {
    return [...state.selected].map(nodeById).filter(Boolean);
  }
  const id = state.persona
    ? personaModel(state.persona)
    : state.catalog.tasks[state.task || "general"];
  const n = nodeById(id);
  return n ? [n] : [];
}

function setView(name) {
  state.view = name;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === `view-${name}`));
  if (name === "cluster") renderCluster();
  if (name === "personas") renderPersonaCards();
}

function renderHealth() {
  const pill = $("healthPill");
  const nodes = state.catalog.nodes;
  const online = nodes.filter((n) => state.health[n.id]?.ok);
  const router = state.router.ok;
  const parts = [];
  if (router === true) parts.push("router");
  else if (router === false) parts.push("router down");
  if (nodes.length) parts.push(`${online.length}/${nodes.length} nodes`);
  pill.textContent = parts.join(" · ") || "cluster…";
  pill.className = `pill${router === false || (nodes.length && !online.length) ? " bad" : online.length || router ? " ok" : ""}`;
}
