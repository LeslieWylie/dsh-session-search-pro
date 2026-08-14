// dsh-session-search-pro
// Advanced cross-session full-text search for DeepSeek Harness.
//
// Uses the built-in sessionQuery service for indexed search
// across all DSH sessions (past and current).
// No external dependencies, no manual zstd parsing, no full scans.
//
// This file exports a Cordis plugin and can be loaded as:
//   - A dynamic Cordis Plugin (via cordis_define + cordis_run)
//   - A static plugin mounted in ~/.dsh/config.yaml
//   - An installed plugin via dshx install

'use strict'

/**
 * Helper: register a model-callable tool.
 * Dynamic Cordis Plugin path: harness builtins (defineTool + registerTool)
 * Static plugin path: ctx.tools.register()
 */
function registerTool(ctx, def) {
  if (typeof harness !== 'undefined' && harness.defineTool && harness.registerTool) {
    const validated = harness.defineTool(def)
    harness.registerTool(ctx, validated)
    return
  }
  const tools = ctx.get('tools')
  if (tools && tools.register) {
    tools.register(def)
    return
  }
  console.log('[session-search] no tool registration mechanism available')
}

/**
 * Create the Cordis plugin.
 */
function createPlugin() {
  return {
    inject: ['sessionQuery', 'timer'],
    apply(ctx) {
      const sq = ctx.sessionQuery
      if (sq === undefined) {
        console.log('[session-search] sessionQuery service unavailable, skipping')
        return
      }

      // ─── Tool 1: agent_session_search ───
      registerTool(ctx, {
        name: 'agent_session_search',
        description: 'Search across all DSH sessions (past and current). ' +
          'Returns matching sessions with snippets, ranked by relevance. ' +
          'Supports full-text search, metadata filtering, and pagination.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Full-text search query (case-insensitive). ' +
                'Searches user messages, assistant messages, and tool outputs.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of session results (1-50, default 10)',
            },
            workspace: {
              type: 'string',
              description: 'Optional workspace path substring filter, ' +
                'e.g. "/Users/mlamp/Desktop"',
            },
            sort: {
              type: 'string',
              enum: ['relevance', 'newest', 'oldest'],
              description: 'Sort order (default: relevance)',
            },
            includeContent: {
              type: 'boolean',
              description: 'Include matching message content in results (default: true)',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              sessions: { type: 'array' },
              total: { type: 'number' },
              query: { type: 'string' },
              message: { type: 'string' },
              error: { type: 'string' },
            },
            additionalProperties: true,
          },
          render: (value) => ({ type: 'json', value }),
        },
        execute: async (args) => {
          const query = String(args.query || '').trim()
          if (!query) return { error: 'query is required' }

          const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50)
          const includeContent = args.includeContent !== false

          let results
          try {
            results = await sq.searchSessions({ query, limit })
          } catch (e) {
            console.log(
              '[session-search] searchSessions failed, falling back:',
              String(e)
            )
            results = await fallbackSearch(sq, query, limit, args.workspace)
          }

          const hits = Array.isArray(results?.hits)
            ? results.hits
            : Array.isArray(results)
              ? results
              : []

          if (hits.length === 0) {
            return { sessions: [], total: 0, message: 'No matching sessions found' }
          }

          const sessions = []
          for (const hit of hits.slice(0, limit)) {
            const sessionId = hit.sessionId || hit.id
            let title = hit.title || ''
            let snippet = ''

            if (!title && sessionId) {
              try {
                const ti = await sq.readTitle(sessionId)
                if (ti?.title) title = ti.title
              } catch (_) { /* ignore */ }
            }

            if (includeContent && hit.events?.length > 0) {
              const bestEvent = hit.events[0]
              snippet = typeof bestEvent.content === 'string'
                ? bestEvent.content.slice(0, 600)
                : JSON.stringify(bestEvent).slice(0, 600)
            } else if (includeContent && hit.snippet) {
              snippet = String(hit.snippet).slice(0, 600)
            }

            sessions.push({
              sessionId: sessionId || 'unknown',
              title: title || '(untitled)',
              snippet,
              matchCount: hit.matchCount || hit.score || 1,
              createdAt: hit.createdAt || hit.ts || '',
              source: 'dsh',
            })
          }

          return { sessions, total: results.total || hits.length, query }
        },
      })

      // ─── Tool 2: agent_session_read ───
      registerTool(ctx, {
        name: 'agent_session_read',
        description: 'Read the full content of a specific DSH session by its ' +
          'session ID. Returns messages, metadata, and timestamps.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: 'The session ID to read, e.g. ' +
                '"session-03d68e2e" or "a4d75296-fc89-44b1"',
            },
            maxMessages: {
              type: 'number',
              description: 'Maximum number of messages (1-200, default 50)',
            },
            includeToolOutput: {
              type: 'boolean',
              description: 'Include tool call outputs (default: false)',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              title: { type: 'string' },
              createdAt: { type: 'string' },
              totalMessages: { type: 'number' },
              messages: { type: 'array' },
              error: { type: 'string' },
            },
            additionalProperties: true,
          },
          render: (value) => ({ type: 'json', value }),
        },
        execute: async (args) => {
          const sessionId = String(args.sessionId || '').trim()
          if (!sessionId) return { error: 'sessionId is required' }

          const maxMessages = Math.min(
            Math.max(Number(args.maxMessages) || 50, 1), 200
          )
          const includeTool = args.includeToolOutput === true

          let sessionLog
          try {
            sessionLog = await sq.readSession(sessionId)
          } catch (e) {
            return {
              error: 'Session not found: ' + sessionId,
              detail: String(e),
            }
          }
          if (!sessionLog) return { error: 'Session not found: ' + sessionId }

          const header = sessionLog.header || sessionLog.meta || {}
          const title = header.title || ''
          const createdAt = header.createdAt || ''
          const events = sessionLog.events || sessionLog.messages || []

          const messages = []
          let count = 0
          for (const event of events) {
            if (count >= maxMessages) break
            const role = event.role || event.type || 'unknown'
            const content = event.content || event.text || ''
            const seq = event.seq || event.seqNum || count
            const ts = event.ts || event.timestamp || ''
            if (role === 'tool' && !includeTool) continue
            messages.push({
              seq,
              role,
              ts,
              content: typeof content === 'string'
                ? content.slice(0, 4000)
                : JSON.stringify(content).slice(0, 4000),
            })
            count++
          }

          let resolvedTitle = title
          if (!resolvedTitle) {
            try {
              const ti = await sq.readTitle(sessionId)
              if (ti?.title) resolvedTitle = ti.title
            } catch (_) { /* ignore */ }
          }

          return {
            sessionId,
            title: resolvedTitle || '(untitled)',
            createdAt,
            totalMessages: events.length,
            messages,
          }
        },
      })

      // ─── Tool 3: agent_session_list ───
      registerTool(ctx, {
        name: 'agent_session_list',
        description: 'List all DSH sessions with optional metadata filters. ' +
          'Returns session IDs, titles, creation times, and previews.',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of sessions (1-100, default 20)',
            },
            workspace: {
              type: 'string',
              description: 'Optional workspace path substring filter',
            },
            sort: {
              type: 'string',
              enum: ['newest', 'oldest'],
              description: 'Sort order (default: newest)',
            },
            includePreview: {
              type: 'boolean',
              description: 'Include a brief session preview (default: true)',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              sessions: { type: 'array' },
              total: { type: 'number' },
              message: { type: 'string' },
              error: { type: 'string' },
            },
            additionalProperties: true,
          },
          render: (value) => ({ type: 'json', value }),
        },
        execute: async (args) => {
          const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
          const includePreview = args.includePreview !== false
          const sort = args.sort || 'newest'

          let sessions
          try {
            sessions = await sq.listSessions()
          } catch (e) {
            return { error: 'Failed to list sessions: ' + String(e) }
          }
          if (!Array.isArray(sessions) || sessions.length === 0) {
            return { sessions: [], total: 0, message: 'No sessions found' }
          }

          let filtered = sessions
          if (args.workspace) {
            const ws = String(args.workspace).toLowerCase()
            filtered = sessions.filter(
              (s) => (s.cwd || s.workspace || '').toLowerCase().includes(ws)
            )
          }

          filtered.sort((a, b) => {
            const aTime = new Date(a.createdAt || a.ts || 0).getTime()
            const bTime = new Date(b.createdAt || b.ts || 0).getTime()
            return sort === 'newest' ? bTime - aTime : aTime - bTime
          })

          const top = filtered.slice(0, limit)
          const result = []
          for (const session of top) {
            const sessionId = session.id || session.sessionId || 'unknown'
            let title = session.title || ''
            if (!title) {
              try {
                const ti = await sq.readTitle(sessionId)
                if (ti?.title) title = ti.title
              } catch (_) { /* ignore */ }
            }
            const entry = {
              sessionId,
              title: title || '(untitled)',
              createdAt: session.createdAt || session.ts || '',
              cwd: session.cwd || '',
              source: 'dsh',
            }

            if (includePreview) {
              try {
                const surface = await sq.readSurface(sessionId)
                if (surface?.messages?.length > 0) {
                  const lastMsg = surface.messages[surface.messages.length - 1]
                  entry.preview = typeof lastMsg.content === 'string'
                    ? lastMsg.content.slice(0, 200)
                    : '(non-text content)'
                }
              } catch (_) { /* ignore */ }
            }
            result.push(entry)
          }

          return { sessions: result, total: filtered.length }
        },
      })

      // ─── Fallback search helper ───
      async function fallbackSearch(sq, query, limit, workspaceFilter) {
        const sessions = await sq.listSessions()
        if (!Array.isArray(sessions)) return { hits: [], total: 0 }

        let filtered = sessions
        if (workspaceFilter) {
          const ws = String(workspaceFilter).toLowerCase()
          filtered = sessions.filter(
            (s) => (s.cwd || s.workspace || '').toLowerCase().includes(ws)
          )
        }

        const q = query.toLowerCase()
        const hits = []

        for (const session of filtered.slice(0, 100)) {
          const sessionId = session.id || session.sessionId
          if (!sessionId) continue

          let matchCount = 0
          let bestSnippet = ''
          let title = session.title || ''

          try {
            const events = await sq.listEvents(sessionId)
            if (!Array.isArray(events)) continue

            for (const event of events) {
              const content = event.content || event.text || ''
              if (
                typeof content === 'string' &&
                content.toLowerCase().includes(q)
              ) {
                matchCount++
                if (!bestSnippet) {
                  const idx = content.toLowerCase().indexOf(q)
                  const start = Math.max(0, idx - 100)
                  const end = Math.min(content.length, idx + q.length + 100)
                  bestSnippet =
                    (start > 0 ? '...' : '') +
                    content.slice(start, end) +
                    (end < content.length ? '...' : '')
                }
              }
            }

            if (matchCount > 0) {
              if (!title) {
                try {
                  const ti = await sq.readTitle(sessionId)
                  if (ti?.title) title = ti.title
                } catch (_) { /* ignore */ }
              }
              hits.push({
                sessionId,
                title: title || '(untitled)',
                matchCount,
                snippet: bestSnippet.slice(0, 600),
                createdAt: session.createdAt || session.ts || '',
              })
            }
          } catch (_) {
            continue
          }

          if (hits.length >= limit) break
        }

        hits.sort((a, b) => b.matchCount - a.matchCount)
        return { hits: hits.slice(0, limit), total: hits.length }
      }

      console.log(
        '[session-search] Plugin initialized: ' +
        'agent_session_search, agent_session_read, agent_session_list'
      )
    },
  }
}

module.exports = createPlugin