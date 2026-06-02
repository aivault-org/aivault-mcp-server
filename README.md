# aivault-mcp-server

> MCP Server for AIVault — 让任何 AI Agent 搜索、同步、管理你的 AI 对话知识库

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 架构

```
Agent (Claude/Codex/Cursor/...)
  ↓ MCP Protocol
aivault-mcp-server  ← 本项目
  ↓ HTTP API (Bearer av_xxx)
AIVault 实例 (your-domain.com)
  ↓
Supabase / PostgreSQL
```

MCP Server 是一个**轻量 HTTP 客户端**，不直接连接数据库，只通过 AIVault 的 API 通信。

## 功能

### 知识库工具
| Tool | 说明 |
|------|------|
| `search_conversations` | 关键词 / 语义搜索对话 |
| `get_conversation` | 获取完整对话详情 |
| `list_conversations` | 列出最近对话 |
| `get_stats` | 获取统计信息 |

### Agent Collector 工具
| Tool | 说明 |
|------|------|
| `register_agent` | 注册 Agent 到 AIVault Dashboard |
| `sync_conversation` | 同步对话到知识库 |
| `heartbeat` | 心跳保活，标记在线状态 |
| `list_agents` | 查看所有已注册 Agent |

## 快速开始

### 1. 生成 API Key

在 AIVault 中：Settings → API Keys → Generate

### 2. 配置 Agent

只需两个环境变量：`AIVAULT_URL` 和 `AIVAULT_API_KEY`。

#### Claude Code (`~/.claude/settings.json`)

```json
{
  "mcpServers": {
    "aivault": {
      "command": "npx",
      "args": ["-y", "aivault-mcp-server"],
      "env": {
        "AIVAULT_URL": "https://your-aivault.com",
        "AIVAULT_API_KEY": "av_xxxxxxxx"
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
AIVAULT_URL = "https://your-aivault.com"
AIVAULT_API_KEY = "av_xxxxxxxx"
```

#### Cursor (Settings → MCP)

```json
{
  "mcpServers": {
    "aivault": {
      "command": "npx",
      "args": ["-y", "aivault-mcp-server"],
      "env": {
        "AIVAULT_URL": "https://your-aivault.com",
        "AIVAULT_API_KEY": "av_xxxxxxxx"
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
| `AIVAULT_URL` | ✅ | AIVault 实例地址 (如 `https://aivault.example.com`) |
| `AIVAULT_API_KEY` | ✅ | API Key (在 AIVault Settings > API Keys 生成) |

## License

MIT © [AIVault](https://github.com/aivault-org)
