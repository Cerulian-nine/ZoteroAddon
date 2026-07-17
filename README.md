# CitePocket

A pocket citation picker for academics who write in **Google Docs on an Android tablet** and keep their references in **Zotero**.

Zotero's word-processor integration doesn't exist on Android — no browser-extension surface for the Connector, no add-in surface in the mobile apps. CitePocket works around that two ways: a clipboard **marker** workflow for inline citations while you write, and a **Bibliography** screen that renders and copies the finished reference list directly — no desktop step required for that part.

### Marker workflow (inline citations while writing)

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

## Bibliography (skip the desktop step)

The list icon next to Settings opens **Bibliography** — a running list of the sources you've cited (every marker copy adds its item automatically; you can also add or remove sources by hand). Tap **Copy bibliography** and CitePocket asks the Zotero Web API to render a full, correctly sorted reference list in your chosen citation style (`format=bib&style=…` — the same CSL processor Zotero itself uses), then copies it as rich text so italics and other formatting survive pasting straight into Google Docs.

This is a separate, simpler path than the marker roundtrip above: no ODF-Scan plugin, no downloading the doc, no desktop machine required — but it does need an internet connection, since the rendering happens on Zotero's servers, and it produces a static reference list rather than the live, renumbering-aware citations ODF-Scan gives you. Pick whichever fits the moment: markers while you're still drafting and might reorder citations, Bibliography once the source list is settled.

Citation style defaults to APA 7th edition; a handful of other common styles (MLA, Chicago, Harvard, IEEE, Vancouver, Nature) are one tap away, and any other [Zotero style repository](https://www.zotero.org/styles) ID can be typed in under "Custom style ID".

---

## Scan document (check and repair a draft)

The document icon in the top bar opens **Scan document** — upload a draft (.docx, .odt, .txt or .md; a card shows which document is loaded) and run either pass. Nothing is uploaded to a server; the file is read entirely on-device.

- **Scan document** reads the markers already in the uploaded draft and reconciles them against your bibliography list. It tells you how many sources are cited, which cited sources are **missing from the bibliography** (so the reference list would leave them out — one tap adds them all), which listed sources **aren't cited** anywhere (orphans), and which markers point at items this device **hasn't synced** (from another device or an un-added library).
- **Convert citations to markers** finds plain-text author-year citations — `(Meier, 2021, pp. 44–46)`, `(Kraus & Berger, 2023)`, or the narrative form `Meier (2021)` — and rewrites each as a proper marker, carrying the page locator through. This is the bridge for a draft written with the plain-text copy format (or typed by hand): convert, paste the result back, and the ODF-Scan desktop pass and the Bibliography screen can finally see those citations.

Conversion is **best-effort and safe**: a citation is only rewritten when it maps to exactly one library item. Anything ambiguous (several sources share the author and year) or unknown (no match) is left exactly as it was and listed for you to fix from the picker. Markers already in the draft are never touched — the `(2023)` inside an existing marker's readable cite is not mistaken for a fresh citation.

After a conversion, the marked-up draft can be **downloaded** (as `<name>-markers.txt`) or copied straight back — on Android the download uses the system share sheet, so it saves reliably from inside the installed app. The download/copy are always offered once a conversion has run, even when nothing needed rewriting.

Unknown citations get a **Look up online** step. It first searches your own Zotero library (in case the source is there but not yet synced to this device — those matches can be added straight into your library and bibliography). If a citation isn't in your Zotero at all, it falls back to **Crossref**, the registry behind DOIs, to identify the work.

What you can do with a Crossref match depends on your API key:

- **Write-enabled key** — tap **Add to Zotero** and CitePocket creates the item in your personal library (mapping the Crossref metadata to the right Zotero item type), caches it, and adds it to your bibliography. Re-run Convert and it becomes a marker like any other source. This is the only write the app makes, and only on that explicit tap.
- **Read-only key** — the match is identify-only: it shows the reference and DOI so you can add it in Zotero yourself (via "Add Item by Identifier"), then re-sync. Enable write access on your key in Settings to switch to one-tap adding.

## Setup

```bash
npm install
npm run dev        # local dev server
npm test           # unit tests (vitest)
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build locally
```

First run in the app itself:

1. Create an API key at [zotero.org/settings/keys](https://www.zotero.org/settings/keys) — **read-only** is all you need to cite (your numeric userID is shown on the same page — CitePocket can also read it from the key automatically). Tick **"Allow write access"** if you want the one-tap "Add to Zotero" for sources found on Crossref.
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
    marker.ts        formatMarker() — ALL output syntax lives here, unit-tested
    bibliography.ts  fetchBibliography() — Zotero's format=bib&style=… CSL
                      rendering, chunked by library/50-key limit, HTML→text
    scan.ts          parseMarkers()/scanDocument()/convertCitations() —
                      document marker parsing, cited-vs-bibliography
                      reconciliation, plain-text→marker substitution
    search.ts        tokenizer + in-memory prefix index (instant at 5,000+ items)
    zotero.ts        Web API v3 client: pagination, ?since= incremental sync,
                      Backoff/Retry-After handling, /deleted reconciliation
    db.ts            IndexedDB persistence (items, settings, recents,
                      bibliography list) via `idb`
    creators.ts      creator display strings, year parsing
    clipboard.ts     async clipboard (plain text and text/html) +
                      execCommand fallback, guarded vibration
  ui/                picker, onboarding, settings, bibliography, DOM helpers
                      (vanilla)
  app.ts             one mutable state store + subscribe/notify re-render
public/
  sw.js              hand-written service worker (app shell precache,
                      cache-first assets, api.zotero.org never intercepted)
```

### Why vanilla TypeScript instead of Preact?

The app is four screens with no shared component tree, no complex reconciliation needs, and a hard "keep the bundle small" requirement. A 40-line `h()` helper plus a subscribe/notify store covers everything the UI does; the entire app ships at ~13 kB of gzipped JS *including* the `idb` wrapper. Preact would add ~4.5 kB gzipped and a dependency to track for, essentially, `render()` we can write in one line. If the UI ever grows real component state (it shouldn't — see non-goals), Preact is a drop-in step up since the `h()` signature matches.

### Sync design

- **Full sync**: `GET /users/{id}/items/top?itemType=-attachment&limit=100`, following `start` offsets until `Total-Results` is reached. `/top` excludes child notes/attachments/annotations; the single negation excludes standalone attachments; standalone notes are filtered client-side. (Chaining negations with `||` is OR semantics in Zotero's search syntax and would match everything.)
- **Incremental sync**: the `Last-Modified-Version` response header is stored per library; refreshes send `?since={version}` and reconcile deletions via `GET /deleted?since={version}`. An unchanged library costs one `304`.
- **Rate limits**: `Backoff` headers are honored before the next request; `429`/`503` retry after `Retry-After` (exponential fallback), then give up gracefully.
- The sync engine takes an injected `fetch` and store interface, so all of the above is covered by fast unit tests with no network or browser.

## Privacy & security

- Your API key is stored **only** in IndexedDB on the device and sent **only** to `api.zotero.org` — including the bibliography-rendering requests. It is never sent anywhere else.
- On boot, CitePocket requests [persistent storage](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist) (`navigator.storage.persist()`) so Chrome won't silently evict that IndexedDB data under storage pressure or after a period of inactivity — the most common cause of "my API key disappeared" on Android.
- No analytics, no tracking. The only non-Zotero request is the document scanner's optional **Crossref** fallback (`api.crossref.org`), and only when you tap "Look up online": it sends just the citation's author-and-year text — never your API key, and never the document.
- The UI defaults to read-only keys. The app makes exactly one kind of write — creating an item in your Zotero library — and only when you tap **"Add to Zotero"** on a Crossref match with a write-enabled key. It never edits or deletes anything.
- "Reset all local data" in Settings wipes the cache, recents, and key.

## Accessibility

Keyboard operable throughout, `:focus-visible` outlines, ARIA labels on all icon buttons, `aria-live` status regions, ≥4.5:1 text contrast in both themes, `prefers-color-scheme` light/dark, and `prefers-reduced-motion` respected.

## Testing

`npm test` runs vitest suites for:

- `formatMarker` — all three formats, locator/no-locator, locator normalization, group (`zg:`) vs. user (`zu:`) libraries, multi-cite output, fallbacks for missing metadata;
- `fetchBibliography` — `format=bib` request shape per library, 50-key chunking, csl-entry extraction, HTML→plain-text conversion, and Zotero error handling (invalid style, forbidden key);
- `scan.ts` — marker parsing (offsets, `zu:`/`zg:`→id mapping, rejecting non-markers), `scanDocument` reconciliation (cited counts, missing-from-bibliography, orphans, unresolved markers), and `convertCitations` (parenthetical, multi-source and narrative citations, locator carry-through, ambiguity/no-match handling, diacritic-folded matching, and leaving existing markers untouched);
- the search tokenizer and index — prefix matching, AND semantics, diacritic folding, ranking, and a 5,500-item performance budget;
- the sync engine — pagination, headers, `?since=` increments, `/deleted` reconciliation, `304` handling, `403` errors, `Backoff`/`Retry-After`.

## Known limitations

- **Google Docs paste of a marker is plain text — by design.** The marker is inert until the desktop conversion pass; don't edit the final URI field.
- **The Docs file must be downloaded as `.odt`/`.docx` for the marker-conversion path.** RTF/ODF-Scan can't reach into a live Google Doc. The Bibliography screen doesn't have this limitation — it skips the desktop step entirely — but it does need an internet connection, since Zotero renders the style server-side.
- **Bibliography ordering across libraries/chunks is best-effort.** Each request to Zotero is already correctly sorted for the style you picked, but if your list mixes personal and group libraries, or exceeds 50 sources, the pieces are concatenated rather than re-sorted as one unit. Fine for the common case of a single library under 50 sources; for anything larger, sort by hand after pasting.
- **Pandoc citekeys are approximations.** CitePocket cannot read Better BibTeX's pinned keys through the Zotero Web API, so generated keys can drift from your BBT keys (e.g. disambiguation suffixes like `kraus2023a`). Align the pattern in Settings and spot-check.
- **The plain-text format is not CSL.** It's a simple author-year approximation, not a rendered style.
- **Group sync fetches all groups the key can access.** Very large group sets make the first sync slower; incremental refreshes stay cheap.
- **Split-screen clipboard quirks.** A few Android WebView contexts deny the async clipboard API; CitePocket falls back to a tap-to-select box.
- No collection browsing, metadata editing, PDF viewing, or citation-style preview — deliberately (see the spec's non-goals).
