// ============================================================
// trader-sw.js — service worker for the Swenik Trader app.
//
// What it does:
//   • Caches the app shell (pages, manifest, icons, fonts) so the app
//     opens INSTANTLY from disk — even fully offline.
//   • Stale-while-revalidate: you always see the cached page immediately;
//     a fresh copy downloads in the background for next launch, so GitHub
//     deploys arrive on the second open.
//   • NEVER caches trading data: anything under /api/ or pointing at the
//     backend goes straight to the network, always live.
// Bump CACHE_VERSION on every frontend deploy that must invalidate old files.
// ============================================================

'use strict';

const CACHE_VERSION = 'swenik-trader-v1';
const SHELL = [
  './trade-test.html',
  './trade.html',
  './trader-manifest.json',
  './icon-trader-192.png',
  './icon-trader-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // best-effort: a missing file must not break the install
    await Promise.allSettled(SHELL.map((u) => cache.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Live data: never cached, never intercepted beyond pass-through.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/trader-api/') ||
      url.hostname.endsWith('ondigitalocean.app')) {
    return; // browser default: straight to network
  }

  // Fonts: cache-first opportunistic (they never change).
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put(req, res.clone());
        return res;
      } catch (e) { return hit || Response.error(); }
    })());
    return;
  }

  // App shell (same-origin pages/assets): stale-while-revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      const refresh = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (hit) { event.waitUntil(refresh); return hit; }
      const fresh = await refresh;
      if (fresh) return fresh;
      // offline and not cached: fall back to the sandbox shell for navigations
      if (req.mode === 'navigate') {
        const shell = await cache.match('./trade-test.html');
        if (shell) return shell;
      }
      return Response.error();
    })());
  }
});
