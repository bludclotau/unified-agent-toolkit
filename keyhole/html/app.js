function systemForChat() {
  const parts = [];
  if (state.persona && !state.selected.size) {
    const pre = personaPrompt(state.persona);
    if (pre) parts.push(pre);
  } else {
    const sys = $("system").value.trim();
    if (sys) parts.push(sys);
  }
  if (state.task) parts.push(`Task context: ${state.task}`);
  if (state.toolContext) parts.push(`Tool result: ${state.toolContext}`);
  return parts.join("\n\n");
}

function chatMessages(node, history) {
  const msgs = [];
  const sys = systemForChat();
  if (sys) msgs.push({ role: "system", content: sys });
  for (const m of history.slice(-24)) {
    if (m.error || (m.role !== "user" && m.role !== "assistant")) continue;
    if (m.role === "assistant" && m.node && m.node !== node.id) continue;
    msgs.push({ role: m.role, content: m.content });
  }
  return msgs;
}

async function streamChat(node, messages, signal, onTok) {
  const res = await fetch(`/api/nodes/${node.id}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: state.health[node.id]?.model || "local",
      messages,
      temperature: Number($("temp").value) || 0.8,
      max_tokens: Number($("maxTok").value) || 512,
      stream: true,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const line of parts) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const tok = j.choices?.[0]?.delta?.content || j.choices?.[0]?.text || "";
        if (tok) {
          out += tok;
          onTok(out);
        }
      } catch {}
    }
  }
  return out;
}

async function routeChat(node, userText, signal, uid) {
  const body = {
    prompt: userText,
    persona: state.selected.size ? node.id : (state.persona || node.id),
    task: state.task,
    user_id: uid,
    bot_name: $("routeBot").value.trim() || "lan-chat",
    n_predict: Number($("maxTok").value) || 512,
    max_tokens: Number($("maxTok").value) || 512,
    stream: false,
  };
  if (state.toolContext) {
    body.tool = "web_fetch";
    body.args = { url: $("toolUrl").value.trim() || "attached" };
    body.prompt = `Tool result: ${state.toolContext}\n\n${userText}`;
  }
  for (let i = 0; i < 4; i++) {
    const res = await fetch("/api/router/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const j = await res.json();
    if (j.clean === "Cooldown active.") {
      await sleep(2100);
      continue;
    }
    return j;
  }
  throw new Error("Router cooldown stayed active.");
}

$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-view]");
  if (btn) setView(btn.dataset.view);
});

$("models").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-model]");
  if (!btn) return;
  const id = btn.dataset.model;
  if (state.health[id] && !state.health[id].ok) return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  if (state.selected.size) state.persona = null;
  renderNodes();
  save();
});

$("personas").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-persona]");
  if (!btn) return;
  const name = btn.dataset.persona;
  state.selected.clear();
  state.persona = state.persona === name ? null : name;
  renderNodes();
  save();
});

$("tasks").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-task]");
  if (!btn) return;
  state.task = btn.dataset.task;
  renderNodes();
  save();
});

$("personaCards").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-use-persona]");
  if (!btn) return;
  state.selected.clear();
  state.persona = btn.dataset.usePersona;
  renderNodes();
  save();
  setView("chat");
});

$("threads").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    const id = del.dataset.del;
    state.threads = state.threads.filter((t) => t.id !== id);
    if (!state.threads.length) newThread(true);
    else if (state.active === id) state.active = state.threads[0].id;
    save();
    renderThreads();
    renderMessages();
    return;
  }
  const btn = e.target.closest("[data-thread]");
  if (!btn) return;
  state.active = btn.dataset.thread;
  save();
  renderThreads();
  renderMessages();
});

$("newChat").onclick = () => {
  newThread(true);
  renderThreads();
  renderMessages();
};

$("menu").onclick = () => document.body.classList.toggle("nav");
$("stop").onclick = () => { if (state.abort) state.abort.abort(); };
$("system").onchange = save;
$("maxTok").onchange = save;
$("temp").onchange = save;
$("viaRouter").onchange = () => { renderNodes(); save(); };
$("routeUser").onchange = save;
$("routeBot").onchange = save;

$("toolFetch").onclick = async () => {
  const url = $("toolUrl").value.trim();
  if (!url) return;
  $("toolOut").textContent = "fetching…";
  $("toolFetch").disabled = true;
  try {
    const res = await fetch("/api/router/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "web_fetch",
        args: { url },
        user_id: $("routeUser").value.trim() || "lan-chat",
        bot_name: $("routeBot").value.trim() || "lan-chat",
      }),
    });
    const j = await res.json();
    state.toolRaw = j;
    $("toolOut").textContent = JSON.stringify(j, null, 2);
    const result = j.result || {};
    if (result.text) state.toolContext = String(result.text).slice(0, 4000);
    else if (result.error) state.toolContext = "";
  } catch (err) {
    $("toolOut").textContent = String(err);
  } finally {
    $("toolFetch").disabled = false;
  }
};

function toolToken() {
  const value = $("toolToken").value.trim();
  if (value) sessionStorage.setItem("keyhole.toolToken", value);
  return sessionStorage.getItem("keyhole.toolToken") || "";
}

$("toolToken").value = sessionStorage.getItem("keyhole.toolToken") || "";

function authHeaders() {
  const token = toolToken();
  return token
    ? { Authorization: "Bearer " + token, "X-Tool-Token": token, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

$("integrationRefresh").onclick = async () => {
  const token = toolToken();
  if (!token) {
    $("integrationStatus").textContent = "Paste the orchestrator API token first.";
    return;
  }
  $("integrationStatus").textContent = "loading…";
  try {
    const res = await fetch("/api/orchestrator/integrations", { headers: authHeaders() });
    const body = await res.json();
    if (!res.ok) {
      $("integrationStatus").textContent = JSON.stringify(body);
      return;
    }
    const interesting = ["agent-browser", "browser-agent", "browser-use"];
    const lines = interesting.map((name) => {
      const row = body[name] || {};
      return `${name}: ready=${Boolean(row.ready)} primary=${Boolean(row.primary)} ${row.role || ""}`;
    });
    $("integrationStatus").textContent = lines.join("\n");
  } catch (err) {
    $("integrationStatus").textContent = String(err);
  }
};

function browserArgs() {
  const action = $("browserAction").value;
  const args = {};
  const url = $("browserUrl").value.trim();
  const ref = $("browserRef").value.trim();
  const text = $("browserText").value.trim();
  if (url) args.url = url;
  if (ref) args.ref = ref;
  if (action === "browser_plan") args.goal = text;
  else if (text) args.text = text;
  if (action === "browser_login") {
    args.username = $("browserUser").value.trim();
    if ($("browserPass").value) args.password = $("browserPass").value;
    if ($("browserUserRef").value.trim()) args.username_ref = $("browserUserRef").value.trim();
    if ($("browserPassRef").value.trim()) args.password_ref = $("browserPassRef").value.trim();
    if (ref) args.submit_ref = ref;
  }
  return args;
}

$("browserRun").onclick = async () => {
  if (!toolToken()) {
    $("browserOut").textContent = "Paste the orchestrator API token first.";
    return;
  }
  $("browserOut").textContent = "running…";
  $("browserRun").disabled = true;
  try {
    const res = await fetch("/api/router/tool", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        tool: $("browserAction").value,
        persona: $("browserPersona").value.trim() || "wendy",
        args: browserArgs(),
        user_id: "keyhole",
        bot_name: "keyhole",
      }),
    });
    const body = await res.json();
    $("browserOut").textContent = JSON.stringify(body, null, 2);
    const text = body?.result?.stdout || body?.result?.final || "";
    if (text) state.toolContext = String(text).slice(0, 4000);
  } catch (err) {
    $("browserOut").textContent = String(err);
  } finally {
    $("browserRun").disabled = false;
    $("browserPass").value = "";
  }
};

async function orchestratorInvoke(name, payload) {
  if (!toolToken()) {
    $("browserOut").textContent = "Paste the orchestrator API token first.";
    return;
  }
  $("browserOut").textContent = "running…";
  const res = await fetch("/api/orchestrator/integrations/" + name + "/invoke", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  $("browserOut").textContent = JSON.stringify(body, null, 2);
}

$("agentSnapshot").onclick = () => orchestratorInvoke("agent-browser", {
  action: "snapshot",
  url: $("browserUrl").value.trim(),
  persona: $("browserPersona").value.trim() || "wendy",
}).catch((err) => { $("browserOut").textContent = String(err); });

$("agentCliSnapshot").onclick = () => orchestratorInvoke("browser-agent", {
  url: $("browserUrl").value.trim(),
}).catch((err) => { $("browserOut").textContent = String(err); });

$("toolAttach").onclick = () => {
  const j = state.toolRaw;
  const text = j?.result?.text || j?.result?.title || $("toolOut").textContent;
  state.toolContext = String(text || "").slice(0, 4000);
  setView("chat");
};

$("routeSend").onclick = async () => {
  const prompt = $("routePrompt").value.trim();
  if (!prompt) return;
  $("routeOut").textContent = "routing…";
  $("routeSend").disabled = true;
  try {
    const res = await fetch("/api/router/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        persona: state.persona || (targets()[0] && targets()[0].id) || "qwen",
        task: state.task,
        user_id: $("routeUser").value.trim() || "lan-chat",
        bot_name: $("routeBot").value.trim() || "lan-chat",
        n_predict: Number($("routeN").value) || 128,
      }),
    });
    const j = await res.json();
    $("routeOut").textContent = JSON.stringify(j, null, 2);
  } catch (err) {
    $("routeOut").textContent = String(err);
  } finally {
    $("routeSend").disabled = false;
  }
};

$("form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("prompt").value.trim();
  const t = thread();
  const nodes = targets().filter((n) => state.health[n.id]?.ok || $("viaRouter").checked);
  if (!text || !t || state.abort) return;
  if (!nodes.length) {
    addLive("error").innerHTML = `<span class="err">No online node selected.</span>`;
    return;
  }
  $("prompt").value = "";
  t.messages.push({ role: "user", content: text });
  if (t.title === "New chat") t.title = text.slice(0, 48);
  renderThreads();
  renderMessages();
  const ac = new AbortController();
  state.abort = ac;
  $("send").disabled = true;
  $("stop").disabled = false;
  const viaRouter = $("viaRouter").checked;
  const uidBase = $("routeUser").value.trim() || "lan-chat";
  try {
    await Promise.all(nodes.map(async (node, i) => {
      const who = `${node.name} · ${viaRouter ? "router" : node.host}`;
      const bubble = addLive(who);
      const started = performance.now();
      try {
        if (viaRouter) {
          const uid = nodes.length > 1 ? `${uidBase}-${node.id}` : uidBase;
          const j = await routeChat(node, text, ac.signal, uid);
          const clean = j.clean || j.content || "";
          const raw = j.raw || clean;
          const model = j.model || node.id;
          bubble.classList.remove("typing");
          bubble.innerHTML = fmt(clean);
          t.messages.push({
            role: "assistant",
            content: clean,
            raw,
            who: `${node.name} → ${model}`,
            node: node.id,
            model,
            via: "router",
            ms: performance.now() - started,
          });
        } else {
          const out = await streamChat(node, chatMessages(node, t.messages), ac.signal, (s) => {
            bubble.classList.remove("typing");
            bubble.innerHTML = fmt(s);
            $("chats").scrollTop = $("chats").scrollHeight;
          });
          bubble.classList.remove("typing");
          bubble.innerHTML = fmt(out);
          t.messages.push({
            role: "assistant",
            content: out,
            who,
            node: node.id,
            model: state.health[node.id]?.model || node.id,
            via: "direct",
            ms: performance.now() - started,
          });
        }
        save();
      } catch (err) {
        const msg = err.name === "AbortError" ? "stopped" : String(err.message || err);
        bubble.classList.remove("typing");
        bubble.innerHTML = `<span class="err">${esc(msg)}</span>`;
        t.messages.push({
          role: "assistant",
          content: msg,
          who,
          node: node.id,
          error: true,
        });
      }
    }));
  } finally {
    state.abort = null;
    $("send").disabled = false;
    $("stop").disabled = true;
    renderMessages();
    save();
  }
};

$("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("form").requestSubmit();
  }
});

(async () => {
  load();
  renderThreads();
  renderMessages();
  renderNodes();
  renderHealth();
  try { await loadCatalog(); } catch {}
  renderPersonaCards();
  await probe();
  setInterval(probe, 15000);
})();
