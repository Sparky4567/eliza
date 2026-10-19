// @ts-nocheck
// MCP server mode for eliza (stdio + HTTP/SSE), adapted from dagowan.
import fs from "node:fs";
import path from "node:path";
import { createBot } from "./index.ts";
import { searchWeb, fetchPageText, formatWebResults, formatPageText } from "./websearch.ts";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "eliza";
const SERVER_VERSION = "1.0.0";

function logErr(...args) { try { console.error(...args); } catch {} }
function textResult(text) { return { content: [{ type: "text", text: String(text ?? "") }] }; }
function jsonRpc(id, result) { return { jsonrpc: "2.0", id, result }; }
function jsonRpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message: String(message) } }; }

export const TOOLS = [
    { name: "ping", description: "Health check for the eliza MCP server.", inputSchema: { type: "object", properties: {} } },
    { name: "eliza_chat", description: "Send a message to the eliza assistant and get a reply.", inputSchema: { type: "object", properties: { message: { type: "string" }, sessionId: { type: "string" } }, required: ["message"] } },
    { name: "list_sessions", description: "List chat sessions.", inputSchema: { type: "object", properties: {} } },
    { name: "get_memories", description: "Retrieve memories (via /memory).", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } } } },
    { name: "remember", description: "Store a new memory.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "web_search", description: "Search the web.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" }, provider: { type: "string" } }, required: ["query"] } },
    { name: "web_fetch", description: "Fetch a URL.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
];

export class McpServerState {
    constructor(bot) {
        this.bot = bot;
        this.settings = bot ? bot.getConfig() : {};
    }
    get db() { return this.bot.getDatabase(); }

    settingsFromEnv() {
        return {
            websearch_enabled: true,
            websearch_provider: process.env.WEBSEARCH_PROVIDER || "auto",
            websearch_max_results: process.env.WEBSEARCH_MAX_RESULTS || 5,
            websearch_timeout_ms: process.env.WEBSEARCH_TIMEOUT_MS || 12000,
            brave_api_key: process.env.BRAVE_API_KEY || "",
            tavily_api_key: process.env.TAVILY_API_KEY || "",
            gemini_api_key: process.env.GEMINI_API_KEY || "",
            gemini_search_model: process.env.GEMINI_SEARCH_MODEL || "gemini-2.5-flash",
        };
    }

    getToken() {
        const env = process.env.MCP_TOKEN || "";
        if (env) return env;
        try { return this.db.getSetting("mcp_server_token") || ""; } catch { return ""; }
    }

    async handleTool(name, args = {}) {
        args = args || {};
        switch (name) {
            case "ping":
                return textResult(`pong (server=${SERVER_NAME} pid=${process.pid} cwd=${process.cwd()})`);
            case "eliza_chat": {
                const msg = String(args.message || "").trim();
                if (!msg) return { content: [{ type: "text", text: "message is required" }], isError: true };
                const res = await this.bot.handleInput(msg);
                const reply = (res && res.response) || "";
                return textResult(String(reply));
            }
            case "list_sessions": {
                const rows = this.db.query("SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC");
                return textResult(JSON.stringify(rows, null, 2));
            }
            case "get_memories": {
                const q = String(args.query || "").trim();
                const out = await this.bot.handleCommand(q ? `/memory ${q}` : "/memory");
                return textResult(out);
            }
            case "remember": {
                const text = String(args.text || "").trim();
                if (!text) return { content: [{ type: "text", text: "text is required" }], isError: true };
                const out = await this.bot.handleCommand(`/remember ${text}`);
                return textResult(out);
            }
            case "web_search": {
                const query = String(args.query || "").trim();
                if (!query) return { content: [{ type: "text", text: "query is required" }], isError: true };
                const settings = this.settingsFromEnv();
                const limit = Number(args.limit) > 0 ? Number(args.limit) : undefined;
                const res = await searchWeb(query, settings, { limit, provider: args.provider });
                return textResult(formatWebResults(res));
            }
            case "web_fetch": {
                const url = String(args.url || "").trim();
                if (!url) return { content: [{ type: "text", text: "url is required" }], isError: true };
                const settings = this.settingsFromEnv();
                const res = await fetchPageText(url, settings);
                return textResult(formatPageText(res));
            }
            default:
                return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
        }
    }

    async handleRpc(msg) {
        if (!msg || typeof msg !== "object") return jsonRpcError(null, -32600, "Invalid request");
        const { id, method, params } = msg;
        try {
            if (method === "initialize") {
                return jsonRpc(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } });
            }
            if (method === "notifications/initialized" || method === "initialized") {
                if (id === undefined || id === null) return null;
                return jsonRpc(id, {});
            }
            if (method === "ping") return jsonRpc(id, {});
            if (method === "tools/list") return jsonRpc(id, { tools: TOOLS });
            if (method === "tools/call") {
                const p = params || {};
                const result = await this.handleTool(p.name, p.arguments || {});
                return jsonRpc(id, result);
            }
            if (method === "resources/list") return jsonRpc(id, { resources: [] });
            if (method === "prompts/list") return jsonRpc(id, { prompts: [] });
            if (id === undefined || id === null) return null;
            return jsonRpcError(id, -32601, `Method not found: ${method}`);
        } catch (err) {
            if (id === undefined || id === null) return null;
            return jsonRpcError(id, -32000, err && err.message ? err.message : String(err));
        }
    }
}

export async function startHttpServer(state, port) {
    const sessions = new Map();
    let sessionCounter = 0;
    const server = Bun.serve({
        port,
        hostname: "0.0.0.0",
        async fetch(req) {
            const url = new URL(req.url);
            const pathname = url.pathname;
            if (pathname === "/health" || pathname === "/api/health") {
                return new Response(JSON.stringify({ ok: true, service: "eliza-mcp", tools: TOOLS.length }), { headers: { "Content-Type": "application/json" } });
            }
            const token = state.getToken();
            if (token) {
                const auth = req.headers.get("authorization") || "";
                if (auth !== `Bearer ${token}`) {
                    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } });
                }
            }
            if (pathname === "/mcp") {
                if (req.method === "POST") {
                    let body;
                    try { body = await req.json(); } catch {
                        return new Response(JSON.stringify(jsonRpcError(null, -32700, "Parse error")), { status: 400, headers: { "Content-Type": "application/json" } });
                    }
                    const isBatch = Array.isArray(body);
                    const items = isBatch ? body : [body];
                    const results = [];
                    for (const item of items) {
                        const r = await state.handleRpc(item);
                        if (r !== null) results.push(r);
                    }
                    if (results.length === 0) return new Response(null, { status: 202 });
                    const payload = isBatch ? results : results[0];
                    return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
                }
                if (req.method === "GET") {
                    const stream = new ReadableStream({
                        start(controller) {
                            const encoder = new TextEncoder();
                            const ping = setInterval(() => { try { controller.enqueue(encoder.encode(": ping\n\n")); } catch {} }, 15000);
                            req.signal.addEventListener("abort", () => { clearInterval(ping); try { controller.close(); } catch {} });
                        },
                    });
                    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
                }
                return new Response("Method Not Allowed", { status: 405 });
            }
            if (pathname === "/sse" && req.method === "GET") {
                const sessionId = `s${++sessionCounter}`;
                const encoder = new TextEncoder();
                let controllerRef = null;
                const stream = new ReadableStream({
                    start(controller) { controllerRef = controller; const msg = `event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`; controller.enqueue(encoder.encode(msg)); },
                });
                sessions.set(sessionId, { controller: controllerRef, encoder });
                const entry = sessions.get(sessionId);
                const interval = setInterval(() => { try { entry.controller.enqueue(encoder.encode(": ping\n\n")); } catch {} }, 15000);
                req.signal.addEventListener("abort", () => { clearInterval(interval); sessions.delete(sessionId); try { controllerRef.close(); } catch {} });
                return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
            }
            if (pathname === "/messages" && req.method === "POST") {
                const sessionId = url.searchParams.get("sessionId");
                const entry = sessions.get(sessionId);
                if (!entry) return new Response(JSON.stringify(jsonRpcError(null, -32000, "Unknown session")), { status: 404, headers: { "Content-Type": "application/json" } });
                let body;
                try { body = await req.json(); } catch { return new Response("Parse error", { status: 400 }); }
                const items = Array.isArray(body) ? body : [body];
                for (const item of items) {
                    const r = await state.handleRpc(item);
                    if (r !== null) {
                        const payload = `event: message\ndata: ${JSON.stringify(r)}\n\n`;
                        try { entry.controller.enqueue(entry.encoder.encode(payload)); } catch {}
                    }
                }
                return new Response("Accepted", { status: 202 });
            }
            return new Response("Not Found", { status: 404 });
        },
    });
    logErr(`[mcp] HTTP server listening on http://0.0.0.0:${port}`);
    logErr(`[mcp] Streamable HTTP endpoint: http://0.0.0.0:${port}/mcp`);
    if (state.getToken()) logErr("[mcp] Bearer token auth ENABLED");
    else logErr("[mcp] WARNING: no MCP_TOKEN set — unauthenticated");
    return server;
}

export async function startStdioServer(state) {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
        buffer += String(chunk);
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            (async () => {
                try {
                    const r = await state.handleRpc(msg);
                    if (r !== null) process.stdout.write(JSON.stringify(r) + "\n");
                } catch (err) {
                    process.stdout.write(JSON.stringify(jsonRpcError(msg && msg.id, -32000, err && err.message ? err.message : String(err))) + "\n");
                }
            })();
        }
    });
    logErr("[mcp] stdio JSON-RPC ready");
}

export async function startMcpServer(opts = {}) {
    const bot = opts.bot || createBot();
    await bot.init();
    const state = new McpServerState(bot);
    const http = opts.http !== false;
    const stdio = opts.stdio !== false;
    if (http) {
        const port = Number(opts.port || process.env.MCP_PORT || 8790);
        await startHttpServer(state, port);
    }
    if (stdio) await startStdioServer(state);
    return state;
}