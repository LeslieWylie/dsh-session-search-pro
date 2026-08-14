// Executes the real module against a stub ctx/sessionQuery — not a source-text
// regex check. Run with: node tests/tools.test.mjs
// (requires `pnpm install` first: `@deepseek-ai/dsh-tools` is a peerDependency,
// pulled in for real via devDependencies so `defineTool`'s actual argument
// validation — not a hand-rolled stub — runs during the test.)

import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'

let passed = 0
let failed = 0

function test(label, fn) {
  return (async () => {
    try {
      await fn()
      passed++
      console.log(`  ok — ${label}`)
    } catch (error) {
      failed++
      console.log(`  FAIL — ${label}`)
      console.log(`    ${error.message}`)
    }
  })()
}

function makeCtx(sessionQuery) {
  const registered = new Map()
  const ctx = {
    logger: { warn() {}, info() {} },
    tools: {
      register(def) {
        registered.set(def.name, def)
      },
    },
    sessionQuery,
  }
  return { ctx, registered }
}

// A signal object distinct from `{signal}` wrappers, so tests can assert
// which calling convention each stub method actually received.
const RAW_SIGNAL = { marker: 'raw-signal' }
const EXEC = { signal: RAW_SIGNAL }

function header(id, overrides = {}) {
  return { id, createdAt: 1_700_000_000_000, ...overrides }
}

async function main() {
  console.log(`module: name=${JSON.stringify(name)} inject=${JSON.stringify(inject)}`)

  await test('exports the expected plugin name and injects sessionQuery + tools', () => {
    assert.equal(name, 'dsh-session-search-pro')
    assert.deepEqual(inject, ['tools', 'sessionQuery'])
  })

  await test('registers nothing and does not throw when sessionQuery is absent', () => {
    const { ctx, registered } = makeCtx(undefined)
    apply(ctx)
    assert.equal(registered.size, 0)
  })

  // ── shared fixture: apply() once against a fully-stubbed sessionQuery ──
  //
  // Every method below exists on the real SessionQuery service. That is not a
  // stylistic rule, it is the whole point: an earlier version of this plugin
  // called `sq.searchSessions(...)`, this fixture obligingly provided a
  // `searchSessions` stub, every test passed, and the tool returned
  // "sq.searchSessions is not a function" on every real invocation for the
  // entire life of the release. A stub you write yourself will confirm your own
  // misconception. `tests/boot.test.mjs` is the guard that cannot: it checks
  // these names against the service the harness actually ships.
  const calls = []
  const EVENTS = {
    's-1': [
      { seq: 0, type: 'user/message', time: 1_700_000_000_500, surface: 'current', text: 'hello' },
      { seq: 4, type: 'assistant/message', time: 1_700_000_100_000, surface: 'current', text: 'I found it here in the log' },
      { seq: 5, type: 'assistant/message', time: 1_700_000_200_000, surface: 'current', text: 'x'.repeat(5000) },
    ],
    's-2': [
      { seq: 0, type: 'user/message', time: 1_700_000_500_000, surface: 'current', text: 'nothing relevant' },
    ],
  }
  const sessionQuery = {
    async listSessions(signal) {
      calls.push(['listSessions', signal])
      return [
        { header: header('s-1', { cwd: '/home/alice/project', createdAt: 1_700_000_000_000 }), live: true, persisted: false },
        { header: header('s-2', { cwd: '/home/alice/other', createdAt: 1_700_000_500_000 }), live: false, persisted: true },
      ]
    },
    async filterSessions(filters, signal) {
      calls.push(['filterSessions', filters, signal])
      const wanted = filters[0]?.values?.[0]
      if (wanted === 's-1') return [{ header: header('s-1', { cwd: '/home/alice/project' }), live: true, persisted: false }]
      return []
    },
    async readTitleSnapshots(ids, signal) {
      calls.push(['readTitleSnapshots', ids, signal])
      return ids.map((sessionId) => (
        sessionId === 's-1'
          ? { sessionId, status: 'fulfilled', value: { session: header(sessionId), title: { title: 'Session One' } } }
          : { sessionId, status: 'fulfilled', value: { session: header(sessionId) } } // no title event yet
      ))
    },
    async readTitle(sessionId, signal) {
      calls.push(['readTitle', sessionId, signal])
      return sessionId === 's-1' ? { title: 'Session One' } : undefined
    },
    async filterEvents(sessionId, filters) {
      calls.push(['filterEvents', sessionId, filters])
      if (sessionId === 'boom') throw new Error('backend unavailable')
      const events = (EVENTS[sessionId] ?? []).map((e) => ({ sessionId, ...e }))
      const text = filters.find((f) => f.kind === 'text')?.text
      if (text === undefined) return events
      // The real filter is literal, case-insensitive and whitespace-flexible:
      // metacharacters are escaped before the pattern is built. Reproduced
      // faithfully — a stub that forgot the escaping would report that this
      // plugin has an injection hole it does not have (or hide one it does).
      const re = new RegExp(
        text.trim().split(/\s+/u).map((p) => p.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+'),
        'iu',
      )
      return events.filter((e) => re.test(e.text))
    },
  }

  const { ctx, registered } = makeCtx(sessionQuery)
  apply(ctx, { maxResults: 5 })

  await test('registers exactly the three documented tools', () => {
    assert.deepEqual([...registered.keys()].sort(), ['agent_session_list', 'agent_session_read', 'agent_session_search'])
  })

  await test('every tool.output.render returns a ContentBlock[] of {type:"text"}, not a bare {type:"json"} object', () => {
    for (const def of registered.values()) {
      const value = { a: 1 }
      const blocks = def.output.render({}, value)
      assert.ok(Array.isArray(blocks), `${def.name}: render() must return an array`)
      assert.equal(blocks.length, 1)
      assert.equal(blocks[0].type, 'text')
      assert.equal(blocks[0].text, JSON.stringify(value, null, 2))
    }
  })

  // ── agent_session_search ──
  const search = registered.get('agent_session_search')

  await test('session_search: rejects a present-but-blank query without calling the backend', async () => {
    calls.length = 0
    const result = await search.execute({ query: '  ' }, EXEC)
    assert.deepEqual(result, { error: 'query is required' })
    assert.equal(calls.length, 0)
  })

  // `query` is declared `required: true`, and defineTool's own wrapper validates
  // required-property *presence* before our execute() ever runs — so an entirely
  // missing key throws, while a present-but-empty string reaches our own guard
  // above. Both cases matter and are asserted separately; see the identical note
  // by agent_session_read below.
  await test('session_search: omitting query entirely throws ToolArgsError (framework validation, before our code runs)', async () => {
    calls.length = 0
    await assert.rejects(
      () => search.execute({}, EXEC),
      (error) => error instanceof ToolArgsError && /query/.test(error.message),
    )
    assert.equal(calls.length, 0)
  })

  // ── the index fast path, and the fallback that makes it safe ──
  //
  // The stock `dsh-base` bundle wires the SQLite backend with `openAt: 'never'`,
  // so `searchSessions` exists but throws SESSION_QUERY_SEARCH_DISABLED. An
  // earlier release called it unconditionally and returned that config error as
  // the search result, which is why the tool never found anything on a default
  // install while looking perfectly healthy.
  const DISABLED = Object.assign(new Error('session search is disabled: this deployment configures the session-query index with openAt "never"'),
    { code: 'SESSION_QUERY_SEARCH_DISABLED' })

  const withSearch = (searchSessions) => {
    const { ctx: c, registered: r } = makeCtx({ ...sessionQuery, searchSessions })
    apply(c)
    return r.get('agent_session_search')
  }

  await test('search: uses the index when the deployment has one enabled', async () => {
    const tool = withSearch(async (request, exec) => {
      assert.equal(request.query, 'found it')
      assert.deepEqual(exec, { signal: RAW_SIGNAL }, 'searchSessions takes an {signal} object, not a raw signal')
      return {
        items: [{
          header: header('s-1', { cwd: '/home/alice/project' }), live: true, persisted: false,
          bestMatch: { sessionId: 's-1', seq: 4, type: 'user/message', time: 1_700_000_100_000, surface: 'current', snippet: 'found it here' },
        }],
        nextCursor: undefined,
      }
    })
    const result = await tool.execute({ query: 'found it' }, EXEC)
    assert.equal(result.engine, 'index')
    assert.equal(result.total, 1)
    assert.equal(result.sessions[0].snippet, 'found it here')
  })

  await test('search: falls back to a scan when the index is disabled — the default-profile case', async () => {
    const tool = withSearch(async () => { throw DISABLED })
    const result = await tool.execute({ query: 'found it' }, EXEC)
    assert.equal(result.engine, 'scan', 'a disabled index must not become the answer')
    assert.equal(result.error, undefined, 'the config error must never be returned as the search result')
    assert.equal(result.total, 1)
    assert.equal(result.sessions[0].sessionId, 's-1')
  })

  await test('search: falls back when the backend has no searchSessions at all', async () => {
    const result = await search.execute({ query: 'found it' }, EXEC) // base fixture: no searchSessions
    assert.equal(result.engine, 'scan')
    assert.equal(result.total, 1)
  })

  await test('search: a genuinely broken index is reported, not silently rescanned', async () => {
    const tool = withSearch(async () => { throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }) })
    const result = await tool.execute({ query: 'found it' }, EXEC)
    assert.equal(result.error, 'disk I/O error')
    assert.equal(result.engine, undefined, 'a broken store must not be answered with a slower scan of itself')
  })

  await test('session_search: only ever calls methods that exist on the real service', async () => {
    calls.length = 0
    await search.execute({ query: 'anything' }, EXEC)
    const used = new Set(calls.map(([op]) => op))
    for (const op of used) {
      assert.ok(op in sessionQuery, `called sq.${op}(), which is not a real SessionQuery method`)
    }
    assert.ok(used.has('listSessions') && used.has('filterEvents'))
  })

  await test('session_search: finds the matching session and snippets around the hit', async () => {
    const result = await search.execute({ query: 'found it' }, EXEC)
    assert.equal(result.total, 1)
    assert.equal(result.truncated, false)
    assert.equal(result.scanned, 2, 'both sessions are opened when neither limit is reached')
    const [s] = result.sessions
    assert.equal(s.sessionId, 's-1')
    assert.equal(s.title, 'Session One')
    assert.equal(s.cwd, '/home/alice/project')
    assert.match(s.snippet, /found it here/)
    assert.equal(s.matchedEventSeq, 4)
    assert.equal(s.matches, 1)
  })

  await test('session_search: a query matching nothing returns an empty result, not an error', async () => {
    const result = await search.execute({ query: 'no-such-text-anywhere' }, EXEC)
    assert.deepEqual(result.sessions, [])
    assert.equal(result.total, 0)
    assert.equal(result.error, undefined)
  })

  await test('session_search: the query is matched literally — regex metacharacters cannot inject', async () => {
    const result = await search.execute({ query: 'f.und it' }, EXEC)
    assert.equal(result.total, 0, '"." must not act as a wildcard')
  })

  await test('session_search: whitespace between words is flexible', async () => {
    const result = await search.execute({ query: 'found    it' }, EXEC)
    assert.equal(result.total, 1)
  })

  await test('session_search: stops opening sessions once maxScan is hit and says so', async () => {
    const result = await search.execute({ query: 'found it', maxScan: 1 }, EXEC)
    assert.equal(result.scanned, 1)
    assert.equal(result.truncated, true, 'a bounded scan must not look exhaustive')
  })

  await test('session_search: one unreadable session does not sink the whole search', async () => {
    const broken = {
      ...sessionQuery,
      async listSessions() {
        return [
          { header: header('boom'), live: true, persisted: false },
          { header: header('s-1', { cwd: '/home/alice/project' }), live: true, persisted: false },
        ]
      },
    }
    const { ctx: c2, registered: r2 } = makeCtx(broken)
    apply(c2)
    const result = await r2.get('agent_session_search').execute({ query: 'found it' }, EXEC)
    assert.equal(result.total, 1, 'the readable session is still returned')
    assert.equal(result.sessions[0].sessionId, 's-1')
  })

  await test('session_search: a listing failure becomes {error}, not an unhandled rejection', async () => {
    const broken = { ...sessionQuery, async listSessions() { throw new Error('backend unavailable') } }
    const { ctx: c2, registered: r2 } = makeCtx(broken)
    apply(c2)
    const result = await r2.get('agent_session_search').execute({ query: 'x' }, EXEC)
    assert.equal(result.error, 'backend unavailable')
  })

  // ── agent_session_list ──
  const list = registered.get('agent_session_list')

  await test('session_list: passes the raw signal (no exec-context wrapper) to listSessions', async () => {
    calls.length = 0
    await list.execute({}, EXEC)
    const [, signal] = calls.find(([op]) => op === 'listSessions')
    assert.equal(signal, RAW_SIGNAL)
  })

  await test('session_list: filters by cwd substring and resolves an untitled session correctly', async () => {
    const result = await list.execute({ cwd: 'other' }, EXEC)
    assert.equal(result.total, 1)
    assert.equal(result.sessions[0].sessionId, 's-2')
    assert.equal(result.sessions[0].title, '(untitled)')
  })

  await test('session_list: sort=oldest reverses the newest-first backend order', async () => {
    const result = await list.execute({ sort: 'oldest' }, EXEC)
    assert.deepEqual(result.sessions.map((s) => s.sessionId), ['s-2', 's-1'])
  })

  await test('session_list: limit is clamped into [1, 100]', async () => {
    const result = await list.execute({ limit: 0 }, EXEC)
    assert.equal(result.sessions.length, 1) // clamped to 1, then capped by the 2-item fixture
  })

  // ── agent_session_read ──
  const read = registered.get('agent_session_read')

  // `sessionId` is declared `required: true`. defineTool's own execute wrapper
  // validates the compiled JSON Schema *before* calling our execute() body, and
  // `required` only checks key presence — so an entirely absent key throws a
  // framework-level ToolArgsError that our own `if (!sessionId)` guard never
  // gets a chance to run for. That guard is still load-bearing for the other
  // case JSON-Schema `required` can't catch: a key that's present but blank.
  await test('session_read: omitting sessionId entirely throws ToolArgsError (framework validation, before our code runs)', async () => {
    await assert.rejects(
      () => read.execute({}, EXEC),
      (error) => error instanceof ToolArgsError && /sessionId/.test(error.message),
    )
  })

  await test('session_read: a present-but-blank sessionId reaches our own guard and returns a clean error', async () => {
    const result = await read.execute({ sessionId: '   ' }, EXEC)
    assert.deepEqual(result, { error: 'sessionId is required' })
  })

  await test('session_read: an unknown session id comes back as a clean error, not a thrown exception', async () => {
    const result = await read.execute({ sessionId: 'does-not-exist' }, EXEC)
    assert.equal(result.error, 'No session found with id "does-not-exist"')
  })

  await test('session_read: reads title (flat .title, not the batched .value.title.title shape) and truncates long event text', async () => {
    const result = await read.execute({ sessionId: 's-1' }, EXEC)
    assert.equal(result.title, 'Session One')
    assert.equal(result.cwd, '/home/alice/project')
    assert.equal(result.totalEvents, 3)
    assert.equal(result.events.length, 3)
    assert.equal(result.events[0].text, 'hello')
    assert.equal(result.events[2].text.length, 4001) // 4000 chars + the truncation marker
    assert.ok(result.events[2].text.endsWith('…'))
  })

  await test('session_read: maxEvents keeps the most recent N events', async () => {
    const result = await read.execute({ sessionId: 's-1', maxEvents: 1 }, EXEC)
    assert.equal(result.events.length, 1)
    assert.equal(result.events[0].seq, 5)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

await main()
