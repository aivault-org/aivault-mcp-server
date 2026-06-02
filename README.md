# aivault-mcp-server

> MCP Server for AIVault — 让任何 AI Agent 搜索、同步、管理你的 AI 对话知识库

[![npm](https://img.shields.io/npm/v/aivault-mcp-server)](https://www.npmjs.com/package/aivault-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 功能

### 知识库工具
| Tool | 说明 |
|------|------|
| `search_conversations` | 关键词搜索对话 |
| `get_conversation` | 获取完整对话详情 |
| `list_conversations` | 列出最近对话 |
| `get_stats` | 获取统计信息 |

### Agent Collector 工具
| Tool | 说明 |
|------|------|
| `register_agent` | 注册 Agent 到 AIVault |
| `sync_conversation` | 同步对话到知识库 |
| `heartbeat` | 心跳保活 |
| `list_agents` | 列出所有已注册 Agent |

## 快速开始

### 1. 创建 Supabase 表

在 Supabase SQL Editor 中执行 `sql/001_collector_agents.sql`。

### 2. 配置 Agent

#### Claude Code (`~/.claude/settings.json`)

```json
{
  "mcpServers": {
    "aivault": {
      "command": "npx",
      "args": ["-y", "aivault-mcp-server"],
      "env": {
        "SUPABASE_URL": "https://xxx.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "eyJ...",
        "AIVAULT_USER_ID": "your-user-uuid"
      }
    }
  }
}
```

#### Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.aivault]
command = "npx"
args = ["-y", "aivault-mcp-server"]

[mcp_servers.aivault.env]
SUPABASE_URL = "https://xxx.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = "eyJ..."
AIVAULT_USER_ID = "your-user-uuid"
```

#### Cursor (Settings → MCP)

```json
{
  "mcpServers": {
    "aivault": {
      "command": "npx",
      "args": ["-y", "aivault-mcp-server"],
      "env": {
        "SUPABASE_URL": "https://xxx.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "eyJ...",
        "AIVAULT_USER_ID": "your-user-uuid"
      }
    }
  }
}
```

### 3. 使用

Agent 连接后自动获得 AIVault 能力：

```
用户: 搜索我之前关于 PostgreSQL 的对话
Agent: [调用 search_conversations(query="PostgreSQL")]

用户: 把刚才的对话同步到 AIVault
Agent: [调用 sync_conversation(sessionId="...", messages=[...])]

用户: 我有哪些 Agent 连接了？
Agent: [调用 list_agents]
```

## Agent 自动同步

配置 MCP Server 后，Agent 可以在对话结束时自动调用 `sync_conversation`。

建议在 Agent 的指令文件中添加：

```markdown
## AIVault Sync

对话结束时，调用 sync_conversation 工具将对话同步到 AIVault。
```

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `SUPABASE_URL` | ✅ | Supabase 项目 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key |
| `AIVAULT_USER_ID` | ❌ | 用户 UUID（不填则取第一个用户） |

## License

MIT © [AIVault](https://github.com/aivault-org)
