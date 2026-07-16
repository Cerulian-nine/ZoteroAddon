import './styles.css';
import { state, subscribe, loadFromCache, runSync } from './app';
import { renderPicker } from './ui/picker';
import { renderOnboarding } from './ui/onboarding';
import { renderSettings } from './ui/settings';

const root = document.getElementById('app')!;

function render(): void {
  switch (state.screen) {
    case 'picker': renderPicker(root); break;
    case 'onboarding': renderOnboarding(root); break;
    case 'settings': renderSettings(root); break;
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

// PWA: register the service worker (production builds only — Vite dev
// serves from memory and a SW would just get in the way).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .catch((err) => console.warn('Service worker registration failed:', err));
  });
}
