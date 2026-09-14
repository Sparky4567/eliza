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

// ---------------------------------------------------------------------------
// Model panel: inspect the active Ollama model, pick from available models
// (persisted as the last-picked selection), refresh the list, or clear the
// saved pick to fall back to auto-detect / rules mode.
// ---------------------------------------------------------------------------
const modelPanelEl = $("modelPanel");

function modelMsg(text: string, cls = "") {
  const el = $("modelMsg") as HTMLElement | null;
  if (!el) return;
  el.textContent = text;
  el.className = `ch-msg ${cls}`;
}

async function refreshModelPanel() {
  try {
    const res = await fetch("/api/model");
    const h = (await res.json()) as any;
    const active = String(h.model ?? "rules");
    const saved = h.savedModel ? String(h.savedModel) : "";
    const available = (h.availableModels ?? []) as string[];
    const options = Array.from(new Set([...(available as string[]), ...(saved && !available.includes(saved) ? [saved] : [])]));
    modelPanelEl.innerHTML =
      `<div class="ch-sub">active: <code>${esc(active)}</code>${saved ? ` · saved: <code>${esc(saved)}</code>` : " · no saved pick"}${h.ollama ? "" : " · <span title='Ollama unreachable'>offline</span>"}</div>` +
      (options.length
        ? `<select id="modelPick">${options.map((m) => `<option value="${esc(m)}"${m === active || (!available.includes(active) && m === saved) ? " selected" : ""}>${esc(m)}</option>`).join("")}</select>`
        : `<input type="text" id="modelPickText" placeholder="model name (e.g. llama3.2)" autocomplete="off" />`) +
      `<input type="text" id="modelCustom" placeholder="or type a model name…" autocomplete="off" />` +
      `<div class="ch-actions"><button id="modelSave">Save & use</button><button id="modelRefresh">Refresh</button><button id="modelClear"${saved ? "" : " disabled"}>Forget saved</button></div>` +
      `<div class="ch-msg" id="modelMsg"></div>`;
    const readPick = () => {
      const custom = (($("modelCustom") as HTMLInputElement | null)?.value || "").trim();
      if (custom) return custom;
      const sel = $("modelPick") as HTMLSelectElement | null;
      if (sel) return (sel.value || "").trim();
      const txt = $("modelPickText") as HTMLInputElement | null;
      return (txt?.value || "").trim();
    };
    ($("modelSave") as HTMLButtonElement).onclick = async () => {
      const name = readPick();
      if (!name) {
        modelMsg("type or pick a model name first", "err");
        return;
      }
      modelMsg("saving…");
      try {
        const r = await fetch("/api/model", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const j = (await r.json()) as any;
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        modelMsg(`saved ✓ active: ${j.model ?? name}`, "ok");
        modelEl.textContent = String(j.displayName ?? j.model ?? name);
        void refreshModelPanel();
      } catch (e: any) {
        modelMsg(`save failed: ${e?.message ?? e}`, "err");
      }
    };
    ($("modelRefresh") as HTMLButtonElement).onclick = () => {
      void refreshModelPanel();
    };
    ($("modelClear") as HTMLButtonElement | null)?.addEventListener("click", async () => {
      modelMsg("forgetting saved pick…");
      try {
        const r = await fetch("/api/model", { method: "DELETE" });
        const j = (await r.json()) as any;
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        modelMsg("saved pick forgotten — will auto-detect on next restart", "ok");
        modelEl.textContent = String(j.displayName ?? j.model ?? "");
        void refreshModelPanel();
      } catch (e: any) {
        modelMsg(`clear failed: ${e?.message ?? e}`, "err");
      }
    });
  } catch {
    modelPanelEl.innerHTML = "<span style='color:var(--dim)'>model info unavailable</span>";
  }
}

void refreshModelPanel();

// ---------------------------------------------------------------------------
// Channels panel: Telegram + WhatsApp status, runtime connect, QR pairing,
// and outbound test messages. Same bot + memory as the chat beside it.
// ---------------------------------------------------------------------------
const channelsEl = $("channels");

function chMsg(el: HTMLElement | null, text: string, cls = "") {
  if (!el) return;
  el.textContent = text;
  el.className = `ch-msg ${cls}`;
}

function renderChannelsSkeleton(c: any) {
  const tg = c?.telegram ?? {};
  const wa = c?.whatsapp ?? {};
  const preview = tg.preview ? ` (saved <code>${esc(String(tg.preview))}</code>${tg.persisted ? " · stored" : ""})` : "";
  const tgLine = tg.running
    ? `✅ running${tg.username ? ` (@${esc(tg.username)})` : ""} · polling Telegram${preview}`
    : tg.configured
      ? `⚙️ token saved${preview} · not running — reconnect below or forget it`
      : `⚪ not configured — paste a bot token to connect (it will be saved)`;
  const waLine = wa.running
    ? `✅ bridge listening on <code>:${esc(String(wa.port ?? ""))}</code>`
    : `⚪ not running (launch with <code>--whatsapp</code> or <code>WHATSAPP_ENABLED=true</code>)`;
  channelsEl.innerHTML =
    `<div class="ch-block"><div class="ch-title">✈️ Telegram</div>` +
    `<div class="ch-sub">${tgLine}</div>` +
    `<input type="password" id="chTgToken" placeholder="${tg.configured ? "New token (edit — leave empty to reuse saved)" : "Bot token (connect / reconnect)"}" autocomplete="off" />` +
    `<div class="ch-actions"><button id="chTgStart">${tg.configured ? "Save & Connect" : "Connect"}</button>` +
    `<button id="chTgStop"${tg.running ? "" : " disabled"}>Disconnect</button>` +
    `<button id="chTgForget"${tg.configured ? "" : " disabled"}>Forget token</button></div>` +
    `<input type="text" id="chTgChat" placeholder="chat id (for test send)" autocomplete="off" />` +
    `<input type="text" id="chTgText" placeholder="message to send via Telegram" autocomplete="off" />` +
    `<div class="ch-actions"><button id="chTgSend"${tg.running ? "" : " disabled"}>Send via Telegram</button></div>` +
    `<div class="ch-msg" id="chTgMsg"></div></div>` +
    `<div class="ch-block"><div class="ch-title">📱 WhatsApp</div>` +
    `<div class="ch-sub">${waLine}</div>` +
    `<div class="ch-sub" id="chWaStatus">checking bridge…</div>` +
    `<img class="qr" id="chWaQr" style="display:none" alt="WhatsApp pairing QR — scan with your phone camera" />` +
    `<input type="text" id="chWaTo" placeholder="recipient JID (e.g. 12345@s.whatsapp.net)" autocomplete="off" />` +
    `<input type="text" id="chWaText" placeholder="message to send via WhatsApp" autocomplete="off" />` +
    `<div class="ch-actions"><button id="chWaSend"${wa.running ? "" : " disabled"}>Send via WhatsApp</button>` +
    `<button id="chWaReset">Reset auth</button> <button id="chWaRefresh">Refresh</button></div>` +
    `<div class="ch-msg" id="chWaMsg"></div></div>`;

  ($("chTgStart") as HTMLButtonElement).onclick = async () => {
    const token = (($("chTgToken") as HTMLInputElement).value || "").trim();
    const m = $("chTgMsg");
    if (!token && !tg.configured) {
      chMsg(m, "paste a bot token first", "err");
      return;
    }
    chMsg(m, token ? "saving & connecting…" : "connecting with saved token…");
    try {
      const res = await fetch("/api/channels/telegram/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const j = (await res.json()) as any;
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      chMsg(m, `connected${j.username ? ` (@${j.username})` : ""} ✓ token saved`, "ok");
      ($("chTgToken") as HTMLInputElement).value = "";
      void refreshChannelsSummary();
    } catch (e: any) {
      chMsg(m, `connect failed: ${e?.message ?? e}`, "err");
    }
  };
  ($("chTgStop") as HTMLButtonElement).onclick = async () => {
    const m = $("chTgMsg");
    chMsg(m, "disconnecting…");
    try {
      const res = await fetch("/api/channels/telegram/start", { method: "DELETE" });
      const j = (await res.json()) as any;
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      chMsg(m, "disconnected — saved token kept, reconnect anytime", "ok");
      void refreshChannelsSummary();
    } catch (e: any) {
      chMsg(m, `disconnect failed: ${e?.message ?? e}`, "err");
    }
  };
  ($("chTgForget") as HTMLButtonElement).onclick = async () => {
    const m = $("chTgMsg");
    chMsg(m, "forgetting token…");
    try {
      const res = await fetch("/api/channels/telegram/token", { method: "DELETE" });
      const j = (await res.json()) as any;
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      chMsg(m, "token forgotten ✓ (bridge stopped)", "ok");
      void refreshChannelsSummary();
    } catch (e: any) {
      chMsg(m, `forget failed: ${e?.message ?? e}`, "err");
    }
  };
  ($("chTgSend") as HTMLButtonElement).onclick = async () => {
    const chatId = (($("chTgChat") as HTMLInputElement).value || "").trim();
    const text = (($("chTgText") as HTMLInputElement).value || "").trim();
    void postChannelSend("/api/channels/telegram/send", { chat_id: chatId, text }, $("chTgMsg"));
  };
  ($("chWaSend") as HTMLButtonElement).onclick = async () => {
    const to = (($("chWaTo") as HTMLInputElement).value || "").trim();
    const text = (($("chWaText") as HTMLInputElement).value || "").trim();
    void postChannelSend("/api/channels/whatsapp/send", { to, text }, $("chWaMsg"));
  };
  ($("chWaReset") as HTMLButtonElement).onclick = async () => {
    const m = $("chWaMsg");
    chMsg(m, "resetting auth…");
    try {
      const res = await fetch("/api/channels/whatsapp/reset", { method: "POST" });
      const j = (await res.json()) as any;
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      chMsg(m, `${j.message ?? "auth reset"} — re-scan the QR to reconnect.`, "ok");
      void updateWaStatus();
    } catch (e: any) {
      chMsg(m, `reset failed: ${e?.message ?? e}`, "err");
    }
  };
  ($("chWaRefresh") as HTMLButtonElement).onclick = () => {
    void refreshChannelsSummary();
    void updateWaStatus();
  };
}

async function postChannelSend(url: string, payload: Record<string, string>, msgEl: HTMLElement | null) {
  chMsg(msgEl, "sending…");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = (await res.json()) as any;
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    chMsg(msgEl, "sent ✓", "ok");
  } catch (e: any) {
    chMsg(msgEl, `send failed: ${e?.message ?? e}`, "err");
  }
}

async function refreshChannelsSummary() {
  try {
    const res = await fetch("/api/channels");
    const c = (await res.json()) as any;
    renderChannelsSkeleton(c);
    void updateWaStatus();
  } catch {
    channelsEl.innerHTML = "<span style='color:var(--dim)'>channels unavailable</span>";
  }
}

async function updateWaStatus() {
  const st = $("chWaStatus") as HTMLElement | null;
  const qr = $("chWaQr") as HTMLImageElement | null;
  if (!st) return; // skeleton not rendered yet
  try {
    const res = await fetch("/api/channels/whatsapp/status");
    const j = (await res.json()) as any;
    if (!res.ok) {
      st.textContent = `bridge: ${j.error ?? "offline"}`;
      if (qr) qr.style.display = "none";
      return;
    }
    const b = j.bridge ?? {};
    const conn = String(b.connection ?? "unknown");
    const phone = b.phone ? ` · ${b.phone}` : "";
    const last = b.lastJid ? ` · last: ${b.lastJid}` : "";
    const err = b.lastError ? ` · ⚠️ ${b.lastError}` : "";
    st.textContent = `bridge: ${conn}${phone}${last}${err}`;
    if (qr) {
      if (b.qrImage && conn !== "open") {
        qr.src = String(b.qrImage);
        qr.style.display = "";
      } else {
        qr.style.display = "none";
      }
    }
  } catch {
    st.textContent = "bridge: status check failed";
    if (qr) qr.style.display = "none";
  }
}

void refreshChannelsSummary();
setInterval(() => { void updateWaStatus(); }, 5000);

connect();
log("eliza 🤖", "Hey — I'm ELIZA-AI in the browser. Type below, or try `/help`, `/stats`, `/trace`.", "ai", { markdown: true });
