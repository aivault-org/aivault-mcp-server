#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import { hostname, platform as osPlatform } from "node:os";
import { execSync } from "node:child_process";

// ─── Environment ─────────────────────────────────────────────────────────────

const AIVAULT_URL = process.env.AIVAULT_URL?.replace(/\/+$/, "");
const AIVAULT_API_KEY = process.env.AIVAULT_API_KEY;

if (!AIVAULT_URL) {
  console.error("Error: AIVAULT_URL env var is required (e.g. https://aivault.example.com)");
  process.exit(1);
}
if (!AIVAULT_API_KEY) {
  console.error("Error: AIVAULT_API_KEY env var is required (generate in AIVault Settings > API Keys)");
  process.exit(1);
}

// ─── Auto-detect agent type ──────────────────────────────────────────────────

function detectPlatform(): string {
  // 1. Check known agent env vars
  if (process.env.CODEX_CI || process.env.CODEX_SHELL || process.env.CODEX_THREAD_ID) return "CODEX";
  if (process.env.CLAUDE_CODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "CLAUDE";
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_SESSION) return "CURSOR";
  if (process.env.OPENCODE) return "OPENCODE";
  if (process.env.HERMES) return "HERMES";

  // 2. Check macOS bundle identifier
  const bundleId = process.env.__CFBundleIdentifier || "";
  if (bundleId.includes("codex")) return "CODEX";
  if (bundleId.includes("claude")) return "CLAUDE";
  if (bundleId.includes("cursor")) return "CURSOR";

  // 3. Check parent process name (works for CLI agents)
  try {
    const ppid = process.ppid;
    if (ppid) {
      const cmd = execSync(`ps -p ${ppid} -o comm=`, { encoding: "utf8", timeout: 1000 }).trim().toLowerCase();
      if (cmd.includes("claude")) return "CLAUDE";
      if (cmd.includes("codex")) return "CODEX";
      if (cmd.includes("cursor")) return "CURSOR";
    }
  } catch { /* ignore */ }

  return "MCP";
}

function detectAgentName(): string {
  // Try macOS computer name first (most user-friendly)
  if (osPlatform() === "darwin") {
    try {
      const name = execSync("scutil --get ComputerName", { encoding: "utf8", timeout: 2000 }).trim();
      if (name && name !== "localhost") return name;
    } catch { /* ignore */ }
  }

  // Fallback to hostname
  const h = hostname();
  // "bogon" is macOS default when DNS is unconfigured — not useful
  if (h === "bogon" || h === "localhost") {
    return `${osPlatform()} device`;
  }
  return h;
}

const agentPlatform = process.env.AIVAULT_AGENT_PLATFORM || detectPlatform();
const agentName = process.env.AIVAULT_AGENT_NAME || detectAgentName();

// ─── Proxy & Fetch ───────────────────────────────────────────────────────────

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  || process.env.https_proxy || process.env.http_proxy;

const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doFetch: (url: string, opts?: any) => Promise<any> = proxyAgent
  ? (url, opts) => undiciFetch(url, { ...opts, dispatcher: proxyAgent })
  : fetch;

// ─── HTTP Client ─────────────────────────────────────────────────────────────

const reqHeaders: Record<string, string> = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${AIVAULT_API_KEY}`,
};

async function apiGet<T>(path: string): Promise<T> {
  const res = await doFetch(`${AIVAULT_URL}${path}`, { method: "GET", headers: reqHeaders });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AIVault API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await doFetch(`${AIVAULT_URL}${path}`, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AIVault API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await doFetch(`${AIVAULT_URL}${path}`, {
    method: "PATCH",
    headers: reqHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AIVault API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

function errorMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── Auto-register on startup ────────────────────────────────────────────────

let currentAgentId: string | null = null;

async function autoRegister(): Promise<void> {
  try {
    // Stable ID: user can override, otherwise derive from hostname + platform
    const stableId = process.env.AIVAULT_AGENT_ID
      || `agent_${hostname()}_${agentPlatform}`.replace(/[^a-zA-Z0-9_-]/g, "_");

    const data = await apiPost<Record<string, unknown>>("/api/collector/agents", {
      action: "register",
      agentId: stableId,
      name: agentName,
      platform: agentPlatform,
      metadata: {
        hostname: hostname(),
        displayName: agentName,
        os: osPlatform(),
        nodeVersion: process.version,
        mcpVersion: "0.1.5",
      },
    });

    currentAgentId = (data.agent_id as string) || (data.id as string) || null;
    if (currentAgentId) {
      setInterval(() => {
        apiPatch("/api/collector/agents", {
          action: "heartbeat",
          agentId: currentAgentId,
        }).catch(() => {});
      }, 60_000);
    }
  } catch (e) {
    console.error("[aivault] auto-register failed:", errorMsg(e));
  }
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "aivault",
  version: "0.1.4",
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOLS: Knowledge Base
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.tool(
  "search_conversations",
  "Search conversations by keyword or semantic similarity",
  {
    query: z.string().describe("Search keyword or natural language query"),
    mode: z.enum(["keyword", "semantic"]).optional().default("keyword")
      .describe("Search mode: keyword (default) or semantic"),
    platform: z.string().optional().describe("Filter by platform (CHATGPT, CLAUDE, etc.)"),
    limit: z.number().optional().default(10),
  },
  async ({ query, mode, platform, limit }) => {
    try {
      const params = new URLSearchParams({ q: query, mode, limit: String(limit) });
      if (platform) params.set("platform", platform);
      const data = await apiGet<unknown>(`/api/search?${params}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  },
);

server.tool(
  "get_conversation",
  "Get full conversation with all messages by ID",
  {
    conversationId: z.string().describe("Conversation UUID"),
  },
  async ({ conversationId }) => {
    try {
      const data = await apiGet<unknown>(`/api/conversations/${conversationId}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  },
);

server.tool(
  "list_conversations",
  "List recent conversations with optional filters",
  {
    page: z.number().optional().default(1),
    limit: z.number().optional().default(20),
    platform: z.string().optional().describe("Filter by platform"),
    query: z.string().optional().describe("Filter by title keyword"),
  },
  async ({ page, limit, platform, query }) => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (platform) params.set("platform", platform);
      if (query) params.set("q", query);
      const data = await apiGet<unknown>(`/api/conversations?${params}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  },
);

server.tool(
  "get_stats",
  "Get AIVault statistics: total conversations, messages, platforms, and plan",
  {},
  async () => {
    try {
      const data = await apiGet<unknown>("/api/stats");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  },
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOLS: Agent Collector
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.tool(
  "register_agent",
  "Register this agent as a collector in AIVault. Returns an agentId for heartbeats.",
  {
    name: z.string().describe("Agent display name (e.g. 'MacBook Claude Code')"),
    platform: z.string().describe("Platform identifier (CLAUDE, CODEX, CURSOR, etc.)"),
    metadata: z.record(z.unknown()).optional().describe("Optional metadata (hostname, version, etc.)"),
  },
  async ({ name, platform, metadata }) => {
    try {
      const data = await apiPost<unknown>("/api/collector/agents", {
        action: "register",
        name,
        platform,
        metadata,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  },
);

server.tool(
  "sync_conversation",
  "Sync a conversation to AIVault. Uses sessionId for deduplication.",
  {
    sessionId: z.string().describe("Unique session identifier for dedup"),
    platform: z.string().describe("Platform (CHATGPT, CLAUDE, CODEX, CURSOR, etc.)"),
    title: z.string().optional().describe("Conversation title"),
    messages: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
      timestamp: z.string().optional(),
    })).min(1).describe("Conversation messages"),
    createdAt: z.string().optional().describe("ISO-8601 conversation start time"),
    model: z.string().optional().describe("Model used"),
  },
  async ({ sessionId, platform, title, messages, createdAt, model }) => {
    try {
      const data = await apiPost<unknown>("/api/collector/sync", {
        sessionId,
        platform,
        title,
        messages,
        createdAt,
        model,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  },
);

server.tool(
  "heartbeat",
  "Send heartbeat to indicate this agent is still active",
  {
    agentId: z.string().describe("Agent ID returned from register_agent"),
  },
  async ({ agentId }) => {
    try {
      const data = await apiPatch<unknown>("/api/collector/agents", {
        action: "heartbeat",
        agentId,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  },
);

server.tool(
  "list_agents",
  "List all registered collector agents and their online/offline status",
  {},
  async () => {
    try {
      const data = await apiGet<unknown>("/api/collector/agents");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  },
);

// ─── Start ───────────────────────────────────────────────────────────────────

await autoRegister();

const transport = new StdioServerTransport();
await server.connect(transport);
