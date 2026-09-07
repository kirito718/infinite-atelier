const stateURL = key => `/api/account/state/${encodeURIComponent(key)}`
const accountChangedError = () => Object.assign(new Error('账号已退出或发生变化，请先导出草稿，再重新登录。'), { code: 'ACCOUNT_CHANGED' })

async function requestJSON(fetchImpl, url, userId, options = {}) {
  const headers = { Accept: 'application/json' }
  if (userId) headers['X-Atelier-User'] = userId
  if (options.method === 'PUT') {
    headers['Content-Type'] = 'application/json'
    headers['X-Atelier-Request'] = '1'
  }
  const response = await fetchImpl(url, { ...options, headers, credentials: 'same-origin', cache: 'no-store' })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw Object.assign(new Error(body?.error || `账号服务请求失败 (${response.status})`), { code: body?.code, status: response.status })
  }
  if (!body || typeof body !== 'object') throw new Error('账号服务返回无效响应，请重试。')
  return body
}

function validateSession(session) {
  if (session.user !== null && (typeof session.user?.id !== 'string' || !session.user.id)) {
    throw new Error('账号信息无效，请重新登录。')
  }
  return session
}

// There is deliberately no browser-storage fallback or legacy migration here.
// A writable queue only exists after the session AND both documents were read.
export async function bootstrapAccountStorage({ fetchImpl = globalThis.fetch, embedKey = '', debounceMs = 900, signal } = {}) {
  const read = async (url, userId) => {
    signal?.throwIfAborted()
    const result = await requestJSON(fetchImpl, url, userId, { signal })
    // Authorized responses may finish after cancellation, even if fetch ignores abort.
    signal?.throwIfAborted()
    return result
  }
  const session = validateSession(await read('/api/account/session'))
  if (!session.user) return { ...session, storage: null }
  const suffix = embedKey ? `-${embedKey}` : ''
  const keys = { project: `monoform-project${suffix}`, customPoses: `monoform-custom-poses${suffix}` }
  const entries = new Map(await Promise.all(Object.values(keys).map(async key => {
    const entry = await read(stateURL(key), session.user.id)
    if ((entry.value !== null && typeof entry.value !== 'string') || !Number.isSafeInteger(entry.revision) || entry.revision < 0) {
      throw new Error('服务器中的 MONOFORM 存档无效，已停止载入以防覆盖。')
    }
    if (entry.value !== null) {
      const data = JSON.parse(entry.value)
      const valid = key === keys.customPoses ? Array.isArray(data) : data && !Array.isArray(data) && (Array.isArray(data.objects) || Array.isArray(data.shots?.[0]?.objects))
      if (!valid) throw new Error('服务器中的 MONOFORM 数据格式无效，已停止载入以防覆盖。')
    }
    return [key, { value: entry.value, revision: entry.revision, version: 0, savedVersion: 0 }]
  })))
  const confirmed = validateSession(await read('/api/account/session', session.user.id))
  if (confirmed.user?.id !== session.user.id) throw accountChangedError()
  const storage = createStorage({ user: session.user, keys, entries, fetchImpl, debounceMs })
  return { ...session, storage }
}

function createStorage({ user, keys, entries, fetchImpl, debounceMs }) {
  const userId = user.id
  const listeners = new Set()
  let timer = null
  let running = null
  let checkingSession = null
  let inFlight = null
  let error = null
  let blocked = null
  let disposed = false
  let epoch = 0
  let snapshot = { status: 'saved', pending: false, error: null }
  const dirty = () => [...entries.values()].some(entry => entry.version !== entry.savedVersion)
  const stopped = () => disposed || blocked !== null
  const clearTimer = () => { clearTimeout(timer); timer = null }
  const publish = () => {
    snapshot = {
      status: blocked || (error ? 'error' : inFlight ? 'saving' : dirty() ? 'pending' : 'saved'),
      pending: dirty() || inFlight !== null,
      error,
    }
    listeners.forEach(listener => listener())
  }
  const schedule = () => {
    clearTimer()
    if (!stopped() && !error && dirty()) timer = setTimeout(() => { timer = null; void flush() }, debounceMs)
  }
  const freeze = (cause = accountChangedError()) => {
    if (disposed) return
    blocked = cause.code === 'CONFLICT' || (cause.status === 409 && cause.code !== 'ACCOUNT_CHANGED') ? 'conflict' : 'account-changed'
    error = cause
    epoch += 1
    clearTimer()
    inFlight?.abort()
    publish()
  }
  const fail = cause => {
    if (cause.status === 401 || cause.status === 409 || cause.code === 'ACCOUNT_CHANGED') freeze(cause)
    else { error = cause; publish() }
  }

  async function drain() {
    while (!stopped() && !error && dirty()) {
      // Focus/auth checks pause new dispatches until identity is confirmed.
      if (checkingSession && !await checkingSession) break
      if (stopped() || error) break
      const [key, entry] = [...entries].find(([, value]) => value.version !== value.savedVersion)
      const sentVersion = entry.version
      const sentEpoch = epoch
      inFlight = new AbortController()
      publish()
      try {
        const result = await requestJSON(fetchImpl, stateURL(key), userId, {
          method: 'PUT',
          body: JSON.stringify({ value: entry.value, expectedRevision: entry.revision }),
          signal: inFlight.signal,
        })
        if (stopped() || sentEpoch !== epoch) break
        if (!Number.isSafeInteger(result.revision) || result.revision <= entry.revision) throw new Error('保存响应缺少有效版本号，请重试。')
        entry.revision = result.revision
        // Only acknowledge the version actually sent, never edits made in flight.
        entry.savedVersion = sentVersion
      } catch (cause) {
        if (!stopped() && sentEpoch === epoch) fail(cause)
      } finally {
        inFlight = null
        publish()
      }
    }
    return !stopped() && !error && !dirty()
  }

  function flush() {
    clearTimer()
    if (stopped() || error) return Promise.resolve(false)
    if (running) return running
    if (!dirty()) return Promise.resolve(true)
    running = drain().finally(() => {
      running = null
      schedule()
    })
    return running
  }

  function checkSession() {
    if (stopped()) return Promise.resolve(false)
    if (checkingSession) return checkingSession
    const checkEpoch = epoch
    checkingSession = (async () => {
      try {
        const session = validateSession(await requestJSON(fetchImpl, '/api/account/session', userId))
        if (stopped() || epoch !== checkEpoch) return false
        if (session.user?.id !== userId) { freeze(); return false }
        return true
      } catch (cause) {
        if (!stopped() && epoch === checkEpoch) fail(cause)
        return false
      }
    })().finally(() => {
      checkingSession = null
      schedule()
    })
    return checkingSession
  }

  return {
    user: Object.freeze({ ...user }),
    keys: Object.freeze(keys),
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    getItem: key => {
      if (!entries.has(key)) throw new Error('未知的 MONOFORM 存档键。')
      return entries.get(key).value
    },
    setItem: (key, value) => {
      if (disposed) return
      const entry = entries.get(key)
      if (!entry || (value !== null && typeof value !== 'string')) throw new Error('无效的 MONOFORM 存档。')
      if (entry.value === value) return
      entry.value = value
      entry.version += 1
      // Frozen drafts remain in memory for explicit export, but never dispatch.
      publish()
      schedule()
    },
    flush,
    retry: async () => {
      if (stopped()) return false
      if (running) return running
      error = null
      publish()
      if (!await checkSession()) return false
      return flush()
    },
    checkSession,
    freeze,
    dispose: () => {
      disposed = true
      epoch += 1
      clearTimer()
      inFlight?.abort()
      listeners.clear()
    },
  }
}

function isAccountStorageEvent(event, browser) {
  if (event.key !== 'atelier:account-changed') return false
  if (!event.url) return true // Native storage events are already same-origin.
  try { return new URL(event.url).origin === browser.location.origin } catch { return false }
}

// Keep invalidation coverage from before the first request through runtime handoff.
export function createAccountBootstrapGuard(browser = window) {
  const controller = new AbortController()
  const invalidate = () => controller.abort(accountChangedError())
  const storageChanged = event => { if (isAccountStorageEvent(event, browser)) invalidate() }
  browser.addEventListener('storage', storageChanged)
  browser.addEventListener('atelier:account-changed', invalidate)
  const stop = () => {
    browser.removeEventListener('storage', storageChanged)
    browser.removeEventListener('atelier:account-changed', invalidate)
  }
  return {
    signal: controller.signal,
    watch: storage => {
      let unwatch
      try {
        controller.signal.throwIfAborted()
        unwatch = watchAccountStorage(storage, browser)
        controller.signal.throwIfAborted()
        stop() // Runtime listeners are installed before bootstrap listeners leave.
        return unwatch
      } catch (error) {
        stop()
        unwatch?.()
        storage.dispose()
        throw error
      }
    },
    dispose: () => { stop(); controller.abort() },
  }
}

// The parent publishes only an invalidation token under this storage-event key.
// Listening to the event does not read, write or migrate any browser storage.
export function watchAccountStorage(storage, browser = window) {
  const beforeUnload = event => {
    if (!storage.getSnapshot().pending) return
    event.preventDefault()
    event.returnValue = ''
  }
  const accountChanged = () => storage.freeze()
  const storageChanged = event => { if (isAccountStorageEvent(event, browser)) accountChanged() }
  const checkSession = () => { void storage.checkSession() }
  const visible = () => { if (browser.document.visibilityState === 'visible') checkSession() }
  const online = () => { if (storage.getSnapshot().status === 'error') void storage.retry() }
  const parent = browser.parent !== browser ? browser.parent : null
  const origin = parent ? browser.location.origin : null
  const userId = storage.user.id
  let active = true
  let unsubscribe = null
  const announce = () => {
    if (active) parent.postMessage({ type: 'atelier:editor-status', userId, pending: storage.getSnapshot().pending }, origin)
  }
  const flushEditor = async event => {
    const data = event.data
    if (!active || event.origin !== origin || event.source !== parent || data?.type !== 'atelier:flush-editor' || data.userId !== userId || typeof data.requestId !== 'string' || !data.requestId.length || data.requestId.length > 100) return
    const requestId = data.requestId
    let ok = false
    try { ok = await storage.flush() === true } catch { /* Never send raw errors or document data to the host. */ }
    if (!active) return
    parent.postMessage({
      type: 'atelier:editor-flushed', userId, requestId, ok,
      ...(!ok ? { error: '编辑器保存未完成，请查看编辑器中的保存提示。' } : {}),
    }, origin)
  }
  if (parent) {
    browser.addEventListener('message', flushEditor)
    unsubscribe = storage.subscribe(announce)
    announce()
  }
  browser.addEventListener('beforeunload', beforeUnload)
  browser.addEventListener('storage', storageChanged)
  browser.addEventListener('atelier:account-changed', accountChanged)
  browser.addEventListener('focus', checkSession)
  browser.addEventListener('online', online)
  browser.document.addEventListener('visibilitychange', visible)
  return () => {
    active = false
    unsubscribe?.()
    if (parent) browser.removeEventListener('message', flushEditor)
    browser.removeEventListener('beforeunload', beforeUnload)
    browser.removeEventListener('storage', storageChanged)
    browser.removeEventListener('atelier:account-changed', accountChanged)
    browser.removeEventListener('focus', checkSession)
    browser.removeEventListener('online', online)
    browser.document.removeEventListener('visibilitychange', visible)
  }
}
