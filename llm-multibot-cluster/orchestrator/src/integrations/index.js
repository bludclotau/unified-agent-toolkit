const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HTTP_URL = /^https?:\/\/[^\s]+$/i;

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

function runCommand(bin, args, { cwd, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
        role: "Python browser agent. Chat completions stay on the cluster LLM.",
        ...browserUse,
        entry: browserUse.present && fs.existsSync(path.join(browserUse.dir, "browser_use")),
      },
      "browser-agent": {
        role: "Playwright agent. Invoke only from the control API.",
        ...browserAgent,
        entry: browserAgent.present && fs.existsSync(path.join(browserAgent.dir, "bin", "agent.ts")),
      },
      "agent-browser": {
        role: "Browser automation CLI.",
        bin: which("agent-browser"),
        ...agentBrowserRepo,
      },
      "derpr-python": {
        role: "Separate persona orchestrator. Not auto-started, so it cannot take these Discord tokens.",
        ...derpr,
        localLlm: config.llmUrl,
      },
      aizen: {
        role: "Local coding agent pointed at the cluster OpenAI-compatible endpoint.",
        bin: which("aizen"),
        ...aizen,
      },
      letta: {
        role: "Stateful agent memory. Health is probed; chat still uses the cluster LLM.",
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
      const action = body.action;
      const url = body.url;
      if (!["open", "snapshot", "close"].includes(action)) {
        return { ok: false, error: "action must be open, snapshot, or close" };
      }
      if (action !== "close" && !HTTP_URL.test(url || "")) {
        return { ok: false, error: "url must be http or https" };
      }
      const args = action === "close" ? ["close"] : [action, url];
      const result = await runCommand(bin, args, { timeoutMs: 45000 });
      return { ok: result.code === 0, ...result };
    }

    if (name === "browser-agent") {
      const info = repo("browser-agent");
      const entry = path.join(info.dir, "bin", "agent.ts");
      if (!fs.existsSync(entry)) return { ok: false, error: "browser-agent is not cloned" };
      const url = body.url;
      if (!HTTP_URL.test(url || "")) return { ok: false, error: "url must be http or https" };
      const npx = which("npx");
      if (!npx) return { ok: false, error: "npx is not installed" };
      const result = await runCommand(npx, ["tsx", entry, "snapshot", url], {
        cwd: info.dir,
        timeoutMs: 60000,
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

module.exports = { createIntegrations, ping, runCommand };
