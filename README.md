# ELIZA-AI: Incrementally Learning LLM Bot in Bun (CLI + Web + Telegram + WhatsApp)

A modular, incrementally learning conversational AI built with **Bun** and **TypeScript**. It combines the predictable, reflective empathy of classic ELIZA with a persistent cognitive layer, long-term memory, versioned knowledge base, and local LLM integration via **Ollama** (with real-time streaming). Talk to it in the terminal (`bun start`), in the browser (`bun run web`), or from your phone via **Telegram** and **WhatsApp** — every channel shares the same bot, memory, and learning pipeline, with isolated per-chat sessions.

---

## 🌟 Key Features

- **Automatic Model Discovery**: Queries Ollama's API on startup, listing local models and defaulting automatically to the first available model.
- **Model Representation**: Clearly identifies the active engine with `(ELIZA:model_name)` in the CLI prompt and diagnostics (e.g. `(ELIZA:llama3.2)` or `(ELIZA:rules)` when offline).
- **Classic ELIZA Pattern Engine**: Deterministic pattern matching with wildcards (`*`), priority ranking, template interpolation (`{0}`, `{1}`), and single-pass pronoun reflection (`I` ⇄ `you`, `my` ⇄ `your`, `am` ⇄ `are`, `mine` ⇄ `yours`, `myself` ⇄ `yourself`).
- **Real-Time Ollama Token Streaming**: Connects directly to local Ollama instances (`/api/chat`), streaming tokens dynamically to standard output as they generate.
- **Graceful Offline Fallback**: If Ollama is offline or unavailable, seamlessly falls back to the deterministic ELIZA rule engine and reflective responses without crashing.
- **Persistent SQLite Storage**: Built natively on `bun:sqlite` with WAL mode for high-performance storage of sessions, conversation turns, memories, knowledge, and learning events.
- **Long-Term Memory & Contradiction Resolution**: Classifies memories (facts, preferences, goals, projects, instructions, corrections). When beliefs or project parameters change, previous memories are linked as `superseded_by` rather than silently deleted.
- **Versioned Knowledge Base**: Records general concepts, definitions, and technical knowledge with full provenance chains (`version`, `previous_version_id`, `change_reason`).
- **Post-Turn Incremental Learning**: Automatically extracts durable facts, user preferences, and explicit corrections after every turn using a hybrid heuristic + LLM extraction pipeline.
- **Response Evaluation & Strategy Statistics**: Evaluates response quality (relevance, hallucination risk, memory utilization) and tracks success metrics across strategies (`ask_followup`, `explain_directly`, `eliza_rule`, `llm_contextual`).
- **Observability & Diagnostics**: Interactive inspection via `/trace`, `/model`, `/stats`, `/memory`, `/knowledge`, `/rules`, and `/approve`.
- **Web UI + API (`--web`)**: Browser chat with live token streaming over WebSocket, command buttons, and a context/trace side panel — plus a REST API (`/api/chat`, `/api/stats`, `/api/trace`, `/api/model`, …) with full CLI parity.
- **Telegram bridge (`--telegram`)**: Zero-dependency Bot API long-polling (`src/channels/telegram.ts`, ported from llama). Each Telegram chat gets an isolated session; `@cmd` works like `/cmd`; replies over 4000 chars are auto-split.
- **WhatsApp bridge (`--whatsapp`)**: Localhost HTTP bridge (`:8765/chat`) + Baileys socket process (`whatsapp_bridge/`, QR login on `:8766`, ported from llama). Each contact gets an isolated session.
- **Channels panel in the web UI**: Side-panel card showing Telegram/WhatsApp status, the WhatsApp pairing QR inline, runtime Telegram connect (paste a token, no restart), auth reset, and outbound test-message senders (`/api/channels*`).
- **Persistent settings (model + Telegram token)**: The last-picked Ollama model and the Telegram bot token are saved in the SQLite `settings` table, survive restarts, and can be edited or deleted from the web UI (Model panel + Channels panel), via the API, or via `/model` / `--telegram-token`.
- **Resilient LLM Layer**: Clear timeout errors (no more cryptic `The operation was aborted`), best-effort background learning that never breaks a reply, graceful ELIZA fallback, and a Ctrl+C-safe CLI loop.
- **Smart Writing / Smart Notes (Ollama-only)**: `/smart-writing start …` opens a co-writing session — type multi-sentence / multi-line drafts and the bot continues or improves them until the story is done, then `/smart-writing save` persists it as a `story` memory + `writing` knowledge entry with 🔗 `memory_links` associations to related memories/knowledge.

---

## 📐 System Architecture

```text
                ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
                │   Terminal User    │  │   Browser User     │  │ Telegram / WhatsApp│
                │   (bun start)      │  │   (bun run web)    │  │  (--telegram/--wa) │
                └─────────┬──────────┘  └─────────┬──────────┘  └─────────┬──────────┘
                           │                       ▼                       ▼
                           │              ┌────────────────────┐  ┌────────────────────┐
                           │              │  Web Server + WS   │  │ Channel Bridges    │ ◄── /api/channels* + QR
                           │              └─────────┬──────────┘  └─────────┬──────────┘
                           ▼                       ▼                       ▼
                          ┌────────────────────┐
                          │ Conversation Loop  │ ◄── Slash Commands (/trace, /stats, etc.)
                          └─────────┬──────────┘         ▲ isolated per-chat sessions
                                    │                   (telegram_<id>, whatsapp_<jid>)
                                    ▼
                         ┌────────────────────┐
                         │  Context Builder   │
                         └─────────┬──────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                │                  │                  │
                ▼                  ▼                  ▼
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │   Memories   │   │  Knowledge   │   │ ELIZA Rules  │
        │    Store     │   │     Base     │   │  / Matcher   │
        └──────────────┘   └──────────────┘   └──────────────┘
                │                  │                  │
                └──────────────────┼──────────────────┘
                                   ▼
                         ┌────────────────────┐
                         │     Local LLM      │ (Streaming HTTP)
                         │      Ollama        │
                         └─────────┬──────────┘
                                   │
                                   ▼
                         ┌────────────────────┐
                         │ Response Evaluator │
                         └─────────┬──────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
               Bot Response     New Memory     New Knowledge
           (Stream to CLI/Web) (Consolidation)  (Versioned)
```

---

## 🚀 Getting Started

### Prerequisites
- [Bun](https://bun.sh) (v1.0 or higher)
- *(Optional)* [Ollama](https://ollama.com) running locally for LLM-powered context generation.

### 1. Install Dependencies
```bash
bun install
```

### 2. (Optional) Start Ollama
Make sure Ollama is running and pull your preferred model:
```bash
# Pull model (e.g., gemma2, llama3.2, or qwen2.5)
ollama pull gemma2

# Start Ollama service (if not already running as a daemon)
ollama serve
```

### 3. Run the Bot
```bash
bun start
# or
bun run src/index.ts
```

### 3b. Run the Web UI (zap-style `--web` mode)
```bash
bun run web
# or
bun run src/index.ts --web --port 3000
```
Opens a browser chat UI at `http://localhost:3000` with live token streaming
over WebSocket, the same slash commands as the CLI (`/help`, `/stats`,
`/trace`, `/memory`, …, `/smart-writing …`), plus a context/trace side panel. REST + WS API below.
Port fallback: `--port` flag, else `ELIZA_WEB_PORT` / `WEB_PORT` / `PORT` env.
Composer: `Enter` sends, `Shift+Enter` inserts a newline (multi-line stories).

### 3c. Connect Telegram and/or WhatsApp (ported from llama)

```bash
# Telegram: set a BotFather token, then run (CLI or --web — bridges start in both modes)
TELEGRAM_TOKEN=<token> bun start
# or: bun run src/index.ts --web --telegram --telegram-token <token>

# WhatsApp: install the Baileys bridge deps once, then run
bun run whatsapp:install
bun run src/index.ts --web --whatsapp
# scan the QR printed in the terminal — or right in the web UI Channels panel
```

Notes:
- Telegram auto-starts whenever a token is present (`--telegram-token` flag → `TELEGRAM_TOKEN` / `TELEGRAM_BOT_TOKEN` env → `telegram.token` config); `--no-telegram` forces it off. WhatsApp starts on `--whatsapp` or `WHATSAPP_ENABLED=true`.
- Remote chats reuse the full CLI stack (ELIZA rules, memory/knowledge retrieval, Ollama, learning) with **isolated per-chat sessions** (`telegram_<chatId>`, `whatsapp_<jid>`) — the CLI session is untouched. `/clear` in a remote chat clears only that chat.
- Llama-style `@help` works like `/help` in remote chats. Voice notes get a polite text-mode notice (ELIZA has no STT/TTS pipeline).

### 4. Run the Test Suite
```bash
bun test
```

---

## 💡 Example Conversation Walkthrough

```text
=======================================================
       ELIZA-AI: Incrementally Learning CLI Bot        
=======================================================
Type your message or /help for commands, /quit to exit.

You: I am building a Bun CLI chatbot.
Bot: What kind of chatbot are you building?

You: A CLI bot inspired by ELIZA using SQLite.
Bot: That sounds like a great architecture. SQLite provides fast, persistent structured storage.

You: /stats
=== Bot Statistics ===
Sessions:           1
Messages:           4
Active Memories:    2
Superseded Memories:0
Active Knowledge:   0
Corrections:        0
Active ELIZA Rules: 21
Candidate Rules:    0

You: Actually, I changed it. I'm using PostgreSQL now.
Bot: Got it. I've updated my memory: the project database has changed from SQLite to PostgreSQL.

You: /trace
=== Response Trace ===
Input:             Actually, I changed it. I'm using PostgreSQL now.
Strategy:          llm_contextual
Model:             gemma2
Matched Rule:      None

Retrieved Memories (2):
  - [project] User is building a Bun CLI chatbot. (Score: 2.10, Conf: 0.95)
  - [correction] User updated: Actually, I changed it. I'm using PostgreSQL now. (Score: 3.45, Conf: 0.98)

Retrieved Knowledge (0):
  (none)

Evaluation:
  Score:           0.90
  Used Memory:     true
  Hallucination:   false
  Notes:           Response accurately acknowledged database update.

You: /memory
=== Recent Memories ===
[mem_17236501] (correction) (Conf: 0.98)
  User updated: Actually, I changed it. I'm using PostgreSQL now.
[mem_17236500] (project) [SUPERSEDED by mem_17236501] (Conf: 0.90)
  User is building a Bun CLI chatbot using SQLite.
```

---

## ✍️ Smart Writing (Ollama-only co-writing + smart notes)

Requires a local Ollama model (`ollama serve` + a pulled model, `OLLAMA_ENABLED=true`).
Without it, `/smart-writing start|continue|improve` explain that Ollama is needed;
drafting commands (`show`, `status`, `list`, `save`) keep working offline.

```text
You: /smart-writing start Mara kept the lighthouse burning through the storm.
Bot: ✍️ Smart-writing session started… Draft so far (8 words)…

You: She heard a knock at the iron door. The sea was angry and black.
Bot: <continuation streamed token-by-token, then appended to the draft>

You: /smart-writing improve make it more atmospheric
Bot: <polished rewrite of the full draft>

You: /smart-writing save The Lighthouse
Bot: 💾 Saved story "The Lighthouse" as [mem_…] (…words).
     Knowledge: [kn_…] "Story: The Lighthouse" (v1)
     🔗 Formed 2 new association(s):
       - (related) → [memory] [fact] Mara is the lighthouse keeper…
       - (related) → [knowledge] 📚 Storm…

You: /smart-writing list
     📚 Saved stories (1): [mem_…] Story "The Lighthouse"…

You: /smart-writing done
```

Notes:
- While a session is ACTIVE, plain chat text is story input (appended, then
  continued automatically). Use `/smart-writing add <text>` to append silently.
- Multi-line works: paste paragraphs in the CLI; in the web composer use
  `Shift+Enter` for a newline (`Enter` sends, up to 4000 chars per message,
  8000 via `POST /api/writing`).
- `save` stores a `story` memory + a versioned `writing` knowledge entry and
  links them to related memories/knowledge in the `memory_links` table —
  inspect with `/smart-writing links <story_id>`.
- Aliases: `/smart-write`, `/write`, `/story`. Full reference:
  `/smart-writing help`. Web parity: same commands over WS/REST plus
  `GET|POST /api/writing`.

---

## 💬 Slash Commands

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/help` | — | Displays the interactive help menu. |
| `/model` | `[name]` | Shows available local models or switches the active model on the fly (e.g. `/model llama3.2`). The pick is saved in the DB and restored on restart. |
| `/trace` | — | Displays detailed diagnostics on how the most recent response was constructed (matched patterns, retrieved memories, knowledge items, strategy, model, evaluation score, and notes). |
| `/stats` | — | Shows database metrics (sessions, messages, active/superseded memories, knowledge, candidate rules, strategy scores). |
| `/memory` | `[query]` | Lists recent memories or searches active memories using TF-IDF token scoring. |
| `/knowledge` | `[query]` | Lists knowledge base entries or searches concepts and definitions. |
| `/remember` | `<text>` | Explicitly adds a durable fact or preference to persistent memory. |
| `/forget` | `<id>` | Deactivates/forgets a specific memory by its ID. |
| `/teach` | `<title: content>` | Explicitly adds a concept to the versioned knowledge base. |
| `/correct` | `<text>` | Explicitly submits a correction; links and supersedes older conflicting memories. |
| `/rules` | `[status]` | Lists ELIZA rules (`approved`, `candidate`, `rejected`, `all`). |
| `/approve` | `<id>` | Approves a learned candidate rule and activates it in the ELIZA engine. |
| `/reload` | — | Reloads rule definitions from `data/rules.json` and database. |
| `/smart-writing` | `start · add · continue · improve · show · save · list · links · done` | Ollama-only co-writing session: iterative continuation/improvement + persistent save with memory linking (aliases: `/smart-write`, `/write`, `/story`). |
| `/clear` | — | Clears current conversation history and starts a new session. |
| `/quit`, `/exit` | — | Exits the conversation cleanly. |

---

## ⚙️ Configuration & Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `BOT_DB_PATH` | `data/bot.db` | Path to the SQLite database file (`:memory:` supported for testing). |
| `BOT_RULES_PATH` | `data/rules.json` | Path to the ELIZA pattern rules JSON file. |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint. |
| `OLLAMA_MODEL` | _(auto-detect)_ | Ollama model for generation/extraction; empty means use the saved last-picked model, else the first available local model. |
| `OLLAMA_ENABLED` | `true` | Set to `false` to disable LLM and run strictly in deterministic ELIZA mode. |
| `OLLAMA_TIMEOUT_MS` | `60000` | Timeout in milliseconds for Ollama requests. |
| `OLLAMA_STREAM` | `true` | Set to `false` to disable token streaming (return full replies at once). |
| `BOT_AUTO_EXTRACTION` | `true` | Enables post-turn extraction of memories and corrections. |
| `BOT_AUTO_EVALUATION`| `true` | Enables post-turn response evaluation and strategy scoring. |
| `BOT_AUTO_RULES` | `true` | Enables candidate rule proposals from conversational patterns. |
| `ELIZA_WEB_PORT` | `3000` | Port for `--web` mode (`WEB_PORT` / `PORT` also honored, `--port` wins). |
| `TELEGRAM_TOKEN` | _(unset)_ | Telegram bot token (`TELEGRAM_BOT_TOKEN` also honored, `--telegram-token` wins). Presence auto-starts the bridge. A token entered via CLI flag or web UI is saved in the DB and reused on restart (editable/deletable in the web UI). |
| `TELEGRAM_ENABLED` | `true` | Set to `false` to keep the Telegram bridge off even with a token (`--no-telegram` also works). |
| `WHATSAPP_ENABLED` | `false` | Set to `true` (or pass `--whatsapp`) to start the WhatsApp bridge. |
| `WHATSAPP_PHONE` | _(unset)_ | Default phone number passed to the Baileys bridge process (`--whatsapp-phone` wins). |
| `WHATSAPP_PORT` | `8765` | Localhost HTTP bridge port (`/chat`, `--whatsapp-port` wins). |
| `WHATSAPP_STATUS_PORT` | `8766` | Baileys status/QR port (`/status`, `/send`). |

---

## 🌐 Web UI & API (`--web`)

Same bot, browser-hosted — modeled on zap's `Bun.serve` + WebSocket server:

| Piece | Endpoint | Notes |
| :--- | :--- | :--- |
| UI | `GET /` | Chat log, composer, command buttons, context/trace panel |
| Health | `GET /api/health` | Ollama reachability, active `(ELIZA:model)`, available models |
| Chat | `POST /api/chat {"message"}` | Full turn incl. slash commands → `{reply, isCommand, trace}` |
| Command | `POST /api/command {"command":"/stats"}` | Explicit slash-command dispatch → `{output}` |
| Stats / Trace | `GET /api/stats`, `GET /api/trace` | Same data as CLI `/stats`, `/trace` |
| Model | `GET /api/model`, `POST /api/model {"name"}`, `DELETE /api/model` | Inspect / switch the active Ollama model (POST persists the pick as `savedModel`); DELETE forgets the saved pick (falls back to auto-detect / rules) |
| Memory / Knowledge | `GET /api/memory?q=`, `GET /api/knowledge?q=` | Same output as CLI `/memory`, `/knowledge` |
| Writing | `GET /api/writing?action=status\|show\|list\|links`, `POST /api/writing {"action","text"}` | Smart-writing session state, saved-story library, and association graph |
| Channels | `GET /api/channels` | Telegram/WhatsApp summary (`configured`/`persisted`/`preview`/`running`/`username`, ports — only a masked `••••abcd` preview, never the full token) |
| WhatsApp status | `GET /api/channels/whatsapp/status` | Baileys bridge proxy: connection, linked phone, last chat, QR image (503 bridge down, 502 node down) |
| WhatsApp send/reset | `POST /api/channels/whatsapp/send {"to","text"}`, `POST /api/channels/whatsapp/reset` | Send via bridge `/send`; clear stale auth keys to re-pair |
| Telegram send/start | `POST /api/channels/telegram/send {"chat_id","text"}`, `POST /api/channels/telegram/start {"token"}` | Send via polling runner; save/edit a bot token and connect at runtime (empty `token` reuses the saved one; persisted only after Telegram accepts it). `DELETE /api/channels/telegram/start` disconnects but keeps the token; `GET\|DELETE /api/channels/telegram/token` inspects (masked) / forgets it |

WS protocol (`/ws`, JSON): client→server `text {text}` · `stop`; server→client
`ready` · `llm-token` · `llm-done {text, isCommand, trace}` · `turn-end` ·
`interrupted` · `error`. One turn per connection; a new `text` cancels the
previous turn (best-effort — the LLM HTTP call itself has no abort signal, so
stale tokens are dropped and its result discarded). Typing `/help` etc. in the
composer works like the CLI.

## 📂 Project Structure

```text
index.ts                   # Root re-export + Bun entrypoint (delegates to src/index.ts)
src/
├── index.ts                # Application entrypoint, createBot() factory, --web/--port/--telegram/--whatsapp parsing, startChannels()
├── config.ts               # Configuration settings and environment defaults (incl. telegram/whatsapp)
├── channels/
│   ├── telegram.ts         # Telegram Bot API long-polling runner (zero-dep, llama port)
│   └── whatsapp.ts         # WhatsApp localhost HTTP bridge + Baileys spawner (llama port)
├── web/
│   └── server.ts           # Bun.serve web UI + REST + /ws streaming (zap-style) + /api/channels*
whatsapp_bridge/           # Baileys socket process: QR login (:8766), forwards to :8765/chat (llama port)
│   ├── index.js            # (Node) socket, QR render, /status + /send
│   └── auth/               # Phone-linked credentials (gitignored — never commit)
├── db/
│   ├── database.ts         # High-performance bun:sqlite database wrapper
│   └── schema.ts           # Database tables, relations, and indexes
├── eliza/
│   ├── reflection.ts       # Pronoun reflection engine
│   ├── patterns.ts         # Rule registry & candidate rule manager
│   └── matcher.ts          # Pattern matcher, wildcard capture & interpolation
├── memory/
│   ├── models.ts           # Memory types, statuses & interfaces
│   ├── store.ts            # Memory CRUD, deduplication & superseding
│   └── retrieval.ts        # Memory retriever with TF-IDF and relevance ranking
├── knowledge/
│   ├── models.ts           # Knowledge entry models & categories
│   ├── store.ts            # Versioned knowledge store & provenance tracking
│   ├── retrieval.ts        # Knowledge relevance search
│   └── learning.ts         # Heuristic and LLM-powered extraction pipeline
├── llm/
│   ├── ollama.ts           # Streaming HTTP client for Ollama
│   └── prompts.ts          # Persona, extraction, evaluation, rule & smart-writing prompts
├── writing/
│   └── smart-writing.ts    # Ollama-gated co-writing sessions + story save with memory_links
├── bot/
│   ├── context.ts          # Context builder assembling memories, knowledge & history
│   ├── evaluator.ts        # Response evaluator & strategy performance tracker
│   ├── response.ts         # Response engine orchestrating ELIZA rules vs. LLM streaming
│   └── conversation.ts     # CLI REPL loop & slash command dispatcher
tests/
├── eliza.test.ts           # Pattern matching, reflection & candidate rules tests
├── memory.test.ts          # Memory storage, deduplication & contradiction tests
├── knowledge.test.ts       # Knowledge versioning and provenance tests
├── learning.test.ts        # Extraction pipeline tests
├── context.test.ts         # Context assembly tests
├── conversation.test.ts    # End-to-end bot interaction and acceptance tests
├── integration.test.ts     # Edge cases, life-cycle, and statistics tests
├── markdown.test.ts        # XSS-safe markdown + emoji renderer tests
├── web.test.ts             # Web server: flags, REST parity, WS streaming
└── writing.test.ts         # Smart-writing: Ollama gating, draft/save/links, web parity
data/
├── rules.json              # 21 seeded ELIZA pattern rules (priority-ranked)
└── bot.db*                 # Local SQLite DB (gitignored — created on first run)
public/
├── index.html              # Web chat UI shell
├── app.ts                  # WS streaming client, command buttons, trace panel
└── markdown.ts             # Zero-dep XSS-safe markdown + :emoji: renderer
```

---

## 🧪 Testing

Run all 60 automated tests (11 files):
```bash
bun test
```

Expected output: `60 pass, 0 fail` (`244 expect() calls`).

---

## 🖥️ CLI Flags

```bash
bun start                          # CLI REPL (default)
bun run web                        # Web UI on default port (3000)
bun run telegram                   # CLI + Telegram bridge (needs TELEGRAM_TOKEN)
bun run whatsapp                   # CLI + WhatsApp bridge (needs whatsapp:install + pairing)
bun run src/index.ts --web --port 3000        # Explicit port
bun run src/index.ts --web --port=3000        # Alternate form
bun run src/index.ts --web --telegram --whatsapp --whatsapp-phone 12345
```

Port resolution order: `--port` flag → `ELIZA_WEB_PORT` → `WEB_PORT` → `PORT` → `3000`.
Database/rules paths can be overridden per-run, e.g. `BOT_DB_PATH=:memory: bun test`
for an isolated in-memory DB.

---

## 📝 Notes

- `data/bot.db*` (SQLite + WAL/SHM) is local runtime state and is gitignored —
  it is created on first run. Delete it to reset sessions, memories, knowledge,
  and saved settings (last-picked model, Telegram token).
- `data/rules.json` ships 21 seeded ELIZA rules; learned candidates stay in the DB
  until approved via `/approve <id>`.
- Offline-first: with Ollama down (or `OLLAMA_ENABLED=false`) the bot keeps working
  via the deterministic rule engine as `(ELIZA:rules)`.

---

## 📄 License

MIT — see [LICENSE](./LICENSE).
