// Vite configuration for the MarkText web/PWA build. It compiles the
// upstream renderer sources (packages/desktop/src/renderer) together with the
// web shim (packages/web/src/web-shim), with aliases matching the Electron
// build so `@/`, `common/` and `@shared/` resolve identically.

import { resolve, dirname } from 'path'
import type { PluginOption } from 'vite'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import svgLoader from 'vite-svg-loader'
import postcssPresetEnv from 'postcss-preset-env'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * prismjs' language component scripts and mermaid's bundled mermaid-language
 * definition reference the *global* `Prism` (and call Prism.languages.extend
 * etc.) at module-evaluation time. muya assigns `window.Prism = Prism` when
 * its own prism module evaluates, but chunk splitting can order consumer
 * chunks before that assignment runs. This plugin appends a global assignment
 * to the prismjs core module itself, so any chunk that includes (or depends
 * on) the core executes with the global already set to the same instance.
 */
const prismGlobalPlugin = (): PluginOption => ({
  name: 'marktext-web:prism-global',
  transform(code, id) {
    // Match the prismjs core module (not components/plugins), tolerating
    // Vite's dependency-optimization query suffixes (?v=…).
    const isCore = /node_modules[\\/]prismjs[\\/]prism\.js(\?|$)/.test(id) ||
      /node_modules[\\/]prismjs[\\/]components[\\/]prism-core\.js(\?|$)/.test(id)
    if (isCore) {
      return {
 code: `${code}\n;if (typeof window !== 'undefined' && typeof window.Prism === 'undefined' && typeof Prism !== 'undefined') { window.Prism = Prism; }\n`,
 map: null
      }
    }
    return null
  }
})
// packages/web → packages/ (the pnpm workspace package root).
const packagesDir = resolve(__dirname, '..')
const desktopSrc = resolve(packagesDir, 'desktop/src')

const outDir = resolve(packagesDir, '..', 'dist')

// GitHub Pages serves at /<repo>/ unless a user/organization site; this is
// overridable at build time (BASE_URL=https://user.github.io/ vite build).
const base = process.env.BASE_URL || '/'

export default defineConfig({
  base,
  resolve: {
    // prismjs is imported from several places (muya, mermaid's bundled copy,
    // dynamic component scripts) and pnpm resolves each through a different
    // physical path, producing multiple core instances with separate language
    // registries. Deduplicate to one shared instance.
    dedupe: ['prismjs'],
    alias: [
      // Order matters: specific subpaths before their prefixes.
      { find: 'electron-log/renderer', replacement: resolve(__dirname, 'src/electron-log-shim.ts') },
      { find: 'electron-log', replacement: resolve(__dirname, 'src/electron-log-shim.ts') },
      // Web entry imports the renderer through `@mt/*` so all internal
      // specifiers resolve with the same aliases the renderer itself uses.
      { find: /^@mt\/(.*)$/, replacement: `${resolve(desktopSrc, 'renderer/src')}/$1` },
      { find: /^@\/(.*)$/, replacement: `${resolve(desktopSrc, 'renderer/src')}/$1` },
      { find: /^common\/(.*)$/, replacement: `${resolve(desktopSrc, 'common')}/$1` },
      { find: /^@shared\/(.*)$/, replacement: `${resolve(desktopSrc, 'shared')}/$1` },
      // The Electron build aliases `path` to a platform shim; the web build
      // keeps the same alias so shared `common/*` modules import something.
      { find: /^path$/, replacement: resolve(__dirname, 'src/web-shim/nodePath.ts') },
      // MarkText imports `pathe` in shared code; alias to the shim's path.
      { find: /^pathe$/, replacement: resolve(__dirname, 'src/web-shim/nodePath.ts') }
    ],
    extensions: ['.mjs', '.ts', '.js', '.json', '.vue']
  },
  assetsInclude: ['**/*.md'],
  define: {
    global: 'globalThis',
    MARKTEXT_VERSION: JSON.stringify('0.24.0-web'),
    MARKTEXT_VERSION_STRING: JSON.stringify('v0.24.0-web')
  },
  optimizeDeps: {
    include: ['pako', 'pathe']
  },
  plugins: [
    prismGlobalPlugin(),
    vue(),
    svgLoader(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icon-*.png'],
      manifest: {
        name: 'MarkText',
        short_name: 'MarkText',
        description: 'A WYSIWYG markdown editor that runs in your browser, installs as an app, and works offline.',
        id: '/',
        start_url: `${base}`,
        scope: `${base}`,
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone', 'minimal-ui'],
        orientation: 'any',
        background_color: '#f8f8f8',
        theme_color: '#2c3e50',
        lang: 'en',
        dir: 'auto',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ],
        file_handlers: [
          {
            action: `${base}`,
            accept: {
              'text/markdown': ['.md', '.markdown', '.mdown', '.mkdn', '.mdwn', '.mdtxt', '.mdtext', '.mkd'],
              'text/plain': ['.txt']
            },
            launch_type: 'single-client'
          }
        ],
        launch_handler: {
          client_mode: 'focus-existing'
        },
        protocol_handlers: [
          { protocol: 'web+marktext', url: `${base}#/open?path=%s` }
        ],
        screenshots: [
          {
            src: 'screenshot-wide.png',
            sizes: '1280x720',
            type: 'image/png',
            form_factor: 'wide',
            label: 'MarkText editing a markdown document'
          },
          {
            src: 'screenshot-narrow.png',
            sizes: '720x1280',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'MarkText editing a markdown document'
          }
        ]
      },
      injectManifest: {
        // Precache the whole app shell for offline use. Navigation fallback
        // is registered explicitly in sw.ts via NavigationRoute.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,json,woff,woff2,ttf,wasm}'],
        globIgnores: ['**/screenshot-*.png'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024
      },
      devOptions: { enabled: false }
    })
  ] as PluginOption[],
  css: {
    postcss: {
      plugins: [
        postcssPresetEnv({
          stage: 0,
          features: {
            'nesting-rules': true,
            'logical-properties-and-values': false
          }
        })
      ]
    }
  },
   build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        // Function form (rolldown-vite 8 rejects the object form).
        manualChunks: (id: string): string | undefined => {
          // Language components of prismjs must stay separate dynamic-import
          // chunks: muya's loader imports them in dependency order
 // (cpp extends c, etc.) and each component registers on the shared
          // global — merging them into one chunk would evaluate them in
          // bundle order and break the loader's dependency sequencing.
                   if (/node_modules[\\/]prismjs[\\/]components[\\/]prism-[a-z0-9-]+(?:\.min)?\.js(\?|$)/.test(id)) {
            return undefined
          }
          if (id.includes('node_modules')) {
            if (id.includes('element-plus') || id.includes('@element-plus')) return 'elementplus'
            if (id.includes('@muyajs') || id.includes('/muya/')) return 'muya'
            if (id.includes('codemirror')) return 'codemirror'
            if (id.includes('vue') && !id.includes('vuex')) return 'vue'
            if (id.includes('katex')) return 'katex'
            // mermaid and prismjs core share the `vendor` chunk: mermaid's
            // bundle registers `Prism.languages.mermaid` at module scope, so
            // prismjs core (which the prism-global plugin makes assign
            // window.Prism) must evaluate in the same chunk or earlier —
            // splitting mermaid into its own chunk can reorder them.
            return 'vendor'
          }
          return undefined
        }
      }
    }
  }
})
