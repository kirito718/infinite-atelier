import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App, { prepareAccountState } from './App.jsx'
import { bootstrapAccountStorage, createAccountBootstrapGuard } from './account-storage.mjs'
import './styles.css'

function AccountRoot() {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState({ status: 'loading' })

  useEffect(() => {
    let active = true
    let storage = null
    let unwatch = null
    const bootstrapGuard = createAccountBootstrapGuard()
    setState({ status: 'loading' })
    async function load() {
      try {
        const session = await bootstrapAccountStorage({ embedKey: new URLSearchParams(window.location.search).get('key') || '', signal: bootstrapGuard.signal })
        if (!active) { session.storage?.dispose(); return }
        if (!session.user) { bootstrapGuard.dispose(); setState({ status: 'anonymous' }); return }
        storage = session.storage
        // Parsing/normalization must also succeed before App can schedule saves.
        const startup = prepareAccountState(storage)
        unwatch = bootstrapGuard.watch(storage)
        setState({ status: 'ready', storage, startup })
      } catch (error) {
        bootstrapGuard.dispose()
        storage?.dispose()
        if (active) setState({ status: 'error', error })
      }
    }
    void load()
    return () => {
      active = false
      bootstrapGuard.dispose()
      unwatch?.()
      storage?.dispose()
    }
  }, [attempt])

  if (state.status === 'ready') return <App storage={state.storage} startup={state.startup} />
  return <main className="account-gate" aria-busy={state.status === 'loading'}>
    <section>
      <h1>MONOFORM</h1>
      {state.status === 'loading' ? <p role="status">正在确认账号并载入工程与姿势库…</p> : state.status === 'anonymous' ? <>
        <p>请先登录无限画布账号。工程与姿势库将安全保存到你的账号。</p>
        <a href="/" target="_top">前往无限画布登录</a>
        <button type="button" onClick={() => setAttempt(value => value + 1)}>已登录，重试载入</button>
      </> : <>
        <p role="alert">无法载入账号存档：{state.error?.message}</p>
        <p>编辑器尚未开启，不会用默认工程覆盖现有数据。</p>
        <button type="button" onClick={() => setAttempt(value => value + 1)}>重试载入</button>
        <a href="/" target="_top">返回无限画布</a>
      </>}
    </section>
  </main>
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AccountRoot />
  </React.StrictMode>,
)
