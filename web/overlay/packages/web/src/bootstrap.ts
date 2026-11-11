// Web entry point: installs the browser bridge (window.electron & co.) and
// then runs the unmodified MarkText renderer. Everything the renderer expects
// from Electron's preload must exist before the renderer's bootstrap runs.

import type { App as VueApp } from 'vue'
import { installWebBridge, emitToRenderer, onAppCommand, attachGlobalShortcuts } from './web-shim/ipc'
import { attachLaunchQueue, attachDropImport, restoreProjectRoots } from './web-shim/fileHandling'
import { store } from './web-shim/stateHost'

installWebBridge()

// URL args parity with the Electron bootstrap: the renderer reads theme/font
// params from the query string. The upstream `bootstrap.ts` also reads `udp`
// (user data path) and `wid` (window id) and throws when they are missing —
// always supply them for the web build.
const params = new URLSearchParams(window.location.search)
if (!params.get('udp')) params.set('udp', '/marktext')
if (!params.get('wid')) params.set('wid', '1')
if (!params.get('type')) params.set('type', 'editor')
const search = params.toString()
if (search && window.location.search !== `?${search}`) {
  window.history.replaceState(null, '', `${window.location.pathname}?${search}${window.location.hash}`)
}
// The desktop main process passes the window type in the URL ('editor', or
// 'preference/<category>' for the settings window); the router's '/' redirect
// keys off it, so a settings window boots straight onto the preference page
// without ever mounting the editor App.
const urlType = params.get('type') ?? 'editor'
window.marktext = {
  initialState: {
    codeFontFamily: params.get('cff'),
    codeFontSize: params.get('cfs'),
    debug: params.get('debug') === '1',
    hideScrollbar: params.get('hsb') === '1',
    theme: params.get('theme'),
    titleBarStyle: params.get('tbs')
  },
  env: {
    type: urlType,
    windowId: Number(params.get('wid')) || 1,
    userDataPath: '/marktext',
    paths: store
  }
}

attachLaunchQueue()

// Hide the boot splash once the app mounts.
const revealApp = (): void => {
  const splash = document.getElementById('boot-splash')
  if (splash) {
    splash.classList.add('hidden')
    setTimeout(() => splash.remove(), 400)
  }
}

// --- start the unmodified renderer ----------------------------------------
async function start(): Promise<void> {
  // Import through the same aliases the renderer itself uses so every
  // internal specifier resolves identically.
  const { default: startRenderer } = await import('@mt/bootstrap')
  startRenderer()

  const [{ createApp }, { createRouter, createWebHashHistory }] = await Promise.all([
    import('vue'),
    import('vue-router')
  ])
  const [{ default: pinia }, { default: i18nPlugin }, { default: services }, { default: routes }, { default: Main }] =
    await Promise.all([
      import('@mt/store'),
      import('@mt/i18n'),
      import('@mt/services'),
      import('@mt/router'),
      import('@mt/Main.vue')
    ])

  // Side-effect imports (styles, symbol icons).
  await Promise.all([
    import('@mt/assets/symbolIcon'),
    import('element-plus/dist/index.css'),
    import('@mt/assets/styles/index.css'),
    import('@mt/assets/styles/printService.css')
  ])

  const [{ default: ElementPlus }, { default: en }] = await Promise.all([
    import('element-plus'),
    import('element-plus/es/locale/lang/en')
  ])

  const app: VueApp<Element> = createApp(Main)
  app.use(ElementPlus, { locale: en })

  const envType = window.marktext?.env?.type as string | undefined
  const router = createRouter({
    history: createWebHashHistory(),
    routes: routes(envType)
  })
  app.use(router)
  app.use(pinia)
  app.use(i18nPlugin)

  const axios = (await import('@mt/axios')).default
  app.config.globalProperties.$http = axios

  ;(services as unknown as Array<Record<string, unknown> & { name: string }>).forEach((s) => {
    app.config.globalProperties[`$${s.name}`] = s[s.name]
  })

  app.mount('#app')
  revealApp()

  // The settings window (`type=preference/…`) mounts the Preference page
  // instead of the editor App; it needs none of the editor wiring below.
  const isEditorWindow = params.get('type') === 'editor'

  if (isEditorWindow) {
    // Web-only wiring once the app is up. Do NOT call
    // LISTEN_COMMAND_CENTER_BUS here: app.vue's onMounted already ran it during
    // app.mount above, and each extra call registers another ipc
    // 'mt::execute-command-by-id' listener — every menu click and keyboard
    // accelerator would then execute its command twice (one File > New Tab
    // click created two documents).
    attachGlobalShortcuts((commandId: string) => {
      emitToRenderer('mt::execute-command-by-id', commandId)
    })

    // Desktop opens Preferences in a separate window; mirror that. Routing
    // in-place instead unmounts the editor App, whose onMounted re-registers
    // all of its ipc/bus listeners on every remount (they have no cleanup) —
    // after one settings visit every menu command executed multiple times
    // (a single File > New Tab click created four tabs).
    onAppCommand('open-settings', () => {
      const settingsParams = new URLSearchParams(window.location.search)
      settingsParams.set('type', 'preference/general')
      settingsParams.set('wid', '2')
      // Keep the query (theme/font params, udp, wid) but drop the hash: the
      // editor's `#/editor` route would mount the editor App in the new
      // window too; without it the `/` redirect lands on `/preference/general`.
      const opened = window.open(`${window.location.pathname}?${settingsParams.toString()}`, '_blank')
      if (!opened) console.warn('[web] The Preferences window was blocked by the browser')
    })

    attachDropImport()
    restoreProjectRoots()

    // Deliver initial keybindings + preferences like the desktop main process.
    const { ipcRenderer } = window.electron
    const bindings = (await ipcRenderer.invoke('mt::keybinding-get-pref-keybindings')) as {
      defaultKeybindings: Record<string, string>
      userKeybindings: Record<string, string>
    }
    // Custom user keybindings must win over the defaults: the command center
    // already received the merged map via mt::request-keybindings during
    // mount, and a defaults-only emit here would clobber it.
    emitToRenderer('mt::keybindings-response', {
      ...bindings.defaultKeybindings,
      ...bindings.userKeybindings
    })

    const preferences = (await ipcRenderer.invoke('mt::preferences::get')) as Record<string, unknown>
    emitToRenderer('mt::user-preference', preferences)
  }
}

void start()
