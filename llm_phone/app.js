/* -------------------------------------------------
   Settings – remote host + model, persisted locally
   ------------------------------------------------- */
const STORAGE_KEY = "llm-companion-settings-v1";
const DEFAULTS = {
  host: "http://localhost:11434",
  model: "gpt-oss:120b-cloud",
  speak: false,
};

function normalizeHost(raw) {
  return (raw || "").trim().replace(/\/+$/, "");
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettingsToStorage(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

let settings = loadSettings();

const apiUrl = (path) => `${normalizeHost(settings.host)}${path}`;

/* -------------------------------------------------
   UI helpers
   ------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const output = $("output");
const sendBtn = $("sendBtn");
const stopBtn = $("stopBtn");
let aborter = null;
let streaming = false;
let rawText = "";
let renderMode = "rendered"; // "rendered" | "raw"

/* -------------------------------------------------
   Markdown renderer (zero-dependency, XSS-safe)
   Supports: headings, bold/italic/strike, code blocks,
   inline code, links, images, blockquotes, hr,
   unordered/ordered/task lists, tables, paragraphs.
   ------------------------------------------------- */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function sanitizeUrl(url) {
  try {
    const u = new URL(url, window.location.href);
    if (["http:", "https:", "mailto:"].includes(u.protocol)) return url;
    return null;
  } catch {
    return null;
  }
}

function renderMarkdown(src) {
  if (!src) return "";
  let text = src.replace(/\r\n?/g, "\n");

  // Auto-close an unclosed fenced block while streaming
  const fences = (text.match(/```/g) || []).length;
  if (fences % 2 === 1) text += "\n```";

  // 1. Extract fenced code blocks → placeholders
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)(```|$)/g, (_, lang, code) => {
    codeBlocks.push({ lang: (lang || "").trim(), code: code.replace(/\n$/, "") });
    return `\n\x00CODE${codeBlocks.length - 1}\x00\n`;
  });

  // 2. Escape everything else
  text = escapeHtml(text);

  // 3. Extract inline code → placeholders (content already escaped)
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+?)`/g, (_, code) => {
    inlineCodes.push(code);
    return `\x01INLINE${inlineCodes.length - 1}\x01`;
  });

  const inline = (t) => {
    // Images ![alt](url)
    t = t.replace(/!\[([^\]]*?)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_, alt, url) => {
      const safe = sanitizeUrl(url);
      return safe ? `<img src="${safe}" alt="${alt}">` : alt;
    });
    // Links [text](url)
    t = t.replace(/\[([^\]]+?)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
      const safe = sanitizeUrl(url);
      return safe ? `<a href="${safe}">${label}</a>` : label;
    });
    // Autolinks
    t = t.replace(/(https?:\/\/[^\s<\x00\x01]+[^\s<.,;:!?)\]])/g, (url) =>
      `<a href="${url}">${url}</a>`);
    // Bold **x** and __x__
    t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/__(.+?)__/g, "<strong>$1</strong>");
    // Strikethrough
    t = t.replace(/~~(.+?)~~/g, "<del>$1</del>");
    // Italic *x* and _x_ (after bold so ** doesn't clash)
    t = t.replace(/\*(.+?)\*/g, "<em>$1</em>");
    t = t.replace(/(^|\W)_([^_\n]+?)_(\W|$)/g, "$1<em>$2</em>$3");
    // Restore inline code
    t = t.replace(/\x01INLINE(\d+)\x01/g, (_, i) => `<code>${inlineCodes[+i]}</code>`);
    return t;
  };

  const isCodePh = (line) => /^\x00CODE\d+\x00$/.test(line.trim());
  const codePhHtml = (line) => {
    const i = +line.trim().replace(/^\x00CODE(\d+)\x00$/, "$1");
    const b = codeBlocks[i];
    const cls = b.lang ? ` class="language-${escapeHtml(b.lang)}"` : "";
    return `<pre><code${cls}>${escapeHtml(b.code)}</code></pre>`;
  };

  const lines = text.split("\n");
  let html = "";
  let para = [];
  let listStack = []; // {type: "ul"|"ol", indent: number}

  const flushPara = () => {
    if (!para.length) return;
    html += `<p>${para.map(inline).join("<br>")}</p>`;
    para = [];
  };
  const closeListsTo = (indent = -1) => {
    while (listStack.length && listStack[listStack.length - 1].indent >= indent) {
      const l = listStack.pop();
      html += l.type === "ul" ? "</ul>" : "</ol>";
    }
  };
  const isTableSep = (line) => /^\s*\|?[\s:|-]+\|?[\s:|-]*$/.test(line) && line.includes("-");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { flushPara(); i++; continue; }
    if (isCodePh(line)) { flushPara(); closeListsTo(0); html += codePhHtml(line); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) { flushPara(); closeListsTo(0); html += "<hr>"; i++; continue; }
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); closeListsTo(0); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
    const q = line.match(/^\s*(?:>|\&gt;)\s?(.*)$/);
    if (q) {
      flushPara(); closeListsTo(0);
      const quotes = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*(?:>|\&gt;)\s?(.*)$/);
        if (!m) break;
        quotes.push(inline(m[1] || ""));
        i++;
      }
      html += `<blockquote>${quotes.join("<br>")}</blockquote>`;
      continue;
    }
    // Tables: header row + separator row + body rows
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara(); closeListsTo(0);
      const splitRow = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = splitRow(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        body.push(splitRow(lines[i]));
        i++;
      }
      html += "<div class=\"table-wrap\"><table><thead><tr>" +
        head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" +
        body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
        "</tbody></table></div>";
      continue;
    }
    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const ol = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const indent = (ul ? ul[1] : ol[1]).length;
      const type = ul ? "ul" : "ol";
      let content = ul ? ul[2] : ol[3];
      // Task list: - [ ] / - [x]
      let taskCls = "";
      const task = content.match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) {
        taskCls = task[1] === " " ? " class=\"task todo\"" : " class=\"task done\"";
        content = `${task[1] === " " ? "☐ " : "☑ "}${task[2]}`;
      }
      if (!listStack.length || indent > listStack[listStack.length - 1].indent) {
        html += type === "ul" ? "<ul>" : "<ol>";
        listStack.push({ type, indent });
      } else {
        closeListsTo(indent + 1);
        const top = listStack[listStack.length - 1];
        if (!top || top.indent < indent) {
          html += type === "ul" ? "<ul>" : "<ol>";
          listStack.push({ type, indent });
        } else if (top && top.type !== type) {
          listStack.pop();
          html += top.type === "ul" ? "</ul>" : "</ol>";
          html += type === "ul" ? "<ul>" : "<ol>";
          listStack.push({ type, indent });
        }
      }
      html += `<li${taskCls}>${inline(content)}</li>`;
      i++;
      // Close lists when next line is not a list item
      const next = lines[i];
      if (i >= lines.length || (!next?.match(/^\s*[-*+]\s+/) && !next?.match(/^\s*\d+[.)]\s+/) && next?.trim())) {
        // keep open only across blank/list lines; paragraph text closes
        if (next !== undefined && next.trim() && !isCodePh(next)) { closeListsTo(0); }
      }
      continue;
    }
    closeListsTo(0);
    para.push(line);
    i++;
  }
  flushPara();
  closeListsTo(0);
  return html;
}

function setStatus(state, text) {
  const dot = $("statusDot");
  const label = $("statusText");
  dot.className = `status-dot ${state || ""}`.trim();
  if (label && text) label.textContent = text;
}

function settingsMsg(text, kind) {
  const el = $("settingsMsg");
  el.textContent = text;
  el.className = `settings-msg ${kind || ""}`.trim();
}

function clearOutput(placeholder = "Your answer will stream here…") {
  rawText = "";
  output.innerHTML = "";
  const span = document.createElement("span");
  span.className = "placeholder";
  span.textContent = placeholder;
  output.appendChild(span);
}

function renderOutput() {
  const ph = output.querySelector(".placeholder");
  if (ph && !rawText) return;
  if (ph) ph.remove();
  if (renderMode === "raw") {
    output.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "raw-view";
    pre.textContent = rawText;
    output.appendChild(pre);
  } else {
    output.innerHTML = renderMarkdown(rawText);
    // Make links safe + open externally
    output.querySelectorAll("a").forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
  }
  output.scrollTop = output.scrollHeight;
}

function append(txt) {
  rawText += txt;
  renderOutput();
}

function showError(msg) {
  rawText += `\n\n❌ ${msg}`;
  renderOutput();
}

function setStreaming(on) {
  streaming = on;
  sendBtn.disabled = on;
  stopBtn.disabled = !on;
  setStatus(on ? "busy" : "", on ? "Generating…" : $("statusText").textContent);
}

/* -------------------------------------------------
   Settings panel wiring
   ------------------------------------------------- */
function syncSettingsForm() {
  $("hostInput").value = settings.host;
  $("modelInput").value = settings.model;
  $("speakToggle").checked = !!settings.speak;
}

function readSettingsForm() {
  const host = normalizeHost($("hostInput").value) || DEFAULTS.host;
  const model = $("modelInput").value.trim() || DEFAULTS.model;
  return { host, model, speak: $("speakToggle").checked };
}

function refreshStatusLabel() {
  setStatus("", `${settings.model} @ ${settings.host}`);
}

$("settingsToggle").addEventListener("click", () => {
  const panel = $("settingsPanel");
  const open = panel.hidden;
  panel.hidden = !open;
  $("settingsToggle").setAttribute("aria-expanded", String(open));
  if (open) {
    syncSettingsForm();
    settingsMsg("");
  }
});

$("saveSettingsBtn").addEventListener("click", () => {
  const next = readSettingsForm();
  try {
    // Basic validation: must look like http(s)://…
    new URL(next.host);
  } catch {
    settingsMsg("Invalid host URL. Example: http://192.168.1.10:11434", "err");
    return;
  }
  if (!next.model) {
    settingsMsg("Please enter a model name.", "err");
    return;
  }
  settings = next;
  saveSettingsToStorage(settings);
  refreshStatusLabel();
  settingsMsg("Settings saved ✓", "ok");
});

$("resetSettingsBtn").addEventListener("click", () => {
  settings = { ...DEFAULTS };
  saveSettingsToStorage(settings);
  syncSettingsForm();
  refreshStatusLabel();
  settingsMsg("Reset to defaults.", "ok");
});

$("testConnectionBtn").addEventListener("click", async () => {
  const probe = normalizeHost($("hostInput").value) || settings.host;
  settingsMsg("Testing…");
  setStatus("busy", "Testing connection…");
  try {
    const resp = await fetch(`${probe}/api/tags`, { method: "GET" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await resp.json(); // validate JSON
    setStatus("ok", `${settings.model} @ ${probe} — reachable`);
    settingsMsg("Connection OK ✓ host reachable.", "ok");
  } catch (e) {
    setStatus("bad", "Connection failed");
    settingsMsg(`Connection failed: ${e.message}. Check host + CORS.`, "err");
  }
});

$("refreshModelsBtn").addEventListener("click", async () => {
  const probe = normalizeHost($("hostInput").value) || settings.host;
  const list = $("modelList");
  settingsMsg("Fetching models…");
  try {
    const resp = await fetch(`${probe}/api/tags`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const models = (data.models || []).map((m) => m.name).filter(Boolean);
    list.innerHTML = "";
    for (const name of models) {
      const opt = document.createElement("option");
      opt.value = name;
      list.appendChild(opt);
    }
    settingsMsg(models.length ? `Found ${models.length} model(s). Pick one, then Save.` : "No models found on host.", models.length ? "ok" : "err");
  } catch (e) {
    settingsMsg(`Could not list models: ${e.message}`, "err");
  }
});

$("speakToggle").addEventListener("change", (e) => {
  settings.speak = e.target.checked;
  saveSettingsToStorage(settings);
});

/* -------------------------------------------------
   Streaming request to Ollama
   ------------------------------------------------- */
async function streamPrompt(prompt) {
  const payload = {
    model: settings.model,
    prompt,
    stream: true,
    temperature: 0.7,
    max_tokens: 1024,
  };

  aborter = new AbortController();
  const resp = await fetch(apiUrl("/api/generate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: aborter.signal,
  });

  if (!resp.ok) {
    let detail = "";
    try { detail = `: ${await resp.text()}`; } catch { /* ignore */ }
    throw new Error(`HTTP ${resp.status}${detail.slice(0, 200)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    // Ollama streams newline‑delimited JSON objects
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const txt = data.response ?? "";
        if (txt) {
          fullText += txt;
          append(txt);
        }
        if (data.done) {
          if (fullText && settings.speak) speak(fullText);
          return;
        }
      } catch (_) {
        // ignore malformed lines
      }
    }
  }
  if (fullText && settings.speak) speak(fullText);
}

/* -------------------------------------------------
   Speech synthesis (TTS) – speak once per reply
   ------------------------------------------------- */
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // avoid token-by-token queue pile-up
  const utter = new SpeechSynthesisUtterance(text);
  window.speechSynthesis.speak(utter);
}

/* -------------------------------------------------
   Speech recognition (STT)
   ------------------------------------------------- */
let recognizer;
if ("SpeechRecognition" in window || "webkitSpeechRecognition" in window) {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognizer = new SpeechRec();
  recognizer.continuous = false;
  recognizer.interimResults = false;
  recognizer.lang = "en-US";

  recognizer.onresult = (e) => {
    const spoken = e.results[0][0].transcript;
    $("prompt").value = spoken;
    sendPrompt();
  };
  recognizer.onerror = (e) => console.warn("STT error:", e);
}

/* -------------------------------------------------
   Camera capture → base64 → optional vision step
   ------------------------------------------------- */
async function capturePhoto() {
  // Use the native file picker (works on most mobile browsers)
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*;capture=camera";
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const dataURL = await readFileAsDataURL(file);
    // For a pure‑text LLM you can just embed the image caption:
    const caption = await getImageCaption(dataURL);
    $("prompt").value = `Picture description: ${caption}\nWhat should I do?`;
  };
  input.click();
}

/* Helper to read file → base64 */
function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/* -------------------------------------------------
   Optional: send image to a server‑side vision model.
   (Replace with your own endpoint if you have one.)
   ------------------------------------------------- */
async function getImageCaption(dataURL) {
  // Example: a tiny Flask endpoint that returns a short caption.
  // If you have no vision server, just return a placeholder.
  try {
    const resp = await fetch("https://YOUR_VISION_ENDPOINT/caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataURL }),
    });
    const { caption } = await resp.json();
    return caption;
  } catch (_) {
    return "an unknown scene";
  }
}

/* -------------------------------------------------
   UI event wiring
   ------------------------------------------------- */
function sendPrompt() {
  if (streaming) return;
  const txt = $("prompt").value.trim();
  if (!txt) return;
  window.speechSynthesis?.cancel();
  clearOutput("Thinking…");
  setStreaming(true);
  setStatus("busy", "Generating…");
  streamPrompt(txt)
    .catch((e) => {
      if (e.name === "AbortError") showError("Stopped.");
      else showError(e.message || "Request failed");
    })
    .finally(() => {
      setStreaming(false);
      refreshStatusLabel();
    });
}

function setView(mode) {
  renderMode = mode;
  const r = $("viewRenderedBtn"), w = $("viewRawBtn");
  const isRendered = mode === "rendered";
  r.classList.toggle("active", isRendered);
  w.classList.toggle("active", !isRendered);
  r.setAttribute("aria-selected", String(isRendered));
  w.setAttribute("aria-selected", String(!isRendered));
  renderOutput();
}

$("viewRenderedBtn").addEventListener("click", () => setView("rendered"));
$("viewRawBtn").addEventListener("click", () => setView("raw"));
$("copyBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(rawText || "");
    const btn = $("copyBtn");
    const prev = btn.textContent;
    btn.textContent = "✓ Copied";
    setTimeout(() => { btn.textContent = prev; }, 1200);
  } catch {
    alert("Copy failed — select the text manually.");
  }
});

sendBtn.addEventListener("click", sendPrompt);
stopBtn.addEventListener("click", () => aborter?.abort());
$("clearBtn").addEventListener("click", () => {
  $("prompt").value = "";
  aborter?.abort();
  window.speechSynthesis?.cancel();
  clearOutput();
});
$("prompt").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") sendPrompt();
});
$("voiceBtn").addEventListener("click", () => {
  if (!recognizer) return alert("Speech recognition not supported on this browser.");
  recognizer.start();
});
$("camBtn").addEventListener("click", capturePhoto);

/* Init */
syncSettingsForm();
clearOutput();
refreshStatusLabel();
