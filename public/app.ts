// ELIZA-AI web frontend: WS streaming chat (primary) + REST fallback.
// Mirrors zap's public/app.ts structure, text-only (no mic/TTS).
const $ = (id: string) => document.getElementById(id)!;
const logEl = $("log"), statusEl = $("status"), statusText = $("statusText"),
  modelEl = $("model"), backendEl = $("backend"),
  ctxEl = $("ctx"), traceEl = $("trace"),
  textIn = $("textIn") as HTMLInputElement,
  sendBtn = $("sendBtn") as HTMLButtonElement,
  stopBtn = $("stopBtn") as HTMLButtonElement;

let ws: WebSocket | null = null;
let busy = false;

function log(who: string, text: string, cls = "") {
  const d = document.createElement("div");
  d.className = `msg ${cls}`;
  d.innerHTML = `<div class="who"></div><div class="body"></div>`;
  d.querySelector(".who")!.textContent = who;
  d.querySelector(".body")!.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
  return d;
}
let streamingAiDiv: HTMLDivElement | null = null;

function setStatus(mode: string, text: string) {
  statusEl.className = mode;
  statusText.textContent = text;
  stopBtn.disabled = !busy;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function renderTrace(trace: any) {
  if (!trace) {
    traceEl.innerHTML = "<span>none yet</span>";
    ctxEl.innerHTML = "<span>none yet</span>";
    return;
  }
  const mems = (trace.retrievedMemories ?? []) as { memory: { type: string; content: string }; score: number }[];
  const kns = (trace.retrievedKnowledge ?? []) as { knowledge: { title: string }; score: number }[];
  ctxEl.innerHTML =
    (mems.length ? mems.map((m) => `<div>· [${esc(m.memory.type)}] ${esc(m.memory.content.slice(0, 160))}</div>`).join("") : "<span>no memories</span>") +
    (kns.length ? kns.map((k) => `<div>· 📚 ${esc(k.knowledge.title)}</div>`).join("") : "");
  const ev = trace.evaluation;
  traceEl.innerHTML =
    `<div>strategy <span class="k">${esc(String(trace.responseStrategy ?? ""))}</span></div>` +
    `<div>model <span class="k">${esc(String(trace.model ?? ""))}</span></div>` +
    (trace.matchedRule ? `<div>rule <span class="k">${esc(String(trace.matchedRule.ruleId))}</span></div>` : "") +
    (ev ? `<div>score <span class="k">${esc(String(ev.score))}</span> · hallucination <span class="k">${esc(String(ev.potentialHallucination))}</span></div><div>${esc(String(ev.notes ?? ""))}</div>` : "");
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setStatus(busy ? "busy" : "live", "connected · local only");
  ws.onclose = () => {
    setStatus("", "reconnecting…");
    setTimeout(connect, 2000);
  };
  ws.onerror = () => { try { ws?.close(); } catch { /* noop */ } };
  ws.onmessage = (ev) => {
    let m: any;
    try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case "ready":
        modelEl.textContent = String(m.displayName ?? m.model ?? "");
        backendEl.textContent =
          `model ${m.model ?? "?"}${m.ollama ? "" : " (offline — ELIZA rules)"} · ` +
          `models: ${(m.availableModels ?? []).join(", ") || "none"}`;
        if (!m.ollama) log("system", "Ollama unreachable — deterministic ELIZA rules are answering.", "sys");
        break;
      case "llm-token":
        if (!streamingAiDiv) {
          streamingAiDiv = log("eliza 🤖", "", "ai");
          setStatus("busy", "answering…");
        }
        streamingAiDiv.querySelector(".body")!.textContent += String(m.token);
        logEl.scrollTop = logEl.scrollHeight;
        break;
      case "llm-done": {
        const text = String(m.text ?? "");
        if (m.isCommand) {
          if (streamingAiDiv) streamingAiDiv.remove();
          log("command", text, "sys");
        } else if (streamingAiDiv) {
          if (!(streamingAiDiv.querySelector(".body")!.textContent || "").trim())
            streamingAiDiv.querySelector(".body")!.textContent = text;
        } else {
          log("eliza 🤖", text, "ai");
        }
        streamingAiDiv = null;
        renderTrace(m.trace);
        break;
      }
      case "turn-end":
        busy = false;
        setStatus("live", "listening…");
        streamingAiDiv = null;
        break;
      case "interrupted":
        busy = false;
        if (streamingAiDiv) {
          streamingAiDiv.querySelector(".body")!.textContent += " ⏹";
          streamingAiDiv = null;
        }
        setStatus("live", "interrupted — listening…");
        break;
      case "error":
        busy = false;
        log("system", String(m.message), "sys");
        streamingAiDiv = null;
        setStatus("live", "listening…");
        break;
    }
  };
}

async function sendRest(text: string) {
  // Fallback path when the socket is down: plain request/response.
  log("you", text, "user");
  busy = true;
  setStatus("busy", "answering…");
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const j = (await res.json()) as any;
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    log(text.startsWith("/") ? "command" : "eliza 🤖", String(j.reply ?? ""), text.startsWith("/") ? "sys" : "ai");
    renderTrace(j.trace);
  } catch (e: any) {
    log("system", `send failed: ${e?.message ?? e}`, "sys");
  } finally {
    busy = false;
    setStatus("live", "listening…");
  }
}

function sendCurrent(cmd?: string) {
  const t = (cmd ?? textIn.value).trim();
  if (!t) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    log(t.startsWith("/") ? "command" : "you", t, t.startsWith("/") ? "sys" : "user");
    if (!cmd) textIn.value = "";
    streamingAiDiv = null;
    busy = true;
    setStatus("busy", "answering… (⏹ to stop)");
    ws.send(JSON.stringify({ type: "text", text: t }));
  } else {
    if (!cmd) textIn.value = "";
    void sendRest(t);
  }
}

sendBtn.onclick = () => sendCurrent();
textIn.onkeydown = (e) => { if (e.key === "Enter") sendCurrent(); };
stopBtn.onclick = () => {
  ws?.send(JSON.stringify({ type: "stop" }));
  busy = false;
  if (streamingAiDiv) {
    streamingAiDiv.querySelector(".body")!.textContent += " ⏹";
    streamingAiDiv = null;
  }
  setStatus("live", "interrupted — listening…");
};
document.querySelectorAll<HTMLButtonElement>("#cmds button").forEach((b) => {
  b.onclick = () => sendCurrent(b.dataset.cmd ?? "");
});

connect();
log("eliza 🤖", "Hey — I'm ELIZA-AI in the browser. Type below, or try /help, /stats, /trace.", "ai");
