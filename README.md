# ELIZA-AI: Incrementally Learning LLM Bot in Bun (CLI + Web)

A modular, incrementally learning conversational AI built with **Bun** and **TypeScript**. It combines the predictable, reflective empathy of classic ELIZA with a persistent cognitive layer, long-term memory, versioned knowledge base, and local LLM integration via **Ollama** (with real-time streaming). Talk to it in the terminal (`bun start`) or in the browser (`bun run web`).

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
- **Resilient LLM Layer**: Clear timeout errors (no more cryptic `The operation was aborted`), best-effort background learning that never breaks a reply, graceful ELIZA fallback, and a Ctrl+C-safe CLI loop.

---

## 📐 System Architecture

```text
                ┌────────────────────┐  ┌────────────────────┐
                │   Terminal User    │  │   Browser User     │
                │   (bun start)      │  │   (bun run web)    │
                └─────────┬──────────┘  └─────────┬──────────┘
                          │                       ▼
                          │              ┌────────────────────┐
                          │              │  Web Server + WS   │ ◄── REST (/api/*) + live tokens
                          │              └─────────┬──────────┘
                          ▼                       ▼
                         ┌────────────────────┐
                         │ Conversation Loop  │ ◄── Slash Commands (/trace, /stats, etc.)
                         └─────────┬──────────┘
                                   │
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
`/trace`, `/memory`, …), plus a context/trace side panel. REST + WS API below.
Port fallback: `--port` flag, else `ELIZA_WEB_PORT` / `WEB_PORT` / `PORT` env.

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

## 💬 Slash Commands

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/help` | — | Displays the interactive help menu. |
| `/model` | `[name]` | Shows available local models or switches the active model on the fly (e.g. `/model llama3.2`). |
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
| `/clear` | — | Clears current conversation history and starts a new session. |
| `/quit`, `/exit` | — | Exits the conversation cleanly. |

---

## ⚙️ Configuration & Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `BOT_DB_PATH` | `data/bot.db` | Path to the SQLite database file (`:memory:` supported for testing). |
| `BOT_RULES_PATH` | `data/rules.json` | Path to the ELIZA pattern rules JSON file. |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint. |
| `OLLAMA_MODEL` | _(auto-detect)_ | Ollama model for generation/extraction; empty means use the first available local model. |
| `OLLAMA_ENABLED` | `true` | Set to `false` to disable LLM and run strictly in deterministic ELIZA mode. |
| `OLLAMA_TIMEOUT_MS` | `60000` | Timeout in milliseconds for Ollama requests. |
| `BOT_AUTO_EXTRACTION` | `true` | Enables post-turn extraction of memories and corrections. |
| `BOT_AUTO_EVALUATION`| `true` | Enables post-turn response evaluation and strategy scoring. |
| `BOT_AUTO_RULES` | `true` | Enables candidate rule proposals from conversational patterns. |
| `ELIZA_WEB_PORT` | `3000` | Port for `--web` mode (`WEB_PORT` / `PORT` also honored, `--port` wins). |

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
| Model | `GET /api/model`, `POST /api/model {"name"}` | Inspect / switch the active Ollama model |
| Memory / Knowledge | `GET /api/memory?q=`, `GET /api/knowledge?q=` | Same output as CLI `/memory`, `/knowledge` |

WS protocol (`/ws`, JSON): client→server `text {text}` · `stop`; server→client
`ready` · `llm-token` · `llm-done {text, isCommand, trace}` · `turn-end` ·
`interrupted` · `error`. One turn per connection; a new `text` cancels the
previous turn (best-effort — the LLM HTTP call itself has no abort signal, so
stale tokens are dropped and its result discarded). Typing `/help` etc. in the
composer works like the CLI.

## 📂 Project Structure

```text
src/
├── index.ts                # Application entrypoint, createBot() factory, --web/--port parsing
├── config.ts               # Configuration settings and environment defaults
├── web/
│   └── server.ts           # Bun.serve web UI + REST + /ws streaming (zap-style)
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
│   └── prompts.ts          # Persona, extraction, evaluation & rule prompts
└── bot/
    ├── context.ts          # Context builder assembling memories, knowledge & history
    ├── evaluator.ts        # Response evaluator & strategy performance tracker
    ├── response.ts         # Response engine orchestrating ELIZA rules vs. LLM streaming
    └── conversation.ts     # CLI REPL loop & slash command dispatcher
tests/
├── eliza.test.ts           # Pattern matching, reflection & candidate rules tests
├── memory.test.ts          # Memory storage, deduplication & contradiction tests
├── knowledge.test.ts       # Knowledge versioning and provenance tests
├── learning.test.ts        # Extraction pipeline tests
├── context.test.ts         # Context assembly tests
├── conversation.test.ts    # End-to-end bot interaction and acceptance tests
├── integration.test.ts     # Edge cases, life-cycle, and statistics tests
└── web.test.ts             # Web server: flags, REST parity, WS streaming
public/
├── index.html              # Web chat UI shell
└── app.ts                  # WS streaming client, command buttons, trace panel
```

---

## 🧪 Testing

Run all 33 automated tests:
```bash
bun test
```
