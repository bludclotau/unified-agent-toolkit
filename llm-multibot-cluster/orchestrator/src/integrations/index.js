const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function exists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function which(bin) {
  const parts = (process.env.PATH || "").split(path.delimiter);
  for (const dir of parts) {
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function ping(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.ok, status: response.status };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function sessionName(persona) {
  const cleaned = String(persona || "control")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return `gguf-${(cleaned || "control").slice(0, 40)}`;
}

function requireHttp(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("url must be http or https");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must be http or https");
  }
  if (parsed.username || parsed.password) throw new Error("url must not contain credentials");
  return url;
}

function requireRef(ref) {
  const value = String(ref || "").trim();
  if (!/^@?[A-Za-z][A-Za-z0-9_:-]{0,63}$/.test(value)) {
    throw new Error("ref must be an @ref such as @e1");
  }
  return value.startsWith("@") ? value : `@${value}`;
}

function requireText(text) {
  const value = String(text || "");
  if (!value.trim() || value.length > 4000 || /[\u0000\n\r]/.test(value)) {
    throw new Error("text must be a single line");
  }
  return value;
}

function agentBrowserCommands(action, body = {}) {
  if (action === "open") return [["open", requireHttp(body.url)]];
  if (action === "close") return [["close"]];
  if (action === "snapshot") {
    return body.url ? [["open", requireHttp(body.url)], ["snapshot"]] : [["snapshot"]];
  }
  if (action === "read") return body.url ? [["read", requireHttp(body.url)]] : [["read"]];
  if (action === "click") return [["click", requireRef(body.ref)]];
  if (action === "fill") return [["fill", requireRef(body.ref), requireText(body.text)]];
  if (action === "type") return [["type", requireRef(body.ref), requireText(body.text)]];
  if (action === "press") {
    const key = String(body.key || "");
    if (!["Enter", "Tab", "Escape", "Backspace"].includes(key)) throw new Error("key is not allowed");
    return [["press", key]];
  }
  throw new Error("action must be open, snapshot, read, click, fill, type, press, or close");
}

function directoryHasPrefix(root, prefix) {
  try {
    return fs.readdirSync(root).some((name) => name.startsWith(prefix));
  } catch {
    return false;
  }
}

function runCommand(bin, args, { cwd, timeoutMs = 30000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (buf) => {
      stdout += buf.toString();
      if (stdout.length > 8000) stdout = stdout.slice(-8000);
    });
    child.stderr.on("data", (buf) => {
      stderr += buf.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: err.message });
    });
  });
}

function createIntegrations(config) {
  const root = config.integrationsDir;

  function repo(name) {
    const dir = path.join(root, name);
    return { name, dir, present: exists(dir) };
  }

  async function status() {
    const [router, keyhole, letta] = await Promise.all([
      ping(`${config.ggufRouterUrl}/health`),
      ping(`${config.keyholeUrl}/`),
      ping(`${config.lettaUrl}/v1/health/`),
    ]);
    const browserUse = repo("browser-use");
    const browserAgent = repo("browser-agent");
    const agentBrowserRepo = repo("agent-browser");
    const derpr = repo("derpr-python");
    const aizen = repo("aizen");
    const lettaRepo = repo("letta");
    return {
      "gguf-router": {
        role: "Persona router and tool log. Orchestrator chat does not pass through it.",
        url: config.ggufRouterUrl,
        ...router,
      },
      keyhole: {
        role: "LAN console. Proxies llama.cpp nodes, the router, and this API.",
        url: config.keyholeUrl,
        ...keyhole,
      },
      "browser-use": {
        role: "Python browser agent. Left out of the router process so it cannot start a second model loop.",
        primary: false,
        ready: false,
        ...browserUse,
        entry: browserUse.present && fs.existsSync(path.join(browserUse.dir, "browser_use")),
      },
      "browser-agent": {
        role: "One-shot accessibility snapshot. Control API only.",
        primary: false,
        ...browserAgent,
        entry: browserAgent.present && fs.existsSync(path.join(browserAgent.dir, "bin", "agent.ts")),
        chromium: directoryHasPrefix(path.join(process.env.HOME || "/home/wendy", ".cache/ms-playwright"), "chromium"),
        ready: directoryHasPrefix(path.join(process.env.HOME || "/home/wendy", ".cache/ms-playwright"), "chromium")
          && fs.existsSync(path.join(browserAgent.dir, "node_modules", "playwright")),
      },
      "agent-browser": {
        role: "Primary browser executor. gguf-router drives it with one session per persona.",
        primary: true,
        bin: which("agent-browser"),
        chrome: directoryHasPrefix(path.join(process.env.HOME || "/home/wendy", ".agent-browser/browsers"), "chrome-"),
        ready: Boolean(which("agent-browser"))
          && directoryHasPrefix(path.join(process.env.HOME || "/home/wendy", ".agent-browser/browsers"), "chrome-"),
        ...agentBrowserRepo,
      },
      "derpr-python": {
        role: "Separate persona orchestrator. Not auto-started, so it cannot take these Discord tokens.",
        primary: false,
        ready: false,
        ...derpr,
        localLlm: config.llmUrl,
      },
      aizen: {
        role: "Local coding agent pointed at the cluster OpenAI-compatible endpoint.",
        primary: false,
        ready: false,
        bin: which("aizen"),
        ...aizen,
      },
      letta: {
        role: "Stateful agent memory. Health is probed; chat still uses the cluster LLM.",
        primary: false,
        ready: false,
        url: config.lettaUrl,
        ...letta,
        ...lettaRepo,
      },
    };
  }

  async function invoke(name, body = {}) {
    if (name === "agent-browser") {
      const bin = which("agent-browser");
      if (!bin) return { ok: false, error: "agent-browser is not on PATH" };
      let commands;
      try {
        commands = agentBrowserCommands(body.action, body);
      } catch (err) {
        return { ok: false, error: err.message };
      }
      const session = sessionName(body.persona);
      const steps = [];
      for (const argv of commands) {
        const result = await runCommand(bin, ["--session", session, "--restore", ...argv], { timeoutMs: 60000 });
        steps.push(result);
        if (result.code !== 0) {
          return { ok: false, session, steps, stdout: result.stdout, stderr: result.stderr, code: result.code };
        }
      }
      return {
        ok: true,
        session,
        stdout: steps.map((step) => step.stdout).filter(Boolean).join("\n"),
        steps,
      };
    }

    if (name === "browser-agent") {
      const info = repo("browser-agent");
      const entry = path.join(info.dir, "bin", "agent.ts");
      if (!fs.existsSync(entry)) return { ok: false, error: "browser-agent is not cloned" };
      let url;
      try {
        url = requireHttp(body.url);
      } catch (err) {
        return { ok: false, error: err.message };
      }
      const npx = which("npx");
      if (!npx) return { ok: false, error: "npx is not installed" };
      const result = await runCommand(npx, ["tsx", entry, "snapshot", url], {
        cwd: info.dir,
        timeoutMs: 90000,
        env: { HEADLESS: "true" },
      });
      return { ok: result.code === 0, ...result };
    }

    if (name === "gguf-router") {
      const health = await ping(`${config.ggufRouterUrl}/health`);
      return { ok: health.ok, health };
    }

    return {
      ok: false,
      error: `${name} is registered for status only. Chat completions stay on ${config.llmUrl}.`,
    };
  }

  return { status, invoke };
}

module.exports = {
  createIntegrations,
  ping,
  runCommand,
  agentBrowserCommands,
  sessionName,
};
