#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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

// ─── HTTP Client ─────────────────────────────────────────────────────────────

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${AIVAULT_API_KEY}`,
};

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${AIVAULT_URL}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AIVault API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${AIVAULT_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AIVault API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${AIVAULT_URL}${path}`, {
    method: "PATCH",
    headers,
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

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "aivault",
  version: "0.1.0",
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

const transport = new StdioServerTransport();
await server.connect(transport);
