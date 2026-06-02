#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// ─── Environment ─────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USER_ID = process.env.AIVAULT_USER_ID;

if (!SUPABASE_URL) {
  console.error("Error: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) env var is required");
  process.exit(1);
}
if (!SUPABASE_KEY) {
  console.error("Error: SUPABASE_SERVICE_ROLE_KEY env var is required");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeIlike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function errorMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function getUserId(): Promise<string> {
  if (USER_ID) return USER_ID;
  const { data, error } = await supabase
    .from("users")
    .select("id")
    .limit(1)
    .single();
  if (error || !data) {
    throw new Error("No user found. Set AIVAULT_USER_ID env var.");
  }
  return data.id;
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "aivault",
  version: "1.0.0",
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOLS: Knowledge Base
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.tool(
  "search_conversations",
  "Search conversations by keyword in title or message content",
  {
    query: z.string().describe("Search keyword"),
    platform: z.string().optional().describe("Filter by platform"),
    limit: z.number().optional().default(10),
  },
  async ({ query, platform, limit }) => {
    try {
      const uid = await getUserId();
      const escaped = escapeIlike(query);

      let titleQuery = supabase
        .from("conversations")
        .select("id, title, platform, message_count, created_at, summary")
        .eq("user_id", uid)
        .ilike("title", `%${escaped}%`)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (platform) titleQuery = titleQuery.eq("platform", platform);
      const { data: titleMatches } = await titleQuery;

      const { data: msgMatches } = await supabase
        .from("messages")
        .select("conversation_id, conversations!inner(id, title, platform, message_count, created_at, summary, user_id)")
        .ilike("content", `%${escaped}%`)
        .eq("conversations.user_id", uid)
        .limit(limit * 3);

      const convMap = new Map<string, Record<string, unknown>>();
      for (const c of titleMatches || []) convMap.set(c.id, c);
      for (const m of msgMatches || []) {
        const c = (m as Record<string, unknown>).conversations as Record<string, unknown> | null;
        if (c && !convMap.has(c.id as string)) convMap.set(c.id as string, c);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify([...convMap.values()].slice(0, limit), null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  }
);

server.tool(
  "get_conversation",
  "Get full conversation with all messages",
  {
    conversationId: z.string(),
  },
  async ({ conversationId }) => {
    try {
      const { data: conv, error } = await supabase
        .from("conversations")
        .select("*")
        .eq("id", conversationId)
        .single();
      if (error) throw error;

      const { data: messages } = await supabase
        .from("messages")
        .select("id, role, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...conv, messages: messages || [] }, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  }
);

server.tool(
  "list_conversations",
  "List recent conversations",
  {
    platform: z.string().optional(),
    limit: z.number().optional().default(20),
  },
  async ({ platform, limit }) => {
    try {
      const uid = await getUserId();
      let q = supabase
        .from("conversations")
        .select("id, title, platform, message_count, created_at, summary")
        .eq("user_id", uid)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (platform) q = q.eq("platform", platform);
      const { data, error } = await q;
      if (error) throw error;
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  }
);

server.tool(
  "get_stats",
  "Get AIVault statistics",
  {},
  async () => {
    try {
      const uid = await getUserId();
      const { count: convCount } = await supabase
        .from("conversations")
        .select("*", { count: "exact", head: true })
        .eq("user_id", uid);

      const { data: userConvs } = await supabase
        .from("conversations")
        .select("id")
        .eq("user_id", uid);
      const convIds = (userConvs || []).map((c) => c.id);

      let msgCount = 0;
      if (convIds.length > 0) {
        const { count } = await supabase
          .from("messages")
          .select("*", { count: "exact", head: true })
          .in("conversation_id", convIds);
        msgCount = count || 0;
      }

      const { data: platforms } = await supabase
        .from("conversations")
        .select("platform")
        .eq("user_id", uid);
      const uniquePlatforms = [...new Set((platforms || []).map((p) => p.platform))];

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            total_conversations: convCount || 0,
            total_messages: msgCount,
            platforms: uniquePlatforms,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOLS: Agent Collector
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.tool(
  "register_agent",
  "Register this agent with AIVault. Call once when first connecting.",
  {
    platform: z.enum(["CHATGPT", "CLAUDE", "GEMINI", "CODEX", "CURSOR", "OPENCODE", "HERMES", "OTHER"]),
    agentName: z.string().describe("Human-readable agent name, e.g. 'Claude Code', 'Codex CLI'"),
    version: z.string().optional().describe("Agent/tool version"),
    device: z.string().optional().describe("Device or machine identifier"),
  },
  async ({ platform, agentName, version, device }) => {
    try {
      const uid = await getUserId();
      const agentId = `${platform.toLowerCase()}-${device || "default"}`;

      const { data, error } = await supabase
        .from("collector_agents")
        .upsert({
          user_id: uid,
          agent_id: agentId,
          platform,
          agent_name: agentName,
          version: version || null,
          device: device || null,
          last_seen: new Date().toISOString(),
          status: "online",
        }, { onConflict: "agent_id" })
        .select()
        .single();

      if (error) {
        // Table might not exist yet
        if (error.message.includes("does not exist")) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: collector_agents table not found. Run the migration SQL first. See README for instructions.",
            }],
            isError: true,
          };
        }
        throw error;
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ registered: true, agentId, ...data }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  }
);

server.tool(
  "sync_conversation",
  "Sync a conversation to AIVault. Send the full conversation messages.",
  {
    sessionId: z.string().describe("Unique session identifier for deduplication"),
    platform: z.enum(["CHATGPT", "CLAUDE", "GEMINI", "CODEX", "CURSOR", "OPENCODE", "HERMES", "OTHER"]),
    title: z.string().optional().describe("Conversation title"),
    messages: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
      timestamp: z.string().optional(),
    })).min(1),
    createdAt: z.string().optional().describe("ISO-8601 conversation start time"),
    model: z.string().optional().describe("Model used"),
  },
  async ({ sessionId, platform, title, messages, createdAt, model }) => {
    try {
      const uid = await getUserId();

      // Check for existing conversation
      const { data: existing } = await supabase
        .from("conversations")
        .select("id, message_count")
        .eq("user_id", uid)
        .eq("summary", `session:${sessionId}`)
        .limit(1)
        .single();

      if (existing) {
        // Update: replace messages
        await supabase.from("messages").delete().eq("conversation_id", existing.id);
        await supabase
          .from("conversations")
          .update({ message_count: messages.length, title: title || undefined })
          .eq("id", existing.id);

        await insertMessages(existing.id, messages);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ action: "updated", conversationId: existing.id, messageCount: messages.length }),
          }],
        };
      }

      // Create new
      const { data: conv, error } = await supabase
        .from("conversations")
        .insert({
          user_id: uid,
          platform,
          title: title || `${platform} Session ${sessionId.slice(0, 8)}`,
          summary: `session:${sessionId}`,
          message_count: messages.length,
          created_at: createdAt || new Date().toISOString(),
          imported_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (error) throw error;

      await insertMessages(conv.id, messages);

      // Auto-embed (async, fire and forget)
      supabase.from("messages").select("id").eq("conversation_id", conv.id).limit(1);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ action: "created", conversationId: conv.id, messageCount: messages.length }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  }
);

server.tool(
  "heartbeat",
  "Send heartbeat to indicate this agent is still active",
  {
    agentId: z.string().describe("Agent ID returned from register_agent"),
  },
  async ({ agentId }) => {
    try {
      const { data, error } = await supabase
        .from("collector_agents")
        .update({ last_seen: new Date().toISOString(), status: "online" })
        .eq("agent_id", agentId)
        .select()
        .single();

      if (error) throw error;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: true, lastSeen: data?.last_seen }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  }
);

server.tool(
  "list_agents",
  "List all registered collector agents and their status",
  {},
  async () => {
    try {
      const uid = await getUserId();
      const { data, error } = await supabase
        .from("collector_agents")
        .select("*")
        .eq("user_id", uid)
        .order("last_seen", { ascending: false });

      if (error) {
        if (error.message.includes("does not exist")) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ agents: [], note: "collector_agents table not found. Run migration first." }),
            }],
          };
        }
        throw error;
      }

      // Mark stale agents (no heartbeat in 5 minutes)
      const now = Date.now();
      const agents = (data || []).map((a) => ({
        ...a,
        status: now - new Date(a.last_seen).getTime() > 5 * 60 * 1000 ? "offline" : a.status,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ agents }, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${errorMsg(e)}` }], isError: true };
    }
  }
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function insertMessages(
  conversationId: string,
  messages: Array<{ role: string; content: string; timestamp?: string }>,
) {
  for (let i = 0; i < messages.length; i += 50) {
    const batch = messages.slice(i, i + 50);
    const rows = batch.map((msg) => ({
      conversation_id: conversationId,
      role: msg.role,
      content: msg.content,
      created_at: msg.timestamp || new Date().toISOString(),
    }));
    const { error } = await supabase.from("messages").insert(rows);
    if (error) throw new Error(`Failed to insert messages: ${error.message}`);
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
