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

[dsh-session-search](https://github.com/Tieboyh/dsh-session-search) by Tieboyh
takes a different route: it reads session files directly, decompressing and
scanning zstd frames itself, which lets it search **other runtimes' sessions
too** — Codex, Claude Code, PI, OpenCode. If you work across several agent CLIs,
that is the one you want.

This plugin goes through the harness's own `sessionQuery` service instead. That
buys the live in-progress session, no file-format assumptions, and no external
binaries — and it means the plugin inherits whatever indexing the deployment has
configured, including none (see
[Search on a stock profile](#search-on-a-stock-profile)).

| Aspect | dsh-session-search (Tieboyh) | dsh-session-search-pro |
|--------|-------------------------------|------------------------|
| Search method | Reads and scans session files directly | Harness `sessionQuery` — FTS5 index when enabled, bounded scan otherwise |
| Current (in-progress) session | ❌ Not searchable | ✅ Searchable |
| Session file format | Parsed directly (zstd frame scan) | Never touched — harness API only |
| External sources | codex, claude, pi, opencode | DSH only (single runtime) |
| Tool count | 2 tools | 3 tools (search + list + read) |
| Long event text | Capped at 4,000 chars | Capped at 4,000 chars per event |
| Dependencies | ripgrep, node:zlib | None (zero runtime dependencies) |

### Benefits

- ✅ **Zero runtime dependencies** — no ripgrep, no zstd parsing, no local database
- ✅ **Works on a stock profile** — uses the FTS5 index when the deployment enables it, and falls back to a bounded scan when it does not, instead of returning a configuration error as the search result
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

Full-text search across all DSH sessions, each hit carrying its best-matching snippet.

Two engines, picked automatically — see [Search on a stock profile](#search-on-a-stock-profile).

| Parameter | Type | Required | Description |
|-----------|------|----------|--------------|
| `query` | string | ✅ | Text to find. Case-insensitive, whitespace-flexible, and matched **literally** — regex metacharacters have no special meaning. |
| `limit` | number | — | Maximum sessions to return, 1–50. Defaults to the plugin's `maxResults` config (10 unless overridden). |
| `maxScan` | number | — | Maximum sessions to open when falling back to a scan, 1–500. Defaults to the plugin's `maxScan` config (200). Ignored when the index is in use. |

The result carries `engine: "index" | "scan"` so you can tell which path answered, plus `scanned` and `truncated` on the scan path.

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
| `maxScan` | `200` | Default `maxScan` for `agent_session_search` — how many sessions the fallback scan may open. |

## Search on a stock profile

`agent_session_search` has two engines and picks one at call time.

**The index.** `@deepseek-ai/dsh-session-query-sqlite` is the concrete `sessionQuery`
backend in the stock `dsh-base` bundle, and it exposes a `searchSessions()` backed by
SQLite FTS5. When it is available, this plugin uses it and returns `engine: "index"`.

**But it is off by default.** `dsh-base` wires that backend as:

```yaml
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: ':memory:'
    openAt: never
```

and the engine's own guard throws `SESSION_QUERY_SEARCH_DISABLED` whenever
`openAt` is `never`. Content search is opt-in: a deployment turns it on by
overriding `openAt` to `first-search` or `startup` in a later patch layer,
normally with a durable `path`.

So on a stock profile the index call fails. This plugin catches exactly that
error and falls back to scanning sessions newest-first through `listSessions()`
and `filterEvents()` — primitives every `sessionQuery` backend has — and returns
`engine: "scan"`. A failure that is *not* an unavailable index (a real backend
fault) is reported as an error instead, because answering a broken store with a
slower scan of the same broken store helps nobody.

Measured against a real 24-session corpus on this machine:

| | index (`openAt: first-search`) | scan (stock `openAt: never`) |
|---|---|---|
| term that matches | 3 hits | 3 hits |
| term that matches nothing | 17 ms | 3,042 ms |

The index is worth having — that is why the fast path exists. It just cannot be
the only path, and versions of this plugin up to and including 0.1.0 assumed it
was. On every default install they returned
`{"error": "session search is disabled…"}` for every query. Nothing threw, so it
looked like a working tool that simply never found anything.

To turn the index on, override the bundle row in your profile's
`cordis.patch.yml`:

```yaml
- update:
    id: session-query-sqlite
    config:
      path: '~/.dsh/session-index.db'
      openAt: first-search
```

## How it works

The plugin is a thin layer over the harness's `sessionQuery` service — no parsing, no indexing, no cache of its own:

- **`searchSessions()`** — FTS5 full-text search; backs the `engine: "index"` path of `agent_session_search`. **Optional**: present only on the SQLite backend, and only usable when that backend has search enabled. Always called behind a capability check.
- **`listSessions()`** — the full session list in deterministic newest-first order; backs `agent_session_list` and the `engine: "scan"` fallback.
- **`filterEvents()`** — flat, pre-extracted per-event text; backs `agent_session_read`'s event content and, with a `text` filter, the scan fallback's matching.
- **`filterSessions()`** — a safe existence check by id (returns `[]` rather than throwing for an unknown id); used by `agent_session_read` before it tries to fetch content.
- **`readTitle()`** / **`readTitleSnapshots()`** — single and batched title resolution. Session headers carry no title field of their own, so every tool that shows a title resolves it separately through one of these.

All access is read-only. The plugin creates no database, index, or persistent cache of its own — it reads whatever `sessionQuery` already maintains.

## Limitations

- **DSH only** — does not search Codex, Claude Code, PI, or OpenCode sessions (unlike dsh-session-search).
- **Requires `sessionQuery`** — all three tools depend on it; there's no reduced-functionality mode. If the service isn't injected, the plugin registers nothing rather than registering tools that would fail.
- **The scan fallback opens sessions one at a time.** `filterEvents()` works per-session and reads that session's whole log, so a search with no matches walks the corpus. `maxScan` bounds it, and `truncated: true` tells you when the bound was hit. Enable the index if your corpus is large.
- **`agent_session_read`'s event fetch has no cancellation support** — `filterEvents()` doesn't accept an abort signal in the underlying service, so an aborted read still finishes fetching before its result is discarded.

## Development

Pure JavaScript, no build step. Source and release are the same file: `lib/index.js`.

```sh
git clone https://github.com/LeslieWylie/dsh-session-search-pro.git
cd dsh-session-search-pro
pnpm install
npm test
```

Two suites, both of which execute the real `lib/index.js` — neither is a
source-text or regex check:

- **`tests/tools.test.mjs`** drives `apply()` against a stubbed `sessionQuery`,
  covering both engines, the fallback, and the argument-validation paths.
- **`tests/boot.test.mjs`** boots a real cordis `Context`, loads the harness's
  own session services, loads this package the way a profile does, and executes
  the tools through the **real** tool registry.

The second one exists because of how 0.1.0 shipped broken. Its search tool called
`sq.searchSessions(...)` unconditionally; the unit-test fixture defined its own
`searchSessions` stub, so every test passed, while on a stock profile the call
threw `SESSION_QUERY_SEARCH_DISABLED` and the tool returned that config error as
its answer to every query. **A stub you write yourself will confirm your own
misconception.** So `boot.test.mjs` checks every `sq.<method>()` call site in the
source against the service the harness actually ships — requiring unguarded calls
to exist, allowing guarded ones to be absent, and separately confirming that a
guarded method is real on *some* shipped backend rather than an invention that
would leave the fast path as dead code.

It needs the harness packages, so it exits 0 (skipped) from a bare clone. To
actually run it:

```sh
cd ~/.dsh/profiles/<profile>/node_modules/dsh-session-search-pro && node tests/boot.test.mjs
```

## License

MIT © LeslieWylie
