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

/**
 * Copy rich text to the clipboard as both `text/html` and `text/plain`, so
 * pasting into Google Docs keeps formatting (italics on journal titles,
 * etc.) instead of landing as inert plain text like a marker does.
 * Returns true on success, false when the caller should fall back to a
 * "tap to select" box (the plain-text `text` is what gets shown there).
 */
export async function copyHtml(html: string, text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return true;
    }
  } catch {
    // fall through to fallback
  }
  // Legacy fallback: select a hidden element holding the rendered HTML and
  // let execCommand('copy') capture both representations from the selection.
  try {
    const holder = document.createElement('div');
    holder.setAttribute('contenteditable', 'true');
    holder.style.position = 'fixed';
    holder.style.opacity = '0';
    holder.innerHTML = html;
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const ok = document.execCommand('copy');
    selection?.removeAllRanges();
    holder.remove();
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
