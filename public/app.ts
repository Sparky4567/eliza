// ELIZA-AI web frontend: WS streaming chat (primary) + REST fallback.
// Mirrors zap's public/app.ts structure, text-only (no mic/TTS).
// AI replies are rendered as markdown (see ./markdown.ts); user / system /
// command output stays plain text.
import { renderMarkdown } from "./markdown.ts";
const $ = (id: string) => document.getElementById(id)!;
const logEl = $("log"), statusEl = $("status"), statusText = $("statusText"),
  modelEl = $("model"), backendEl = $("backend"),
  ctxEl = $("ctx"), traceEl = $("trace"),
  textIn = $("textIn") as HTMLTextAreaElement,
  sendBtn = $("sendBtn") as HTMLButtonElement,
  stopBtn = $("stopBtn") as HTMLButtonElement,
  focusBtn = $("focusBtn") as HTMLButtonElement;

let ws: WebSocket | null = null;
let busy = false;

function renderAiBody(body: HTMLElement, raw: string) {
  body.dataset.raw = raw;
  body.innerHTML = renderMarkdown(raw);
  body.classList.add("md");
  body.title = "Rendered markdown — double-click to view source";
}

function showRawBody(body: HTMLElement) {
  body.textContent = body.dataset.raw ?? body.textContent ?? "";
  body.classList.remove("md");
  body.title = "Plain source — double-click to render markdown";
}

function log(who: string, text: string, cls = "", opts: { markdown?: boolean } = {}) {
  const d = document.createElement("div");
  d.className = `msg ${cls}`;
  d.innerHTML = `<div class="who"></div><div class="body"></div>`;
  d.querySelector(".who")!.textContent = who;
  const body = d.querySelector(".body") as HTMLElement;
  if (opts.markdown) {
    renderAiBody(body, text);
    body.addEventListener("dblclick", () => {
      if (body.classList.contains("md")) showRawBody(body);
      else renderAiBody(body, body.dataset.raw ?? text);
    });
  } else {
    body.textContent = text;
  }
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
  return d;
}

// Copy-to-clipboard for rendered code blocks (event delegation: buttons are
// re-created on every markdown render).
logEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest?.("[data-code-copy]");
  if (!btn) return;
  const block = (btn as HTMLElement).closest(".codeblock");
  const code = block?.querySelector("pre code")?.textContent ?? "";
  if (!code) return;
  const done = () => {
    const b = btn as HTMLButtonElement;
    const prev = b.textContent;
    b.textContent = "copied ✓";
    setTimeout(() => { b.textContent = prev; }, 1200);
  };
  try {
    const p = navigator.clipboard?.writeText(code);
    if (p && typeof (p as Promise<void>).then === "function") {
      (p as Promise<void>).then(done, () => fallbackCopy(code, done));
    } else {
      fallbackCopy(code, done);
    }
  } catch {
    fallbackCopy(code, done);
  }
});

function fallbackCopy(text: string, done: () => void) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    done();
  } catch { /* clipboard unavailable */ }
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
      case "llm-token": {
        if (!streamingAiDiv) {
          // Plain-text live view during streaming; markdown is rendered once
          // the full reply arrives (avoids flicker on partial fences).
          streamingAiDiv = log("eliza 🤖", "", "ai");
          (streamingAiDiv.querySelector(".body") as HTMLElement).dataset.raw = "";
          setStatus("busy", "answering…");
        }
        const body = streamingAiDiv.querySelector(".body") as HTMLElement;
        const raw = (body.dataset.raw ?? body.textContent ?? "") + String(m.token);
        body.dataset.raw = raw;
        body.classList.remove("md");
        body.textContent = raw;
        logEl.scrollTop = logEl.scrollHeight;
        break;
      }
      case "llm-done": {
        const text = String(m.text ?? "");
        if (m.isCommand) {
          if (streamingAiDiv) streamingAiDiv.remove();
          log("command", text, "sys");
        } else if (streamingAiDiv) {
          const body = streamingAiDiv.querySelector(".body") as HTMLElement;
          const raw = (body.dataset.raw ?? "").trim() ? body.dataset.raw! : text;
          renderAiBody(body, raw);
          logEl.scrollTop = logEl.scrollHeight;
        } else {
          log("eliza 🤖", text, "ai", { markdown: true });
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
    const isCmd = text.startsWith("/");
    log(isCmd ? "command" : "eliza 🤖", String(j.reply ?? ""), isCmd ? "sys" : "ai",
      isCmd ? {} : { markdown: true });
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
textIn.onkeydown = (e) => {
  // Enter sends; Shift+Enter inserts a newline (multi-line stories/notes).
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCurrent();
  }
};
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

// Distraction-free mode: hide the side panel, stretch the chat to the viewport.
// Preference persists across reloads; Esc exits (unless typing in the composer).
const FOCUS_KEY = "eliza-focus";
function setFocus(on: boolean) {
  document.body.classList.toggle("focus", on);
  focusBtn.setAttribute("aria-pressed", String(on));
  focusBtn.textContent = on ? "⛶ Exit focus" : "⛶ Focus";
  try {
    localStorage.setItem(FOCUS_KEY, on ? "1" : "0");
  } catch { /* private mode etc. */ }
  logEl.scrollTop = logEl.scrollHeight;
}
focusBtn.onclick = () => setFocus(!document.body.classList.contains("focus"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("focus") && document.activeElement !== textIn) {
    setFocus(false);
  }
});
try {
  if (localStorage.getItem(FOCUS_KEY) === "1") setFocus(true);
} catch { /* private mode etc. */ }

connect();
log("eliza 🤖", "Hey — I'm ELIZA-AI in the browser. Type below, or try `/help`, `/stats`, `/trace`.", "ai", { markdown: true });
