# CitePocket

A pocket citation picker for academics who write in **Google Docs on an Android tablet** and keep their references in **Zotero**.

Zotero's word-processor integration doesn't exist on Android — no browser-extension surface for the Connector, no add-in surface in the mobile apps. CitePocket works around that with a clipboard workflow:

1. Open CitePocket (in split-screen next to Docs).
2. Type a few letters of an author or year.
3. Tap the reference, optionally add a page number, **Copy**.
4. Paste the plain-text citation marker into your doc and keep writing.
5. Later, on a desktop, the [RTF/ODF-Scan for Zotero](https://zotero-odf-scan.github.io/zotero-odf-scan/) plugin converts every marker into a live Zotero citation and builds the bibliography.

The whole app is tuned for one metric: **under 5 seconds from opening to having a marker on your clipboard.**

---

## The roundtrip, end to end

**On the tablet**, CitePocket copies a *Scannable Cite* marker — five pipe-separated fields inside curly braces:

```
{ | Kraus & Berger, (2023) |pp. 44-46 | |zu:1234567:ABCD1234}
```

| Field | Content |
| --- | --- |
| 1 | Prefix (empty by default) |
| 2 | Readable cite — display only, for your eyes while writing |
| 3 | Locator ("pp. 44-46", "ch. 3") |
| 4 | Suffix (empty by default) |
| 5 | Item URI — the machine link to the Zotero item. **Never edit this.** |

Markers are plain text and completely harmless in the document — they survive Google Docs, exports, and co-editing.

**On the desktop**, when a draft is ready:

1. Download the doc as `.odt` (File → Download → OpenDocument) or `.docx`.
2. In Zotero (with the [RTF/ODF-Scan plugin](https://github.com/Juris-M/zotero-odf-scan-plugin/releases/latest) installed): Tools → ODF Scan → "markers to citations", pick the file.
3. Open the converted file in LibreOffice (or Word for `.docx`), click *Set Document Preferences* in the Zotero toolbar, choose a citation style — every marker becomes a live citation. *Insert Bibliography* finishes the job.

Every `{ | Meier, (2021) | … }` becomes `(Meier, 2021)` in your chosen style, with a matching bibliography entry.

Item URIs use `zu:{userID}:{itemKey}` for personal libraries and `zg:{groupID}:{itemKey}` for group libraries, matching the plugin's Scannable Cite translator.

### Other copy formats

Selectable during onboarding and in Settings:

- **Pandoc citekeys** — `[@kraus2023]`, with a configurable key pattern (`[auth]`, `[Auth]`, `[year]`, `[shorttitle]`). This is a *best-effort* generator: make sure the pattern mirrors your Better BibTeX key format, or Pandoc won't resolve the keys.
- **Plain text** — `(Kraus & Berger, 2023, pp. 44–46)`, a simple author-year approximation for people who finalize citations by hand.

---

## Setup

```bash
npm install
npm run dev        # local dev server
npm test           # unit tests (vitest)
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build locally
```

First run in the app itself:

1. Create a **read-only** API key at [zotero.org/settings/keys](https://www.zotero.org/settings/keys) (your numeric userID is shown on the same page — CitePocket can also read it from the key automatically).
2. Paste the key into onboarding. It's validated against `GET /keys/current` before you can continue.
3. Pick a copy format, try the test marker, and let the library sync.

## Deploying to a static host

The build output in `dist/` is a fully static site — no backend, no environment variables, no build-time secrets. The Vite config uses a relative `base`, so it works from a domain root **or** a subpath:

- **GitHub Pages**: push `dist/` to a `gh-pages` branch (or use an action). Project pages (`user.github.io/citepocket/`) work out of the box.
- **Netlify / Vercel / Cloudflare Pages**: build command `npm run build`, publish directory `dist`.
- Any web server that can serve files over **HTTPS** (required for service workers and the async clipboard API).

Install it on the tablet via Chrome's "Add to Home Screen". After the first successful sync, search, recents, and copying work fully offline.

## Architecture

```
src/
  lib/
    marker.ts     formatMarker() — ALL output syntax lives here, unit-tested
    search.ts     tokenizer + in-memory prefix index (instant at 5,000+ items)
    zotero.ts     Web API v3 client: pagination, ?since= incremental sync,
                  Backoff/Retry-After handling, /deleted reconciliation
    db.ts         IndexedDB persistence (items, settings, recents) via `idb`
    creators.ts   creator display strings, year parsing
    clipboard.ts  async clipboard + execCommand fallback, guarded vibration
  ui/             picker, onboarding, settings, DOM helpers (vanilla)
  app.ts          one mutable state store + subscribe/notify re-render
public/
  sw.js           hand-written service worker (app shell precache,
                  cache-first assets, api.zotero.org never intercepted)
```

### Why vanilla TypeScript instead of Preact?

The app is three screens with no shared component tree, no complex reconciliation needs, and a hard "keep the bundle small" requirement. A 40-line `h()` helper plus a subscribe/notify store covers everything the UI does; the entire app ships at ~10.7 kB of gzipped JS *including* the `idb` wrapper. Preact would add ~4.5 kB gzipped and a dependency to track for, essentially, `render()` we can write in one line. If the UI ever grows real component state (it shouldn't — see non-goals), Preact is a drop-in step up since the `h()` signature matches.

### Sync design

- **Full sync**: `GET /users/{id}/items/top?itemType=-attachment&limit=100`, following `start` offsets until `Total-Results` is reached. `/top` excludes child notes/attachments/annotations; the single negation excludes standalone attachments; standalone notes are filtered client-side. (Chaining negations with `||` is OR semantics in Zotero's search syntax and would match everything.)
- **Incremental sync**: the `Last-Modified-Version` response header is stored per library; refreshes send `?since={version}` and reconcile deletions via `GET /deleted?since={version}`. An unchanged library costs one `304`.
- **Rate limits**: `Backoff` headers are honored before the next request; `429`/`503` retry after `Retry-After` (exponential fallback), then give up gracefully.
- The sync engine takes an injected `fetch` and store interface, so all of the above is covered by fast unit tests with no network or browser.

## Privacy & security

- Your API key is stored **only** in IndexedDB on the device and sent **only** to `api.zotero.org`.
- No analytics, no tracking, no third-party requests of any kind.
- The UI recommends read-only keys; the app never issues a write request.
- "Reset all local data" in Settings wipes the cache, recents, and key.

## Accessibility

Keyboard operable throughout, `:focus-visible` outlines, ARIA labels on all icon buttons, `aria-live` status regions, ≥4.5:1 text contrast in both themes, `prefers-color-scheme` light/dark, and `prefers-reduced-motion` respected.

## Testing

`npm test` runs vitest suites for:

- `formatMarker` — all three formats, locator/no-locator, locator normalization, group (`zg:`) vs. user (`zu:`) libraries, multi-cite output, fallbacks for missing metadata;
- the search tokenizer and index — prefix matching, AND semantics, diacritic folding, ranking, and a 5,500-item performance budget;
- the sync engine — pagination, headers, `?since=` increments, `/deleted` reconciliation, `304` handling, `403` errors, `Backoff`/`Retry-After`.

## Known limitations

- **Google Docs paste is plain text — by design.** The marker is inert until the desktop conversion pass; don't edit the final URI field.
- **The Docs file must be downloaded as `.odt`/`.docx` for conversion.** RTF/ODF-Scan can't reach into a live Google Doc.
- **Pandoc citekeys are approximations.** CitePocket cannot read Better BibTeX's pinned keys through the Zotero Web API, so generated keys can drift from your BBT keys (e.g. disambiguation suffixes like `kraus2023a`). Align the pattern in Settings and spot-check.
- **The plain-text format is not CSL.** It's a simple author-year approximation, not a rendered style.
- **Group sync fetches all groups the key can access.** Very large group sets make the first sync slower; incremental refreshes stay cheap.
- **Split-screen clipboard quirks.** A few Android WebView contexts deny the async clipboard API; CitePocket falls back to a tap-to-select box.
- No collection browsing, metadata editing, PDF viewing, or citation-style preview — deliberately (see the spec's non-goals).
