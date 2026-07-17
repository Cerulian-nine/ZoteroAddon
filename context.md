# CitePocket — project context

A working reference for anyone (human or agent) picking up this codebase. It
captures *what the app is*, *how it's put together*, and *where each concern
lives*, so a change can be made without re-deriving the architecture. The
user-facing pitch and setup live in `README.md`; this file is the map.

## What it is

A static, backend-less TypeScript PWA that turns a Zotero library into a fast
citation picker for writing in Google Docs on Android (where Zotero's
word-processor integration doesn't exist). Two workflows:

1. **Copy citation markers** (the original flow) — copy a plain-text marker per
   citation, then convert them into live citations + a bibliography later on a
   desktop with the RTF/ODF-Scan plugin.
2. **Copy bibliography** (in-app, online) — skip the desktop conversion step
   entirely by rendering a finished, styled reference list directly in the app
   via the Zotero Web API's CSL engine, then paste it into the document.

Everything is offline-first except the deliberately-online Copy bibliography
action.

## Architecture at a glance

```
src/
  app.ts            one mutable state store + subscribe/notify re-render;
                    sync + bibliography orchestration
  main.ts           boot: load cache → render → background sync; SW registration
  lib/
    types.ts        Settings, CachedItem, LibraryRef, itemId()
    marker.ts       formatMarker() — ALL marker output syntax lives here
    bibliography.ts fetchBibliography() — Web API format=bib CSL rendering
    search.ts       tokenizer + in-memory prefix index
    zotero.ts       Web API v3 client: apiGet (Backoff/Retry-After), sync,
                    libraryPrefix(), key/group helpers, ZoteroApiError
    db.ts           IndexedDB persistence via `idb`
    creators.ts     creator display strings, year parsing
    clipboard.ts    async clipboard + execCommand fallback, guarded vibration
  ui/
    picker.ts       screen 1: search, copy, multi-cite tray, bibliography bar
    onboarding.ts   screen 2: key validation + first sync
    settings.ts     screen 3: credentials, formats, citation style, bibliography
    copyBib.ts      shared "Copy bibliography" action (build → clipboard → toast)
    dom.ts          h() helper, toast, icons, clipboard-fallback box
public/
  sw.js             app-shell precache; api.zotero.org is never intercepted
```

### Conventions

- Vanilla TS. UI is built with the `h()` DOM helper in `ui/dom.ts` — no
  framework. Screens fully re-render from state on `notify()`.
- One mutable `state` object in `app.ts`; `subscribe(fn)` / `notify()` drive
  re-render. No local component state beyond a few module-level UI scratch vars
  (open locator field, search query).
- Network code takes an **injected `fetch`** so it's unit-testable without a
  network or browser (`syncLibrary`, `fetchBibliography`).
- All marker output syntax is isolated in `marker.ts`; all API request plumbing
  (auth headers, Backoff/Retry-After) is isolated in `zotero.ts` `apiGet`.

## Persistence (IndexedDB, `db.ts`)

Database `citepocket`, **version 2**. Object stores:

| store     | keyPath | contents |
| --------- | ------- | -------- |
| `items`   | `id`    | cached library items (composite id `u:{id}:{key}` / `g:{id}:{key}`) |
| `meta`    | —       | `settings`, per-library sync versions, `syncMeta` |
| `recents` | `id`    | recently copied items, capped at 15 |
| `cited`   | `id`    | the current document's cited items, **uncapped** running list |

The v2 upgrade is version-guarded (`oldVersion < 1` creates the original three
stores; `oldVersion < 2` adds `cited`), so existing installs migrate without
data loss. `resetAllData()` clears all four stores.

`Settings` (`types.ts`) includes `citationStyle` (CSL short-name, default
`apa`) alongside `format`, `citekeyPattern`, `apiKey`, `userId`, `syncGroups`,
`onboarded`.

## Copy bibliography feature

The one deliberately-online feature. Delegates CSL formatting to Zotero's Web
API — the same engine the desktop plugin uses — instead of formatting in-app.

- **Tracking**: every copy (single or multi-cite tray) calls `markCited()` in
  `app.ts`, which appends the item to the `cited` store via `db.addCited()`
  (idempotent — re-citing keeps first-cited order). This list is separate from
  the capped `recents` list and persists until explicitly cleared.
- **Rendering** (`lib/bibliography.ts`, `fetchBibliography()`):
  - Endpoint: `GET /{library}/items?itemKey=KEY1,KEY2,…&format=bib&style={style}`.
    `format=bib` returns an XHTML reference list wrapped in
    `<div class="csl-bib-body">` with one `<div class="csl-entry">` per item.
  - `style` is a CSL short-name (filename without `.csl`), e.g. `apa`,
    `modern-language-association`, `chicago-note-bibliography`.
  - Items are **grouped by library** (the call can't mix user + group
    libraries) — one request per library, concatenated in first-seen order.
  - Item keys are **chunked** (`CHUNK_SIZE = 50`) because Zotero caps the
    `itemKey` list; entries from all chunks are concatenated.
  - Requests go through the shared `apiGet` (auth headers, Backoff/Retry-After).
  - HTML parsing is **DOM-free** (regex extraction of `csl-entry` blocks +
    entity decoding) so it runs under vitest/node. Returns `{ html, text,
    count }`; the plain-text rendering is what goes on the clipboard.
- **Orchestration**: `app.ts#buildBibliography()` guards empty list / missing
  key / offline with friendly errors and normalizes non-`ZoteroApiError`
  failures into a "couldn't reach Zotero" message. `ui/copyBib.ts` wraps it in
  the clipboard + toast + tap-to-select fallback plumbing.
- **UI surfaces**: a citation-style dropdown, "Copy bibliography (N)", and
  "Clear cited list" in Settings; a "Copy bibliography" bar in the picker when
  the current document has cited items.
- **Offline behavior**: fails gracefully with a clear message; never crashes.
  The service worker leaves cross-origin `api.zotero.org` requests untouched, so
  it doesn't interfere.

> Note: the bibliography is copied as **plain text** (reusing the text-only
> clipboard helper), so content is preserved but italics / hanging indents are
> not. A rich-text (HTML) clipboard path would be the enhancement if formatting
> fidelity is needed.

## Sync design (`zotero.ts`)

- Full sync: `/users/{id}/items/top?itemType=-attachment&limit=100`, following
  `start` offsets until `Total-Results`. `/top` + single negation exclude child
  items and standalone attachments; standalone notes are filtered client-side.
- Incremental: per-library `Last-Modified-Version` drives `?since={version}`;
  deletions reconciled via `/deleted?since=`. Unchanged library = one `304`.
- Rate limits: `Backoff` honored before the next request; `429`/`503` retry
  after `Retry-After` with exponential fallback, then give up gracefully.

## Testing (`npm test`, vitest)

- `tests/marker.test.ts` — all marker formats, locators, `zu:`/`zg:` URIs,
  multi-cite, metadata fallbacks.
- `tests/search.test.ts` — tokenizer + index, prefix/AND semantics, diacritic
  folding, ranking, performance budget.
- `tests/sync.test.ts` — pagination, headers, `?since=`, `/deleted`, `304`,
  `403`, `Backoff`/`Retry-After` (injected fetch).
- `tests/bibliography.test.ts` — library grouping, key chunking, entity
  decoding, multi-library concatenation, and error handling (injected fetch).

Before finishing any change: `npm run build` (tsc typecheck + vite build) and
`npm test`.
