import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-session-search-pro'
export const inject = ['tools', 'sessionQuery']

const asJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi)

// `Number(x) || fallback` looks right but silently discards an explicit `0`
// (0 is falsy in JS), substituting the default instead of clamping the literal
// value. This only falls back when the input is genuinely absent or unusable.
const numberOr = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const errorText = (error) => String(error && error.message ? error.message : error)

const toIso = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : '')

// `readTitleSnapshots` batches like `Promise.allSettled`: each entry carries the
// requested `sessionId` plus either `{status:'fulfilled', value:{title?}}` or
// `{status:'rejected', reason}`. `value.title` is itself optional (a session with
// no title event yet) and, when present, is an object whose *own* `.title` field
// is the actual string — the double nesting is real, not a typo.
const titleOf = (result) => (result.status === 'fulfilled' ? result.value.title?.title : undefined)

const sessionSummary = (record, titleById) => ({
  sessionId: record.header.id,
  title: titleById.get(record.header.id) || '(untitled)',
  cwd: record.header.cwd ?? '',
  createdAt: toIso(record.header.createdAt),
  live: record.live,
  persisted: record.persisted,
})

export function apply(ctx, config = {}) {
  const sq = ctx.sessionQuery
  if (sq === undefined) {
    ctx.logger?.warn('dsh-session-search-pro: no sessionQuery service; tools will not register')
    return
  }

  const defaultLimit = Number.isInteger(config.maxResults) && config.maxResults > 0 ? config.maxResults : 10

  // Batch-resolve titles for a set of session ids in one call instead of one
  // request per session — mirrors how the first-party session-query tool does it.
  const titleMapFor = async (ids, signal) => {
    if (ids.length === 0) return new Map()
    const results = await sq.readTitleSnapshots(ids, signal)
    return new Map(results.map((result) => [result.sessionId, titleOf(result)]))
  }

  ctx.tools.register(defineTool({
    name: 'agent_session_search',
    description: 'Full-text search across all DSH sessions, past and current. '
      + 'Returns matching sessions ranked by relevance, each with the strongest-matching snippet.',
    parameters: {
      query: { type: 'string', required: true, description: 'Full-text search query (case-insensitive). Matched against session event content.' },
      limit: { type: 'number', description: `Maximum sessions to return, 1-50 (default ${defaultLimit}).` },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessions: { type: 'array' },
          total: { type: 'number' },
          truncated: { type: 'boolean' },
          query: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: asJson,
    },
    async execute(args, exec) {
      const query = String(args.query ?? '').trim()
      if (!query) return { error: 'query is required' }
      const limit = clamp(numberOr(args.limit, defaultLimit), 1, 50)

      let page
      try {
        // searchSessions takes an `{signal}` exec-context object, NOT a raw
        // AbortSignal — passing exec.signal directly here would silently
        // disable cancellation instead of throwing.
        page = await sq.searchSessions({ query, limit }, { signal: exec.signal })
      } catch (error) {
        return { error: errorText(error), query }
      }

      const items = page.items ?? []
      if (items.length === 0) return { sessions: [], total: 0, query }

      const titleById = await titleMapFor(items.map((hit) => hit.header.id), exec.signal)
      const sessions = items.map((hit) => ({
        ...sessionSummary(hit, titleById),
        snippet: hit.bestMatch.snippet,
        matchedEventSeq: hit.bestMatch.seq,
        matchedAt: toIso(hit.bestMatch.time),
      }))

      return { sessions, total: sessions.length, truncated: page.nextCursor !== undefined, query }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_session_list',
    description: 'List DSH sessions (past and current) with optional working-directory filter, sorted newest or oldest first.',
    parameters: {
      limit: { type: 'number', description: 'Maximum sessions to return, 1-100 (default 20).' },
      cwd: { type: 'string', description: 'Optional substring filter over the session working directory.' },
      sort: { type: 'string', enum: ['newest', 'oldest'], description: 'Sort order (default newest).' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessions: { type: 'array' },
          total: { type: 'number' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: asJson,
    },
    async execute(args, exec) {
      let records
      try {
        // listSessions is documented as returning deterministic newest-first order.
        records = await sq.listSessions(exec.signal)
      } catch (error) {
        return { error: errorText(error) }
      }

      let filtered = records
      if (args.cwd) {
        const needle = String(args.cwd).toLowerCase()
        filtered = filtered.filter((record) => (record.header.cwd ?? '').toLowerCase().includes(needle))
      }
      if (args.sort === 'oldest') filtered = filtered.slice().reverse()

      const limit = clamp(numberOr(args.limit, 20), 1, 100)
      const top = filtered.slice(0, limit)
      if (top.length === 0) return { sessions: [], total: filtered.length }

      const titleById = await titleMapFor(top.map((record) => record.header.id), exec.signal)
      return {
        sessions: top.map((record) => sessionSummary(record, titleById)),
        total: filtered.length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_session_read',
    description: 'Read the text content of a specific DSH session by id: title, metadata, and its events in order.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'The session id to read, e.g. "a4d75296-fc89-44b1".' },
      maxEvents: { type: 'number', description: 'Maximum events to return, most recent first, 1-200 (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          createdAt: { type: 'string' },
          totalEvents: { type: 'number' },
          events: { type: 'array' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: asJson,
    },
    async execute(args, exec) {
      const sessionId = String(args.sessionId ?? '').trim()
      if (!sessionId) return { error: 'sessionId is required' }

      let header
      try {
        // A plain existence + metadata check that returns [] for an unknown id,
        // done before filterEvents (which throws on an unknown id) so a bad
        // sessionId comes back as a clean {error}, not a raw internal exception.
        const matches = await sq.filterSessions([{ kind: 'id', values: [sessionId] }], exec.signal)
        header = matches[0]
      } catch (error) {
        return { error: errorText(error) }
      }
      if (header === undefined) return { error: `No session found with id "${sessionId}"` }

      const maxEvents = clamp(numberOr(args.maxEvents, 50), 1, 200)
      let documents
      let titleSnapshot
      try {
        // filterEvents with no filters still skips purely-structural events
        // (it only emits documents with non-empty extracted text) and gives a
        // flat {seq,type,time,surface,text} shape — safer than hand-parsing the
        // raw per-event-type union that readSession/readSurface return.
        ;[documents, titleSnapshot] = await Promise.all([
          sq.filterEvents(sessionId, []),
          sq.readTitle(sessionId, exec.signal),
        ])
      } catch (error) {
        return { error: errorText(error) }
      }

      const events = documents.slice(-maxEvents).map((doc) => ({
        seq: doc.seq,
        type: doc.type,
        time: toIso(doc.time),
        surface: doc.surface,
        text: doc.text.length > 4000 ? `${doc.text.slice(0, 4000)}…` : doc.text,
      }))

      return {
        sessionId,
        title: titleSnapshot?.title ?? '(untitled)',
        cwd: header.header.cwd ?? '',
        createdAt: toIso(header.header.createdAt),
        live: header.live,
        persisted: header.persisted,
        totalEvents: documents.length,
        events,
      }
    },
  }))

  ctx.logger?.info('dsh-session-search-pro: registered agent_session_search, agent_session_list, agent_session_read')
}
