/**
 * Copy text to the clipboard.
 * Returns true on success, false when the async Clipboard API is unavailable
 * or the permission was denied — the caller then shows a "tap to select"
 * fallback box instead.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to fallback
  }
  // Legacy fallback: hidden textarea + execCommand. Works in more embedded
  // webviews than the async API.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Short haptic tick on copy, where supported (guarded per spec). */
export function vibrate(): void {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(30);
    }
  } catch {
    /* ignore */
  }
}
