'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker and tells it which resources this page used,
 * so the next visit works without a network.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
        const target = reg.active ?? navigator.serviceWorker.controller;
        if (!target) return;

        const sameOrigin = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((n) => n.startsWith(location.origin));

        const urls = Array.from(new Set([location.href, ...sameOrigin]));
        target.postMessage({ type: 'CACHE_URLS', urls });
        console.info(`[sw] registered, asked to cache ${urls.length} resources`);
      } catch (e) {
        console.warn('[sw] registration failed:', (e as Error).message);
      }
    };

    if (document.readyState === 'complete') void register();
    else window.addEventListener('load', () => void register(), { once: true });
  }, []);

  return null;
}
