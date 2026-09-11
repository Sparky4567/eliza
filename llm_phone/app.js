/* -------------------------------------------------
   Configuration – point to your remote Ollama server
   ------------------------------------------------- */
const OLLAMA_URL = "http://localhost:11434/api/generate";

/* -------------------------------------------------
   UI helpers
   ------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const output = $("output");
function append(txt) {
  output.textContent += txt;
  output.scrollTop = output.scrollHeight;
}

/* -------------------------------------------------
   Streaming request to Ollama
   ------------------------------------------------- */
async function streamPrompt(prompt) {
  const payload = {
    model: "gpt-oss:120b-cloud",          // change to your model name
    prompt,
    stream: true,
    temperature: 0.7,
    max_tokens: 1024,
  };

  const resp = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    // Ollama streams newline‑delimited JSON objects
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const txt = data.response ?? "";
        append(txt);
        // Optional: speak as we receive
        speak(txt);
      } catch (_) {
        // ignore malformed lines
      }
    }
  }
}

/* -------------------------------------------------
   Speech synthesis (TTS)
   ------------------------------------------------- */
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  const utter = new SpeechSynthesisUtterance(text);
  // You can pick a voice, rate, pitch here if you like
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
  const txt = $("prompt").value.trim();
  if (!txt) return;
  output.textContent = ""; // clear previous output
  streamPrompt(txt).catch((e) => append(`\n❌ ${e.message}`));
}

$("sendBtn").addEventListener("click", sendPrompt);
$("voiceBtn").addEventListener("click", () => {
  if (!recognizer) return alert("Speech recognition not supported on this browser.");
  recognizer.start();
});
$("camBtn").addEventListener("click", capturePhoto);
