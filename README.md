# dsh-session-search-pro

> Advanced cross-session full-text search for DeepSeek Harness — search past and current DSH sessions using the built-in `sessionQuery` service.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2)](https://github.com/topics/dsh-plugin)

## Why another session search plugin?

The existing [dsh-session-search](https://github.com/Tieboyh/dsh-session-search) is well-engineered, but it's **index-free** — every search decompresses and scans all zstd session files from scratch. This plugin takes a different approach: it uses DSH's built-in **`sessionQuery`** service, which provides indexed, full-text search across all DSH sessions (both past and current).

### Key differences vs dsh-session-search

| Aspect | dsh-session-search (Tieboyh) | dsh-session-search-pro |
|--------|-------------------------------|------------------------|
| **Search method** | Full scan of zstd files on every call | Uses DSH's built-in indexed `sessionQuery` service |
| **Current session** | ❌ Not searchable | ✅ Searchable via `sessionQuery` |
| **Speed** | O(n) full scan, slow with many sessions | O(log n) indexed search |
| **Manual zstd parsing** | ✅ Yes (structural frame scan) | ❌ No — uses the DSH runtime API |
| **External sources** | codex, claude, pi, opencode | DSH only (single runtime) |
| **Tool count** | 2 tools | 3 tools (search + read + list) |
| **Session browser** | ❌ No | ✅ `agent_session_list` with previews |
| **Messages cap** | 4,000 chars | 4,000 chars per message |
| **File size limit** | 64 MB per file | No limit (uses runtime API) |
| **Dependencies** | ripgrep, node:zlib | None (zero external deps) |

## Features

### 3 Agent Tools

| Tool | Description |
|------|-------------|
| **`agent_session_search`** | Full-text search across all DSH sessions. Returns matching sessions with snippets, ranked by relevance. Supports workspace filtering and pagination. |
| **`agent_session_read`** | Read the full content of a specific session by ID. Returns messages, metadata, timestamps. |
| **`agent_session_list`** | List all DSH sessions with optional workspace filter, sort, and preview of the last message. |

### Benefits

- ✅ **Zero external dependencies** — no ripgrep, no zstd parsing, no SQLite
- ✅ **Indexed search** — uses DSH's built-in `sessionQuery.searchSessions()`
- ✅ **Current session searchable** — not just archived sessions
- ✅ **Defensive** — gracefully falls back to `listSessions()` + `filterEvents()` if `searchSessions()` is unavailable
- ✅ **Read-only** — never modifies session data
- ✅ **MIT licensed**

## Installation

### Prerequisites

- DeepSeek Harness (DSH) with `sessionQuery` service available
- Node.js 18+

### Using dshx

```sh
git clone https://github.com/LeslieWylie/dsh-session-search-pro.git
dshx install dsh-session-search-pro ./dsh-session-search-pro
```

### Manual mount

Add to `~/.dsh/config.yaml`:

```yaml
plugins:
  - id: dsh-session-search-pro
    name: /path/to/dsh-session-search-pro/lib/index.js
```

### As a dynamic Cordis Plugin

Use within any DSH session:

```js
// Define and run the plugin
// (Use cordis_define + cordis_run in the DSH web GUI)
```

## Usage

### Search sessions

The agent automatically has access to these tools. When you ask something like:

> "Search my past sessions for anything about 'session search'"
> "What did I discuss about DSH plugins?"
> "Show me all sessions from the Desktop workspace"

The model will use `agent_session_search` to find matching sessions.

### Read a session

> "Read session session-03d68e2e-5bb3 for me"

The model will use `agent_session_read` to fetch and display the session content.

### List sessions

> "List my recent sessions"
> "Show me sessions from the Desktop workspace"

The model will use `agent_session_list` to list and browse sessions.

## Tool Reference

### agent_session_search

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | **required** | Full-text search query (case-insensitive) |
| `limit` | number | 10 | Max results (1-50) |
| `workspace` | string | — | Workspace path substring filter |
| `sort` | enum | `relevance` | `relevance`, `newest`, or `oldest` |
| `includeContent` | boolean | true | Include snippets in results |

### agent_session_read

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sessionId` | string | **required** | Session ID to read |
| `maxMessages` | number | 50 | Max messages (1-200) |
| `includeToolOutput` | boolean | false | Include tool call results |

### agent_session_list

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 20 | Max sessions (1-100) |
| `workspace` | string | — | Workspace path substring filter |
| `sort` | enum | `newest` | `newest` or `oldest` |
| `includePreview` | boolean | true | Include last message preview |

## How it works

The plugin uses the `sessionQuery` service provided by the DSH runtime:

1. **`searchSessions()`** — Full-text indexed search across all sessions (preferred)
2. **`listSessions()`** + **`filterEvents()`** — Fallback when indexed search is unavailable
3. **`readSession()`** — Complete session log extraction
4. **`listSessions()`** — Session metadata listing
5. **`readTitle()`** — Session title resolution
6. **`readSurface()`** — Current model surface (for previews)

All data is read-only. The plugin creates no database, index, or persistent cache of its own.

## Limitations

- **DSH only** — Does not search Codex, Claude Code, PI, or OpenCode sessions (unlike dsh-session-search)
- **Requires sessionQuery** — The plugin gracefully degrades without it, but full-text search requires `sessionQuery.searchSessions()`
- **Process restart** — Dynamic plugins are lost on restart; use manual mount for persistence

## Development

```sh
git clone https://github.com/LeslieWylie/dsh-session-search-pro.git
cd dsh-session-search-pro
# The plugin is pure JavaScript, no build step needed
# Source is in src/index.js, release in lib/index.js
```

## License

MIT © LeslieWylie