// Custom service worker for the MarkText web app (injectManifest strategy).
// The generated asset manifest precaches the entire app shell, so the editor
// boots with zero network access after the first visit.

/// <reference lib="webworker" />
/// <reference types="vite/client" />

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { NetworkFirst, CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

declare let self: ServiceWorkerGlobalScope

// Precache the build output (vite-plugin-pwa injects the manifest here).
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// SPA navigation: serve index.html for every in-scope navigation request.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/sw\.js$/, /^\/manifest\.webmanifest$/, /workbox/]
  })
)

// Cross-origin assets (fonts, PlantUML renders): network-first with a cache.
registerRoute(
  ({ url }) => url.origin !== self.location.origin,
  new NetworkFirst({
    cacheName: 'external-assets',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 64,
        maxAgeSeconds: 7 * 24 * 3600,
        purgeOnQuotaError: true
      })
    ]
  })
)

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void self.skipWaiting()
  }
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async() => {
      await self.clients.claim()
    })()
  )
})

export {}
