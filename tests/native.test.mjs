import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
const signal = new AbortController().signal;
const record = { header: { id: 's1', cwd: '/project', createdAt: 1 }, live: false, persisted: true };
const event = (seq, text) => ({ seq, time: 2, type: 'user/message', data: { content: [{ type: 'text', text }] } });
function fixture(overrides = {}, workspace = { id: 'w1', title: 'Project', sessionIds: ['s1'] }) {
  const registered = new Map(), disposers = [], calls = [];
  const sq = {
    async searchSessions(request, exec) { calls.push([request, exec]); return { items: [{ ...record, bestMatch: { seq: 2, time: 2, surface: 'current', snippet: 'sandbox-exec ENOENT' } }], nextCursor: 'token' }; },
    async filterSessions(filters, raw) { calls.push([filters, raw]); return [record, { ...record, header: { ...record.header, id: 's2' } }]; },
    async readTitleSnapshots(ids) { return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { title: { title: 'History' } } })); },
    async readEvent(request, raw) { calls.push([request, raw]); return { session: record.header, events: [event(1, 'before'), event(2, 'sandbox-exec ENOENT')] }; },
    async readSession() { return { session: record.header, events: [event(0, 'old'), event(1, 'x'.repeat(5000)), event(2, 'new')] }; },
    ...overrides,
  };
  apply({ sessionQuery: sq, tools: { register(def) { registered.set(def.name, def); return () => registered.delete(def.name); } }, effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; }, get(key) { return key === 'workspaceRegistry' && workspace ? { get: id => id === workspace.id ? workspace : undefined, list: () => [workspace] } : undefined; } });
  const run = async (name, args) => registered.get(name).execute(args, { signal });
  return { registered, disposers, run, calls };
}
test('registers three tools and disposes registrations', () => { const f = fixture(); assert.deepEqual([...f.registered.keys()], ['search_sessions', 'list_sessions', 'read_session']); f.disposers.forEach(fn => fn()); assert.equal(f.registered.size, 0); });
test('search forwards exact workspace/cwd, signal and cursor', async () => { const f = fixture(); const out = await f.run('search_sessions', { query: ' sandbox-exec ENOENT ', workspaceId: 'w1', cwd: '/project', cursor: 'previous', limit: 2 }); assert.equal(out.sessions[0].sessionId, 's1'); assert.equal(out.nextCursor, 'token'); assert.equal(out.sessions[0].title, 'History'); assert.deepEqual(f.calls[0][0].sessionFilters, [{ kind: 'id', values: ['s1'] }, { kind: 'cwd', values: ['/project'] }]); assert.equal(f.calls[0][1].signal, signal); });
test('no hits has explicit empty page', async () => { const f = fixture({ searchSessions: async () => ({ items: [] }) }); assert.deepEqual((await f.run('search_sessions', { query: 'missing' })).sessions, []); });
test('invalid scope, query and limits reject', async () => { const f = fixture(); for (const args of [{ query: ' ' }, { query: 'x', workspaceId: 'unknown' }, { query: 'x', limit: 0 }, { query: 'x', limit: 51 }, { query: 'x', limit: 1.5 }]) await assert.rejects(f.run('search_sessions', args)); });
test('backend failures remain failures, not empty search', async () => { const f = fixture({ searchSessions: async () => { throw new Error('SESSION_QUERY_SEARCH_DISABLED'); } }); await assert.rejects(f.run('search_sessions', { query: 'x' }), /DISABLED/); });
test('list paginates deterministically', async () => { const f = fixture(); const first = await f.run('list_sessions', { limit: 1 }); assert.equal(first.nextOffset, 1); const second = await f.run('list_sessions', { limit: 1, offset: 1 }); assert.equal(second.sessions[0].sessionId, 's2'); assert.equal(second.nextOffset, null); });
test('read matching context and cancellation convention', async () => { const f = fixture(); const out = await f.run('read_session', { sessionId: 's1', seq: 2 }); assert.equal(out.events[1].text, 'sandbox-exec ENOENT'); assert.equal(f.calls[0][0].before, 3); assert.equal(f.calls[0][1], signal); });
test('recent read paging and aggregate/per-event budgets', async () => { const f = fixture(); const out = await f.run('read_session', { sessionId: 's1', limit: 2, maxChars: 100 }); assert.equal(out.nextOffset, 2); assert.equal(out.events.reduce((n, e) => n + e.text.length, 0), 100); assert.equal(out.truncated, true); const next = await f.run('read_session', { sessionId: 's1', limit: 2, offset: 2 }); assert.equal(next.events[0].text, 'old'); });
test('unknown session, invalid combinations, argument schema', async () => { const f = fixture({ readSession: async () => { throw new Error('no session found'); } }); await assert.rejects(f.run('read_session', { sessionId: 'missing' }), /no session found/); await assert.rejects(f.run('read_session', { sessionId: 's1', seq: 1, offset: 1 })); await assert.rejects(f.run('read_session', { sessionId: 's1', before: 1 })); await assert.rejects(f.run('search_sessions', { query: 2 })); });
