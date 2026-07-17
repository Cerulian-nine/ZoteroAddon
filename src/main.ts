import './styles.css';
import { state, subscribe, loadFromCache, runSync } from './app';
import { renderPicker } from './ui/picker';
import { renderOnboarding } from './ui/onboarding';
import { renderSettings } from './ui/settings';
import { renderBibliography } from './ui/bibliography';
import { renderDocument } from './ui/document';

const root = document.getElementById('app')!;

function render(): void {
  switch (state.screen) {
    case 'picker': renderPicker(root); break;
    case 'onboarding': renderOnboarding(root); break;
    case 'settings': renderSettings(root); break;
    case 'bibliography': renderBibliography(root); break;
    case 'document': renderDocument(root); break;
  }
}

subscribe(render);

async function boot(): Promise<void> {
  // Offline-first: show the cached library instantly…
  await loadFromCache();
  render();
  // …then refresh in the background if we're online and configured.
  // Incremental sync (?since=) makes this cheap.
  if (state.settings.onboarded && navigator.onLine) {
    void runSync();
  }
}

void boot();

// Ask the browser to make our IndexedDB storage durable. Without this,
// Chrome (Android in particular) treats the origin as "best-effort" and
// can silently evict it — settings, API key, and the whole cache — under
// storage pressure or after a stretch of inactivity, which reads to the
// user as "the API key is gone every time I open the page." Persisted
// origins are exempt from that eviction.
if (navigator.storage?.persist) {
  void navigator.storage.persist().then((granted) => {
    if (!granted) console.warn('Persistent storage was not granted; local data may be evicted.');
  });
}

// PWA: register the service worker (production builds only — Vite dev
// serves from memory and a SW would just get in the way).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .catch((err) => console.warn('Service worker registration failed:', err));
  });
}
