// Boot test — the guard that a self-written stub cannot be.
//
// This plugin once shipped a tool that called `sq.searchSessions(...)`. No such
// method has ever existed on the harness's SessionQuery service. The unit-test
// fixture defined its own `searchSessions` stub, so every test passed while the
// tool returned "sq.searchSessions is not a function" on every real call — for
// the entire life of that release. Nothing threw; the error was caught and
// returned as data, so even manual use just looked like "no results".
//
// Two things here that tests against a hand-written double cannot do:
//   1. Check every `sq.<method>()` call site in lib/index.js against the methods
//      the *shipped* service actually has.
//   2. Boot a real cordis Context, load this package the way a profile does, and
//      execute the tool through the real registry.
//
// Needs the harness packages, so it exits 0 (skipped) from a bare clone.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const require_ = createRequire(import.meta.url)

const REQUIRED = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt',
                  '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-query']
for (const pkg of REQUIRED) {
  try { require_.resolve(pkg) } catch {
    console.log(`SKIP boot test — ${pkg} is not resolvable from here.`)
    console.log('Run it from inside an installed profile:')
    console.log('  cd ~/.dsh/profiles/<profile>/node_modules/dsh-session-search-pro && node tests/boot.test.mjs')
    process.exit(0)
  }
}

let passed = 0
let failed = 0
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log(`  ok — ${label}`) }
  else { failed += 1; console.log(`  FAIL — ${label}${detail === undefined ? '' : `\n    ${detail}`}`) }
}

const { Context } = await import('@deepseek-ai/cordis')

const ctx = new Context()
const warnings = []
ctx.on('internal/warning', (...args) => warnings.push(args.map(String).join(' ')))

for (const pkg of ['@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-fs-local',
                   '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-query']) {
  const mod = await import(pkg)
  await ctx.plugin(mod.default ?? mod, {})
}
await new Promise((resolve) => setTimeout(resolve, 400))

console.log('\n--- the services this plugin declares in `inject` ---')
check('ctx.tools is a real service', ctx.get('tools') !== undefined)
check('ctx.sessionQuery is a real service', ctx.get('sessionQuery') !== undefined,
  'dsh-session-query provides `sessionQuery` only once `sessions` exists — load dsh-session first')

// ── 1. every method this plugin calls must exist on the shipped service ──
//
// Except the ones it guards. `searchSessions` lives on the SQLite backend only,
// and this plugin calls it behind a `typeof sq.searchSessions === 'function'`
// check with a fallback — so its absence is fine. An *unguarded* call to a
// method the service does not have is the bug this whole file exists to catch.
console.log('\n--- API conformance against the shipped SessionQuery ---')
const source = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const called = [...new Set([...source.matchAll(/\bsq\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))].sort()
const guarded = new Set([...source.matchAll(/typeof\s+sq\.([A-Za-z_$][\w$]*)\s*===\s*'function'/g)].map((m) => m[1]))
const service = ctx.get('sessionQuery')
const realMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(service))
  .filter((n) => n !== 'constructor' && !n.startsWith('_')).sort()

check('the plugin calls at least one sessionQuery method', called.length > 0, `found: ${called.join(', ')}`)
for (const method of called.filter((m) => !guarded.has(m))) {
  check(`sq.${method}() exists on the real service (called unguarded)`, typeof service[method] === 'function',
    `not a function. Real methods: ${realMethods.join(', ')}`)
}
for (const method of called.filter((m) => guarded.has(m))) {
  check(`sq.${method}() is optional and properly guarded before use`, true,
    `present here: ${typeof service[method] === 'function'}`)
}

// A guard is only honest if the method exists *somewhere*. If `searchSessions`
// were a pure invention, every profile would silently take the fallback forever
// and the fast path would be dead code that no test ever notices.
for (const method of called.filter((m) => guarded.has(m))) {
  let found = false
  try {
    const sqlite = await import('@deepseek-ai/dsh-session-query-sqlite')
    const engine = Object.values(sqlite).find((v) => typeof v === 'function' && v.prototype?.[method])
    found = engine !== undefined
  } catch { /* backend not installed here — cannot judge */ }
  check(`sq.${method}() is a real method on some shipped backend, not an invention`, found,
    '@deepseek-ai/dsh-session-query-sqlite is not resolvable here, so this could not be confirmed')
}


// ── 2. the plugin registers, through a real Context ──
console.log('\n--- load this package the way a profile does ---')
const plugin = await import('../lib/index.js')
await ctx.plugin(plugin, {})
await new Promise((resolve) => setTimeout(resolve, 800))

for (const tool of ['agent_session_search', 'agent_session_list', 'agent_session_read']) {
  check(`${tool} is in the real tool registry`, ctx.tools.get(tool) !== undefined,
    `registry holds: ${(ctx.tools.schemas() || []).map((s) => s.name).join(', ') || '(nothing)'}`)
}

// ── 3. execute through the real registry ──
//
// With no persistence service loaded the corpus is empty, and that is exactly
// the case that catches the original bug: a search over zero sessions must come
// back `{sessions: [], total: 0}`. The broken build returned
// `{error: "sq.searchSessions is not a function"}` here, because the failure was
// caught and handed back as data rather than thrown.
console.log('\n--- execute through the real registry ---')
const run = async (name, args) => {
  const controller = new AbortController()
  const result = await ctx.tools.execute({ name, arguments: args, callId: `boot-${name}`, signal: controller.signal })
  return result.value ?? result
}

const search = await run('agent_session_search', { query: 'anything at all' })
check('search does not report an error', search.error === undefined, JSON.stringify(search))
check('search returns an array of sessions', Array.isArray(search.sessions), JSON.stringify(search))
check('search echoes the query back', search.query === 'anything at all')
check('search reports how many sessions it opened', typeof search.scanned === 'number')

const blank = await run('agent_session_search', { query: '   ' })
check('a blank query is refused by the tool, not the backend', blank.error === 'query is required')

const listed = await run('agent_session_list', { limit: 3 })
check('list does not report an error', listed.error === undefined, JSON.stringify(listed))
check('list returns an array of sessions', Array.isArray(listed.sessions))

const missing = await run('agent_session_read', { sessionId: 'no-such-session-id' })
check('reading an unknown id is a clean error, not a raw exception',
  typeof missing.error === 'string' && /no session found/i.test(missing.error), JSON.stringify(missing))

if (warnings.length > 0) console.log(`\ncontext warnings: ${warnings.length}\n  ${warnings.slice(0, 3).join('\n  ')}`)
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
