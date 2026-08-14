# 🔍 dsh-session-search-pro

**English** | [简体中文](./README.zh-CN.md)

> **Search every DSH session you've ever had — past and current — without leaving the one you're in.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2)](https://github.com/topics/dsh-plugin)

Three agent tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), built on the runtime's own indexed **`sessionQuery`** service instead of scanning session files by hand.

---

## Install

Nothing here is on npm yet, so install straight from GitHub. Add it to your profile's `package.json`:

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-session-search-pro": "github:LeslieWylie/dsh-session-search-pro"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-session-search-pro"]
    }
  }
}
```

Then reinstall and restart the profile:

```sh
cd ~/.dsh/profiles/<profile> && pnpm install
dsh --profile <profile>
```

Pin a tag instead of tracking the default branch with `github:LeslieWylie/dsh-session-search-pro#v0.1.0`.

<details>
<summary>Try it without editing your profile</summary>

The package ships its own `cordis.patch.yml`, so once it's installed into the profile's `node_modules` you can mount it for a single run with the launcher's `--patch` flag instead of touching `dsh.profile.bundles`:

```sh
cd ~/.dsh/profiles/<profile> && pnpm add github:LeslieWylie/dsh-session-search-pro
dsh --profile <profile> --patch ./node_modules/dsh-session-search-pro/cordis.patch.yml
```

</details>

## Why another session-search plugin?

[dsh-session-search](https://github.com/Tieboyh/dsh-session-search) by Tieboyh is well-engineered, but it's **index-free** — every search decompresses and scans zstd session files from scratch. This plugin instead calls the harness's own **`sessionQuery`** service, which already maintains an index across every session, live or archived.

| Aspect | dsh-session-search (Tieboyh) | dsh-session-search-pro |
|--------|-------------------------------|------------------------|
| Search method | Full scan of zstd files on every call | DSH's built-in indexed `sessionQuery` service |
| Current (in-progress) session | ❌ Not searchable | ✅ Searchable via `sessionQuery` |
| Manual zstd parsing | ✅ Yes (structural frame scan) | ❌ No — goes through the harness API only |
| External sources | codex, claude, pi, opencode | DSH only (single runtime) |
| Tool count | 2 tools | 3 tools (search + list + read) |
| Long event text | Capped at 4,000 chars | Capped at 4,000 chars per event |
| Dependencies | ripgrep, node:zlib | None (zero runtime dependencies) |

### Benefits

- ✅ **Zero runtime dependencies** — no ripgrep, no zstd parsing, no local database
- ✅ **Indexed search** — full-text ranking via `sessionQuery.searchSessions()`, not a linear scan
- ✅ **Current session is searchable** — not just sessions that have already ended
- ✅ **Fails closed, not half-open** — if `sessionQuery` isn't available at all, the plugin logs a warning and registers no tools, rather than registering tools that would throw on first use
- ✅ **Read-only** — never writes to a session; no database or cache of its own
- ✅ **MIT licensed**

## Usage

The agent has access to these tools automatically once the plugin is bundled. Ask things like:

> "Search my past sessions for anything about session search"
> "List my recent sessions in ~/Desktop"
> "Read session a4d75296-fc89-44b1 for me"

and the model reaches for `agent_session_search`, `agent_session_list`, or `agent_session_read` on its own.

## Tool reference

### `agent_session_search`

Full-text search across all DSH sessions, ranked by relevance, each hit carrying its best-matching snippet.

| Parameter | Type | Required | Description |
|-----------|------|----------|--------------|
| `query` | string | ✅ | Full-text search query (case-insensitive). Matched against session event content. |
| `limit` | number | — | Maximum sessions to return, 1–50. Defaults to the plugin's `maxResults` config (10 unless overridden). |

### `agent_session_list`

Lists sessions — past and current — with an optional working-directory filter, sorted newest- or oldest-first.

| Parameter | Type | Required | Description |
|-----------|------|----------|--------------|
| `limit` | number | — | Maximum sessions to return, 1–100. Default 20. |
| `cwd` | string | — | Substring filter over the session's working directory. |
| `sort` | `"newest"` \| `"oldest"` | — | Sort order. Default `newest`. |

### `agent_session_read`

Reads one session by id: title, metadata, and its events in order.

| Parameter | Type | Required | Description |
|-----------|------|----------|--------------|
| `sessionId` | string | ✅ | The session id to read, e.g. `"a4d75296-fc89-44b1"`. |
| `maxEvents` | number | — | Maximum events to return, most recent first, 1–200. Default 50. |

## Plugin config

Set in the bundle row of `cordis.patch.yml` (or your own patch overlay):

| Key | Default | Description |
|-----|---------|--------------|
| `maxResults` | `10` | Default `limit` for `agent_session_search` when the caller omits it. |

## How it works

The plugin is a thin layer over five methods on the harness's `sessionQuery` service — no parsing, no indexing, no cache of its own:

- **`searchSessions()`** — ranked full-text search across all sessions; backs `agent_session_search`.
- **`listSessions()`** — the full session list in deterministic newest-first order; backs `agent_session_list`.
- **`filterSessions()`** — a safe existence check by id (returns `[]` rather than throwing for an unknown id); used by `agent_session_read` before it tries to fetch content.
- **`filterEvents()`** — flat, pre-extracted per-event text; backs `agent_session_read`'s event content.
- **`readTitle()`** / **`readTitleSnapshots()`** — single and batched title resolution. Session headers carry no title field of their own, so every tool that shows a title resolves it separately through one of these.

All access is read-only. The plugin creates no database, index, or persistent cache of its own — it reads whatever `sessionQuery` already maintains.

## Limitations

- **DSH only** — does not search Codex, Claude Code, PI, or OpenCode sessions (unlike dsh-session-search).
- **Requires `sessionQuery`** — all three tools depend on it; there's no reduced-functionality mode. If the service isn't injected, the plugin registers nothing rather than registering tools that would fail.
- **`agent_session_read`'s event fetch has no cancellation support** — `filterEvents()` doesn't accept an abort signal in the underlying service, so an aborted read still finishes fetching before its result is discarded.

## Development

Pure JavaScript, no build step. Source and release are the same file: `lib/index.js`.

```sh
git clone https://github.com/LeslieWylie/dsh-session-search-pro.git
cd dsh-session-search-pro
pnpm install
npm test   # runs tests/tools.test.mjs — imports lib/index.js and executes it
           # against a stubbed sessionQuery; not a source-text/regex check
```

## License

MIT © LeslieWylie
