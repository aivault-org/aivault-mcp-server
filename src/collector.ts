/**
 * Built-in collector: watches Claude Code session files and auto-syncs
 * raw conversations to AIVault. No manual agent action needed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as os from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ParsedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

interface ParsedSession {
  sessionId: string;
  projectPath: string;
  title: string;
  messages: ParsedMessage[];
  createdAt: string;
  model?: string;
}

interface CollectorState {
  processedSessions: Record<string, { messageCount: number; syncedAt: string }>;
}

// ─── State ───────────────────────────────────────────────────────────────────

const STATE_DIR = path.join(os.homedir(), ".aivault");
const STATE_FILE = path.join(STATE_DIR, "collector-state.json");

function loadState(): CollectorState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return { processedSessions: {} };
}

function saveState(state: CollectorState) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* ignore */ }
}

// ─── Parser ──────────────────────────────────────────────────────────────────

function extractTextContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && b.text) return b.text as string;
          if (b.type === "tool_result" && b.content) return extractTextContent(b.content);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

async function parseSessionFile(filePath: string): Promise<ParsedSession | null> {
  const sessionId = path.basename(filePath, ".jsonl");
  const projectPath = path.basename(path.dirname(filePath));

  const messages: ParsedMessage[] = [];
  let title = "";
  let createdAt: string | undefined;
  let model: string | undefined;

  const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      switch (entry.type) {
        case "queue-operation":
          if (entry.content && typeof entry.content === "string") {
            messages.push({ role: "user", content: entry.content, timestamp: entry.timestamp });
            if (!createdAt && entry.timestamp) createdAt = entry.timestamp;
          }
          break;
        case "user": {
          const uc = extractTextContent(entry.message?.content);
          if (uc) {
            messages.push({ role: "user", content: uc, timestamp: entry.timestamp });
            if (!createdAt && entry.timestamp) createdAt = entry.timestamp;
          }
          break;
        }
        case "assistant": {
          const ac = extractTextContent(entry.message?.content);
          if (ac) {
            messages.push({ role: "assistant", content: ac, timestamp: entry.timestamp });
            if (!model && entry.message?.model) model = entry.message.model;
          }
          break;
        }
        case "ai-title":
          if (entry.title) title = entry.title;
          break;
      }
    } catch { /* skip malformed lines */ }
  }

  // Deduplicate consecutive identical messages
  const deduped: ParsedMessage[] = [];
  for (const msg of messages) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.role === msg.role && prev.content === msg.content) continue;
    deduped.push(msg);
  }

  if (deduped.length === 0) return null;

  if (!title) {
    const firstUser = deduped.find((m) => m.role === "user");
    title = firstUser
      ? firstUser.content.slice(0, 100).replace(/\n/g, " ")
      : `Session ${sessionId.slice(0, 8)}`;
  }

  return { sessionId, projectPath, title, messages: deduped, createdAt: createdAt || new Date().toISOString(), model };
}

// ─── Watcher ─────────────────────────────────────────────────────────────────

type SyncFn = (session: ParsedSession) => Promise<void>;

export async function startCollector(syncFn: SyncFn): Promise<{ stop: () => void }> {
  const chokidar = await import("chokidar");
  const projectsDir = path.join(os.homedir(), ".claude", "projects");

  if (!fs.existsSync(projectsDir)) {
    // Not a Claude Code environment, skip
    return { stop: () => {} };
  }

  const state = loadState();
  const processing = new Set<string>();

  function isProcessed(sessionId: string, messageCount: number): boolean {
    const prev = state.processedSessions[sessionId];
    return !!prev && prev.messageCount === messageCount;
  }

  function markProcessed(sessionId: string, messageCount: number) {
    state.processedSessions[sessionId] = { messageCount, syncedAt: new Date().toISOString() };
    saveState(state);
  }

  async function handleFile(filePath: string) {
    if (filePath.includes("/subagents/")) return;
    if (processing.has(filePath)) return;
    processing.add(filePath);

    try {
      const session = await parseSessionFile(filePath);
      if (!session) return;
      if (isProcessed(session.sessionId, session.messages.length)) return;

      await syncFn(session);
      markProcessed(session.sessionId, session.messages.length);
    } catch (e) {
      // Silent — don't crash MCP server on sync errors
    } finally {
      processing.delete(filePath);
    }
  }

  // Initial scan
  const files = fs.readdirSync(projectsDir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith(".jsonl") && !f.name.includes("subagent"))
    .map((f) => path.join(f.parentPath || (f as unknown as { parent: string }).parent || projectsDir, f.name));

  for (const file of files) {
    await handleFile(file);
  }

  // Watch for changes
  const watcher = chokidar.watch(path.join(projectsDir, "**", "*.jsonl"), {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
  });

  watcher.on("add", (p) => handleFile(p));
  watcher.on("change", (p) => handleFile(p));

  return {
    stop: () => { watcher.close(); },
  };
}
