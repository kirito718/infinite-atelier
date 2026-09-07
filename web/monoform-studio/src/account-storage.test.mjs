import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'

import * as adapter from './account-storage.mjs'
const USER = { id: 'user-a', username: 'alice', displayName: 'Alice', avatarUrl: null }
const PROJECT = 'monoform-project'
const POSES = 'monoform-custom-poses'
const project = name => JSON.stringify({ objects: [], settings: { name } })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

// Only the external HTTP boundary is substituted; the adapter and its queue are real.
function server({ embedKey = '', absent = false } = {}) {
  const suffix = embedKey ? `-${embedKey}` : ''
  const entries = new Map([
    [`${PROJECT}${suffix}`, { value: absent ? null : project('Server scene'), revision: absent ? 0 : 4 }],
    [`${POSES}${suffix}`, { value: absent ? null : '[{"id":"pose-1","name":"Saved pose"}]', revision: absent ? 0 : 7 }],
  ])
  const api = { user: USER, entries, calls: [], beforeRead: null, beforeWrite: null, activeWrites: 0, maxActiveWrites: 0 }
  api.fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET'
    const headers = new Headers(options.headers)
    const body = options.body ? JSON.parse(options.body) : null
    api.calls.push({ url, method, headers, body, credentials: options.credentials, cache: options.cache })
    if (url === '/api/account/session') return Response.json({ user: api.user, registrationAllowed: false })
    assert.ok(url.startsWith('/api/account/state/'), 'only the agreed account API may be used')
    const key = decodeURIComponent(url.slice('/api/account/state/'.length))
    assert.ok(entries.has(key), `unexpected key: ${key}`)
    if (method === 'GET') {
      const response = await api.beforeRead?.(key)
      return response || Response.json(entries.get(key))
    }
    assert.equal(method, 'PUT')
    api.activeWrites += 1
    api.maxActiveWrites = Math.max(api.activeWrites, api.maxActiveWrites)
    try {
      const response = await api.beforeWrite?.(key, body)
      if (response) return response
      if (!api.user) return Response.json({ error: 'Please log in', code: 'UNAUTHENTICATED' }, { status: 401 })
      if (headers.get('X-Atelier-User') !== api.user.id) return Response.json({ error: 'Account changed', code: 'ACCOUNT_CHANGED' }, { status: 409 })
      assert.equal(headers.get('X-Atelier-Request'), '1')
      assert.equal(headers.get('Content-Type'), 'application/json')
      const entry = entries.get(key)
      if (entry.revision !== body.expectedRevision) return Response.json({ error: 'Newer state exists', code: 'CONFLICT' }, { status: 409 })
      entries.set(key, { value: body.value, revision: entry.revision + 1 })
      return Response.json({ revision: entry.revision + 1 })
    } finally {
      api.activeWrites -= 1
    }
  }
  return api
}

async function bootstrap(api, options = {}) {
  assert.equal(typeof adapter.bootstrapAccountStorage, 'function', 'server bootstrap adapter is not implemented')
  return adapter.bootstrapAccountStorage({ fetchImpl: api.fetchImpl, debounceMs: 60_000, ...options })
}

async function open(t, api, options) {
  const result = await bootstrap(api, options)
  t.after(() => result.storage?.dispose())
  return result.storage
}

const writes = api => api.calls.filter(call => call.method === 'PUT')

test('bootstrap waits for both server reads and preserves raw JSON, revisions and encoded embed keys', async t => {
  const embedKey = 'director/一 ?#'
  const api = server({ embedKey })
  const gate = deferred()
  api.beforeRead = key => key.startsWith(POSES) ? gate.promise : null
  let ready = false
  const loading = open(t, api, { embedKey }).then(storage => { ready = true; return storage })
  await nextTurn()
  assert.equal(ready, false, 'an editor cannot start with a partial snapshot')
  assert.equal(writes(api).length, 0)
  gate.resolve()
  const storage = await loading
  assert.equal(storage.user.id, 'user-a')
  assert.equal(storage.keys.project, 'monoform-project-director/一 ?#')
  assert.equal(storage.keys.customPoses, 'monoform-custom-poses-director/一 ?#')
  assert.equal(storage.getItem(storage.keys.project), project('Server scene'))
  assert.equal(storage.getItem(storage.keys.customPoses), '[{"id":"pose-1","name":"Saved pose"}]')
  assert.deepEqual(api.calls.map(call => call.url), [
    '/api/account/session',
    '/api/account/state/monoform-project-director%2F%E4%B8%80%20%3F%23',
    '/api/account/state/monoform-custom-poses-director%2F%E4%B8%80%20%3F%23',
    '/api/account/session',
  ])
  for (const call of api.calls) {
    assert.equal(call.credentials, 'same-origin')
    assert.equal(call.cache, 'no-store')
    if (call.url.includes('/state/')) assert.equal(call.headers.get('X-Atelier-User'), 'user-a')
  }
  assert.equal(storage.getSnapshot().pending, false)
  storage.setItem(storage.keys.project, project('Edited'))
  assert.equal(await storage.flush(), true)
  assert.deepEqual(writes(api)[0].body, { value: project('Edited'), expectedRevision: 4 })
})

test('anonymous standalone bootstrap never reads state or creates a writable store', async () => {
  const api = server()
  api.user = null
  const result = await bootstrap(api)
  assert.equal(result.user, null)
  assert.equal(result.storage, null)
  assert.equal(api.calls.length, 1)
})

test('absent server documents stay absent until edited, without reading or writing any browser storage', async t => {
  const api = server({ absent: true })
  for (const name of ['localStorage', 'sessionStorage']) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, get() { assert.fail(`${name} must not be used, including legacy stageframe-project`) } })
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name])
  }
  const storage = await open(t, api)
  assert.equal(storage.getItem(PROJECT), null)
  assert.equal(storage.getItem(POSES), null)
  assert.equal(await storage.flush(), true)
  assert.equal(writes(api).length, 0, 'mounting alone must not save defaults')
  storage.setItem(PROJECT, project('First edit'))
  await storage.flush()
  assert.equal(writes(api)[0].body.expectedRevision, 0)
})

test('failed bootstrap rejects rather than offering writable defaults or localStorage fallback', async () => {
  const api = server()
  api.beforeRead = key => key === POSES ? Response.json({ error: 'Unavailable', code: 'UNAVAILABLE' }, { status: 503 }) : null
  await assert.rejects(bootstrap(api), /Unavailable/)
  assert.equal(writes(api).length, 0)
})

test('invalid saved JSON or revision rejects bootstrap instead of overwriting it', async t => {
  for (const entry of [
    { value: '{broken', revision: 4 },
    { value: project('Invalid revision'), revision: -1 },
    { value: {}, revision: 4 },
  ]) {
    await t.test(JSON.stringify(entry), async () => {
      const api = server()
      api.entries.set(PROJECT, entry)
      await assert.rejects(bootstrap(api))
      assert.equal(writes(api).length, 0)
    })
  }
})

test('debounce coalesces edits and reports pending before a request starts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const api = server()
  const storage = await open(t, api, { debounceMs: 900 })
  storage.setItem(PROJECT, project('First'))
  assert.equal(storage.getSnapshot().status, 'pending')
  assert.equal(storage.getSnapshot().pending, true)
  t.mock.timers.tick(800)
  storage.setItem(PROJECT, project('Latest'))
  t.mock.timers.tick(899)
  assert.equal(writes(api).length, 0)
  t.mock.timers.tick(1)
  await nextTurn()
  assert.equal(writes(api).length, 1)
  assert.equal(api.entries.get(PROJECT).value, project('Latest'))
  assert.equal(storage.getSnapshot().pending, false)
})

test('edits made in flight are serialized after the acknowledged revision, across both keys', async t => {
  const api = server()
  const gate = deferred()
  api.beforeWrite = () => writes(api).length === 1 ? gate.promise : null
  const storage = await open(t, api)
  const statuses = []
  const unsubscribe = storage.subscribe(() => statuses.push(storage.getSnapshot().status))
  t.after(unsubscribe)
  storage.setItem(PROJECT, project('First'))
  const saving = storage.flush()
  await nextTurn()
  assert.equal(storage.getSnapshot().status, 'saving')
  storage.setItem(PROJECT, project('Latest'))
  storage.setItem(POSES, '[{"id":"pose-2","name":"New pose"}]')
  assert.equal(storage.getSnapshot().pending, true)
  assert.equal(writes(api).length, 1)
  gate.resolve()
  assert.equal(await saving, true)
  assert.equal(api.maxActiveWrites, 1)
  assert.equal(api.entries.get(PROJECT).value, project('Latest'))
  assert.equal(api.entries.get(POSES).value, '[{"id":"pose-2","name":"New pose"}]')
  assert.deepEqual(writes(api).map(call => call.body.expectedRevision), [4, 5, 7])
  assert.equal(storage.getSnapshot().pending, false)
  assert.ok(statuses.includes('pending'))
  assert.equal(statuses.at(-1), 'saved')
})

test('reverting an edit while its write is in flight still persists the revert', async t => {
  const api = server()
  const gate = deferred()
  api.beforeWrite = () => writes(api).length === 1 ? gate.promise : null
  const storage = await open(t, api)
  storage.setItem(PROJECT, project('Temporary'))
  const saving = storage.flush()
  await nextTurn()
  storage.setItem(PROJECT, project('Server scene'))
  gate.resolve()
  await saving
  assert.deepEqual(writes(api).map(call => call.body.expectedRevision), [4, 5])
  assert.equal(api.entries.get(PROJECT).value, project('Server scene'))
})

test('network errors retain the latest draft and retry with the last acknowledged revision', async t => {
  const api = server()
  api.beforeWrite = () => { throw new TypeError('Network offline') }
  const storage = await open(t, api)
  storage.setItem(PROJECT, project('First'))
  assert.equal(await storage.flush(), false)
  assert.equal(storage.getSnapshot().status, 'error')
  assert.equal(storage.getSnapshot().pending, true)
  storage.setItem(PROJECT, project('Latest offline edit'))
  assert.equal(storage.getSnapshot().status, 'error')
  api.beforeWrite = null
  assert.equal(await storage.retry(), true)
  assert.equal(api.entries.get(PROJECT).value, project('Latest offline edit'))
  assert.deepEqual(writes(api).map(call => call.body.expectedRevision), [4, 4])
  assert.equal(storage.getSnapshot().status, 'saved')
})

test('a revision conflict freezes every queued write and retry never overwrites newer state', async t => {
  const api = server()
  const storage = await open(t, api)
  api.entries.set(PROJECT, { value: project('Other tab'), revision: 5 })
  storage.setItem(PROJECT, project('My draft'))
  storage.setItem(POSES, '[]')
  assert.equal(await storage.flush(), false)
  assert.equal(storage.getSnapshot().status, 'conflict')
  assert.equal(storage.getSnapshot().pending, true)
  storage.setItem(PROJECT, project('Still exportable'))
  assert.equal(await storage.retry(), false)
  assert.equal(await storage.flush(), false)
  assert.equal(writes(api).length, 1)
  assert.equal(storage.getItem(PROJECT), project('Still exportable'))
  assert.equal(api.entries.get(PROJECT).value, project('Other tab'))
})

test('an unacknowledged successful write becomes a conflict on retry, never a blind overwrite', async t => {
  const api = server()
  api.beforeWrite = (key, body) => {
    api.entries.set(key, { value: body.value, revision: 5 })
    throw new TypeError('Response lost')
  }
  const storage = await open(t, api)
  storage.setItem(PROJECT, project('Draft'))
  await storage.flush()
  api.beforeWrite = null
  storage.setItem(PROJECT, project('Newer unsaved draft'))
  assert.equal(await storage.retry(), false)
  assert.equal(storage.getSnapshot().status, 'conflict')
  assert.equal(api.entries.get(PROJECT).value, project('Draft'))
  assert.deepEqual(writes(api).map(call => call.body.expectedRevision), [4, 4])
})

test('session identity changes stop pending writes before dispatch', async t => {
  const api = server()
  const storage = await open(t, api)
  storage.setItem(PROJECT, project('Old account draft'))
  api.user = { ...USER, id: 'user-b' }
  assert.equal(await storage.checkSession(), false)
  assert.equal(storage.getSnapshot().status, 'account-changed')
  assert.equal(await storage.retry(), false)
  assert.equal(await storage.flush(), false)
  assert.equal(writes(api).length, 0)
  assert.equal(storage.user.id, 'user-a')
  const sessionCheck = api.calls.filter(call => call.url === '/api/account/session').at(-1)
  assert.equal(sessionCheck.headers.get('X-Atelier-User'), 'user-a')
})

test('401 and ACCOUNT_CHANGED freeze writes with the captured user header', async t => {
  for (const user of [null, { ...USER, id: 'user-b' }]) {
    await t.test(user ? 'changed account' : 'expired session', async t => {
      const api = server()
      const storage = await open(t, api)
      storage.setItem(PROJECT, project('Old draft'))
      api.user = user
      assert.equal(await storage.flush(), false)
      assert.equal(storage.getSnapshot().status, 'account-changed')
      assert.equal(await storage.retry(), false)
      assert.equal(writes(api).length, 1)
      assert.equal(writes(api)[0].headers.get('X-Atelier-User'), 'user-a')
      assert.equal(api.entries.get(PROJECT).value, project('Server scene'))
    })
  }
})

test('late write responses cannot clear an account freeze or dispatch old-account edits', async t => {
  const api = server()
  const gate = deferred()
  api.beforeWrite = () => gate.promise
  const storage = await open(t, api)
  storage.setItem(PROJECT, project('First'))
  const saving = storage.flush()
  await nextTurn()
  storage.setItem(PROJECT, project('Queued old draft'))
  storage.freeze()
  gate.resolve(Response.json({ revision: 5 }))
  assert.equal(await saving, false)
  assert.equal(storage.getSnapshot().status, 'account-changed')
  assert.equal(storage.getSnapshot().pending, true)
  assert.equal(await storage.retry(), false)
  assert.equal(writes(api).length, 1)
})

test('disposal prevents queued writes and ignores late acknowledgements', async t => {
  const api = server()
  const gate = deferred()
  api.beforeWrite = () => gate.promise
  const storage = await open(t, api)
  storage.setItem(PROJECT, project('First'))
  const saving = storage.flush()
  await nextTurn()
  storage.setItem(POSES, '[]')
  storage.dispose()
  gate.resolve(Response.json({ revision: 5 }))
  assert.equal(await saving, false)
  assert.equal(await storage.flush(), false)
  assert.equal(writes(api).length, 1)
})

test('valid JSON with an invalid document shape never creates a writable bootstrap', async t => {
  for (const [key, value] of [[PROJECT, 'null'], [PROJECT, '{}'], [PROJECT, '[]'], [POSES, '{}']]) {
    await t.test(`${key}: ${value}`, async () => {
      const api = server()
      api.entries.set(key, { value, revision: 4 })
      await assert.rejects(bootstrap(api), /存档|数据/)
      assert.equal(writes(api).length, 0)
    })
  }
})

function makeBrowser({ embedded = false } = {}) {
  const browser = new EventTarget()
  browser.document = new EventTarget()
  browser.document.visibilityState = 'visible'
  browser.location = { origin: 'https://atelier.example' }
  const messages = []
  const postMessage = (data, origin) => messages.push({ data: structuredClone(data), origin })
  browser.postMessage = postMessage
  browser.parent = embedded ? { postMessage } : browser
  return { browser, messages }
}

function watch(t, storage, options) {
  const { browser, messages } = makeBrowser(options)
  const cleanup = adapter.watchAccountStorage(storage, browser)
  t.after(cleanup)
  return { browser, cleanup, messages }
}

test('beforeunload warns for pending and failed saves, but not acknowledged saves or after cleanup', async t => {
  const api = server()
  const storage = await open(t, api)
  const { browser, cleanup } = watch(t, storage)
  const leave = () => {
    const event = new Event('beforeunload', { cancelable: true })
    browser.dispatchEvent(event)
    return event.defaultPrevented
  }
  assert.equal(leave(), false)
  storage.setItem(PROJECT, project('Unsaved'))
  assert.equal(leave(), true)
  api.beforeWrite = () => { throw new TypeError('Offline') }
  await storage.flush()
  assert.equal(leave(), true)
  api.beforeWrite = null
  await storage.retry()
  assert.equal(leave(), false)
  storage.setItem(PROJECT, project('Another edit'))
  cleanup()
  assert.equal(leave(), false)
})

test('parent account-change notification freezes immediately without browser-storage access', async t => {
  const api = server()
  const storage = await open(t, api)
  const { browser } = watch(t, storage)
  Object.defineProperty(browser, 'localStorage', { get() { assert.fail('notification handling must not read localStorage') } })
  storage.setItem(PROJECT, project('Old draft'))
  browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'unrelated-preference' }))
  assert.equal(storage.getSnapshot().status, 'pending')
  browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'atelier:account-changed' }))
  assert.equal(storage.getSnapshot().status, 'account-changed')
  assert.equal(await storage.flush(), false)
  assert.equal(writes(api).length, 0)
})

test('focus and visibility recheck the cookie and freeze a changed account', async t => {
  for (const event of ['focus', 'visibilitychange']) {
    await t.test(event, async t => {
      const api = server()
      const storage = await open(t, api)
      const { browser } = watch(t, storage)
      api.user = null
      const target = event === 'focus' ? browser : browser.document
      target.dispatchEvent(new Event(event))
      await nextTurn()
      assert.equal(storage.getSnapshot().status, 'account-changed')
    })
  }
})

test('an online notification retries a network failure without losing the draft', async t => {
  const api = server()
  const storage = await open(t, api)
  const { browser } = watch(t, storage)
  api.beforeWrite = () => { throw new TypeError('Offline') }
  storage.setItem(PROJECT, project('Draft'))
  await storage.flush()
  api.beforeWrite = null
  browser.dispatchEvent(new Event('online'))
  await nextTurn()
  assert.equal(api.entries.get(PROJECT).value, project('Draft'))
  assert.equal(storage.getSnapshot().pending, false)
})

test('a queued save waits for an in-progress session check before sending anything', async t => {
  const api = server()
  const originalFetch = api.fetchImpl
  const gate = deferred()
  let blockSession = false
  api.fetchImpl = async (url, options) => {
    if (url === '/api/account/session' && blockSession) await gate.promise
    return originalFetch(url, options)
  }
  const storage = await open(t, api)
  blockSession = true
  const checking = storage.checkSession()
  storage.setItem(PROJECT, project('Old account draft'))
  const saving = storage.flush()
  await nextTurn()
  assert.equal(writes(api).length, 0)
  api.user = { ...USER, id: 'user-b' }
  gate.resolve()
  assert.equal(await checking, false)
  assert.equal(await saving, false)
  assert.equal(writes(api).length, 0)
})

function requestParentFlush(browser, data = {}, event = {}) {
  browser.dispatchEvent(Object.assign(new Event('message'), {
    origin: browser.location.origin,
    source: browser.parent,
    data: { type: 'atelier:flush-editor', userId: 'user-a', requestId: 'flush-1', ...data },
    ...event,
  }))
}

const flushReplies = messages => messages.filter(message => message.data.type === 'atelier:editor-flushed')

test('embedded bridge announces only user and pending status initially and on every subscription update', async t => {
  const api = server()
  const storage = await open(t, api)
  const { messages } = watch(t, storage, { embedded: true })
  assert.deepEqual(messages, [{
    data: { type: 'atelier:editor-status', userId: 'user-a', pending: false },
    origin: 'https://atelier.example',
  }])
  storage.setItem(PROJECT, project('Private project content'))
  storage.setItem(POSES, '[{"id":"private-pose","name":"Private pose"}]')
  assert.deepEqual(messages.map(message => message.data.pending), [false, true, true])
  const notifications = []
  const unsubscribe = storage.subscribe(() => notifications.push(storage.getSnapshot().pending))
  t.after(unsubscribe)
  await storage.flush()
  assert.deepEqual(messages.slice(3).map(message => message.data.pending), notifications)
  assert.equal(messages.at(-1).data.pending, false)
  for (const message of messages) {
    assert.equal(message.origin, 'https://atelier.example')
    assert.deepEqual(Object.keys(message.data).sort(), ['pending', 'type', 'userId'])
    assert.equal(message.data.type, 'atelier:editor-status')
    assert.equal(message.data.userId, 'user-a')
  }
})

test('authorized parent flush drains pending project and poses before acknowledging success', async t => {
  const api = server()
  const gate = deferred()
  api.beforeWrite = () => writes(api).length === 1 ? gate.promise : null
  const storage = await open(t, api)
  storage.setItem(PROJECT, project('First draft'))
  storage.setItem(POSES, '[]')
  const { browser, messages } = watch(t, storage, { embedded: true })
  assert.equal(messages[0]?.data.pending, true)
  requestParentFlush(browser, { requestId: 'parent-navigation-1', ignoredPayload: 'Do not echo this' })
  await nextTurn()
  assert.equal(writes(api).length, 1, 'parent flush must bypass the debounce delay')
  assert.deepEqual(flushReplies(messages), [], 'do not acknowledge while a write is in flight')
  storage.setItem(PROJECT, project('Latest in-flight edit'))
  gate.resolve()
  await nextTurn()
  assert.equal(api.entries.get(PROJECT).value, project('Latest in-flight edit'))
  assert.equal(api.entries.get(POSES).value, '[]')
  assert.deepEqual(flushReplies(messages), [{
    data: { type: 'atelier:editor-flushed', userId: 'user-a', requestId: 'parent-navigation-1', ok: true },
    origin: 'https://atelier.example',
  }])
  assert.equal(storage.getSnapshot().pending, false)
})

test('parent flush rejects foreign origins, sources, identities, message types and invalid request IDs', async t => {
  const api = server()
  const storage = await open(t, api)
  storage.setItem(PROJECT, project('Private unsaved draft'))
  const { browser, messages } = watch(t, storage, { embedded: true })
  for (const [name, data, event] of [
    ['foreign origin', {}, { origin: 'https://foreign.example' }],
    ['foreign source', {}, { source: new EventTarget() }],
    ['own window instead of parent', {}, { source: browser }],
    ['wrong user', { userId: 'user-b' }, {}],
    ['missing user', { userId: undefined }, {}],
    ['wrong type', { type: 'atelier:editor-status' }, {}],
    ['missing request ID', { requestId: undefined }, {}],
    ['empty request ID', { requestId: '' }, {}],
    ['non-string request ID', { requestId: 123 }, {}],
    ['oversized request ID', { requestId: 'x'.repeat(101) }, {}],
    ['null message', {}, { data: null }],
  ]) {
    requestParentFlush(browser, data, event)
    await nextTurn()
    assert.equal(writes(api).length, 0, name)
    assert.equal(flushReplies(messages).length, 0, name)
  }
  // Positive control: the handler exists and accepts the documented upper bound.
  requestParentFlush(browser, { requestId: 'x'.repeat(100) })
  await nextTurn()
  assert.equal(writes(api).length, 1)
  assert.deepEqual(flushReplies(messages), [{
    data: { type: 'atelier:editor-flushed', userId: 'user-a', requestId: 'x'.repeat(100), ok: true },
    origin: 'https://atelier.example',
  }])
})

test('parent receives a safe failure acknowledgement for network errors, conflicts and changed accounts', async t => {
  for (const kind of ['network', 'conflict', 'account-changed']) {
    await t.test(kind, async t => {
      const api = server()
      const storage = await open(t, api)
      const { browser, messages } = watch(t, storage, { embedded: true })
      const privateDetail = 'PRIVATE_PAYLOAD_OR_SECRET'
      api.beforeWrite = () => {
        if (kind === 'network') throw new TypeError(privateDetail)
        return Response.json({ error: privateDetail, code: kind === 'conflict' ? 'CONFLICT' : 'ACCOUNT_CHANGED' }, { status: 409 })
      }
      storage.setItem(PROJECT, project(privateDetail))
      requestParentFlush(browser)
      await nextTurn()
      const [reply] = flushReplies(messages)
      assert.equal(reply?.data.ok, false)
      assert.equal(reply.data.userId, 'user-a')
      assert.equal(reply.data.requestId, 'flush-1')
      assert.equal(reply.origin, 'https://atelier.example')
      assert.equal(typeof reply.data.error, 'string')
      assert.ok(reply.data.error.length > 0)
      assert.deepEqual(Object.keys(reply.data).sort(), ['error', 'ok', 'requestId', 'type', 'userId'])
      assert.equal(JSON.stringify(messages).includes(privateDetail), false)
      assert.equal(storage.getSnapshot().pending, true)
      requestParentFlush(browser, { requestId: 'flush-2' })
      await nextTurn()
      assert.equal(flushReplies(messages).at(-1).data.ok, false)
      assert.equal(flushReplies(messages).at(-1).data.requestId, 'flush-2')
      assert.equal(writes(api).length, 1, 'parent requests must not retry failures or adopt a newer revision')
    })
  }
})

test('bridge cleanup removes the message listener and subscription and suppresses late replies', async t => {
  const api = server()
  const gate = deferred()
  api.beforeWrite = () => writes(api).length === 1 ? gate.promise : null
  const storage = await open(t, api)
  const { browser, messages, cleanup } = watch(t, storage, { embedded: true })
  assert.equal(getEventListeners(browser, 'message').length, 1)
  storage.setItem(PROJECT, project('First draft'))
  requestParentFlush(browser)
  await nextTurn()
  assert.equal(writes(api).length, 1)
  cleanup()
  assert.equal(getEventListeners(browser, 'message').length, 0)
  const messageCount = messages.length
  storage.setItem(PROJECT, project('Edited after cleanup'))
  requestParentFlush(browser, { requestId: 'after-cleanup' })
  gate.resolve()
  await nextTurn()
  assert.equal(messages.length, messageCount, 'no status or pending flush replies may outlive their watcher')
  // No remaining message handler should flush future changes either.
  const writeCount = writes(api).length
  storage.setItem(POSES, '[]')
  requestParentFlush(browser, { requestId: 'after-cleanup-2' })
  await nextTurn()
  assert.equal(writes(api).length, writeCount)
})

test('standalone windows have no parent-save bridge or status announcements', async t => {
  const api = server()
  const storage = await open(t, api)
  const { browser, messages } = watch(t, storage)
  assert.equal(browser.parent, browser)
  assert.equal(getEventListeners(browser, 'message').length, 0)
  storage.setItem(PROJECT, project('Standalone draft'))
  requestParentFlush(browser)
  await nextTurn()
  assert.equal(writes(api).length, 0)
  assert.deepEqual(messages, [])
})

function bootstrapGuard(t, browser) {
  assert.equal(typeof adapter.createAccountBootstrapGuard, 'function', 'bootstrap invalidation guard is not implemented')
  const guard = adapter.createAccountBootstrapGuard(browser)
  t.after(() => guard.dispose())
  return guard
}

test('bootstrap revalidates the account after authorized state reads even without a notification', async t => {
  const api = server()
  const gate = deferred()
  api.beforeRead = () => gate.promise
  const loading = bootstrap(api).then(result => { t.after(() => result.storage?.dispose()); return result })
  const rejected = assert.rejects(loading, error => error.code === 'ACCOUNT_CHANGED')
  await nextTurn()
  api.user = { ...USER, id: 'user-b' }
  gate.resolve()
  await rejected
  assert.equal(writes(api).length, 0)
  const finalSession = api.calls.at(-1)
  assert.equal(finalSession.url, '/api/account/session')
  assert.equal(finalSession.headers.get('X-Atelier-User'), 'user-a')
})

test('bootstrap stays blocked until its final session revalidation succeeds', async t => {
  const api = server()
  const fetchImpl = api.fetchImpl
  const gate = deferred()
  let sessionReads = 0
  api.fetchImpl = async (url, options) => {
    if (url === '/api/account/session' && ++sessionReads === 2) await gate.promise
    return fetchImpl(url, options)
  }
  let ready = false
  const loading = open(t, api).then(storage => { ready = true; return storage })
  await nextTurn()
  assert.equal(ready, false)
  assert.equal(writes(api).length, 0)
  gate.resolve()
  const storage = await loading
  assert.equal(storage.user.id, 'user-a')
})

test('standalone bootstrap discards deferred reads invalidated by storage or custom account events', async t => {
  for (const type of ['storage', 'atelier:account-changed']) {
    await t.test(type, async t => {
      const api = server()
      const gate = deferred()
      api.beforeRead = () => gate.promise // Already-authorized responses deliberately ignore abort.
      const { browser } = makeBrowser()
      assert.equal(browser.parent, browser)
      const guard = bootstrapGuard(t, browser)
      const loading = bootstrap(api, { signal: guard.signal })
      const rejected = assert.rejects(loading, error => error.code === 'ACCOUNT_CHANGED')
      await nextTurn()
      browser.dispatchEvent(Object.assign(new Event(type), { key: 'atelier:account-changed', url: `${browser.location.origin}/` }))
      api.user = { ...USER, id: 'user-b' }
      gate.resolve()
      await rejected
      assert.equal(guard.signal.aborted, true)
      assert.equal(writes(api).length, 0)
    })
  }
})

test('bootstrap invalidation is observed during the initial session request too', async t => {
  const api = server()
  const fetchImpl = api.fetchImpl
  const gate = deferred()
  api.fetchImpl = async (url, options) => { await gate.promise; return fetchImpl(url, options) }
  const { browser } = makeBrowser()
  const guard = bootstrapGuard(t, browser)
  const loading = bootstrap(api, { signal: guard.signal })
  const rejected = assert.rejects(loading, error => error.code === 'ACCOUNT_CHANGED')
  browser.dispatchEvent(new Event('atelier:account-changed'))
  gate.resolve()
  await rejected
  assert.equal(api.calls.some(call => call.url.includes('/state/')), false)
})

test('invalidation between bootstrap completion and watcher handoff prevents using the stale store', async t => {
  const api = server()
  const { browser } = makeBrowser()
  const guard = bootstrapGuard(t, browser)
  const storage = await open(t, api, { signal: guard.signal })
  browser.dispatchEvent(new Event('atelier:account-changed'))
  assert.throws(() => guard.watch(storage), error => error.code === 'ACCOUNT_CHANGED')
  storage.setItem(PROJECT, project('Must never be saved'))
  assert.equal(await storage.flush(), false)
  assert.equal(writes(api).length, 0)
})

test('bootstrap watcher handoff has no invalidation gap while runtime listeners are being installed', async t => {
  const api = server()
  const { browser } = makeBrowser()
  const guard = bootstrapGuard(t, browser)
  const storage = await open(t, api, { signal: guard.signal })
  const addEventListener = browser.addEventListener.bind(browser)
  browser.addEventListener = (type, listener, options) => {
    if (type === 'storage') browser.dispatchEvent(new Event('atelier:account-changed'))
    return addEventListener(type, listener, options)
  }
  assert.throws(() => guard.watch(storage), error => error.code === 'ACCOUNT_CHANGED')
  assert.equal(getEventListeners(browser, 'storage').length, 0)
  assert.equal(getEventListeners(browser, 'atelier:account-changed').length, 0)
  assert.equal(await storage.flush(), false)
})

test('successful handoff retains the parent bridge and only the runtime account listeners', async t => {
  const api = server()
  const { browser, messages } = makeBrowser({ embedded: true })
  const guard = bootstrapGuard(t, browser)
  const storage = await open(t, api, { signal: guard.signal })
  const unwatch = guard.watch(storage)
  t.after(unwatch)
  assert.equal(getEventListeners(browser, 'storage').length, 1)
  assert.equal(getEventListeners(browser, 'atelier:account-changed').length, 1)
  assert.equal(getEventListeners(browser, 'message').length, 1)
  assert.equal(messages[0].data.type, 'atelier:editor-status')
  browser.dispatchEvent(new Event('atelier:account-changed'))
  assert.equal(storage.getSnapshot().status, 'account-changed')
})

test('bootstrap guard ignores unrelated and foreign-origin storage events and releases listeners on disposal', async t => {
  const { browser } = makeBrowser()
  const guard = bootstrapGuard(t, browser)
  browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'theme', url: browser.location.origin }))
  browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'atelier:account-changed', url: 'https://foreign.example/' }))
  assert.equal(guard.signal.aborted, false)
  guard.dispose()
  assert.equal(guard.signal.aborted, true)
  assert.equal(getEventListeners(browser, 'storage').length, 0)
  assert.equal(getEventListeners(browser, 'atelier:account-changed').length, 0)
})
