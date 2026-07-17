# Session context (read this first)

Standing instructions from the repo owner. Read this file at the start of
every session, before doing anything else.

## Workflow — no need to ask

The owner has explicitly pre-authorized the following, for this repo, in
every future session. Do not stop to ask permission for these steps —
just do them and report what happened:

1. **Pull** the latest changes before starting work (`git fetch` + `git pull`
   on the relevant branch) so you're not working from stale state.
2. When a task is finished:
   - **Push** the branch (`git push -u origin <branch>`).
   - **Open a PR** into `main` (check for a PR template first; there isn't
     one in this repo as of 2026-07-17, so write a normal description).
   - **Merge the PR** yourself once tests/build pass — don't wait for the
     owner to say "go ahead."
   - **Deploy**: merging into `main` is the deploy trigger — pushing to
     `main` runs `.github/workflows/deploy-sota.yml`, which builds and
     pushes the site to sota.io automatically. No separate manual step is
     normally needed; only use `workflow_dispatch` by hand
     (`mcp__github__actions_run_trigger` with `run_workflow`) if the
     automatic push-triggered run didn't fire or failed for an unrelated
     reason.
3. Still run `npm test` and `npm run build` before merging — green CI/local
   checks are the bar, not a stand-in for asking permission.
4. Still communicate what you did (this is about not blocking on
   confirmation, not about going silent) — a short summary after pushing /
   opening the PR / merging / deploying is expected.
5. **Always update this file (`context.md`) after every build.** Whenever you
   run `npm run build` for a change you're shipping, refresh the "Repo shape"
   section below so it reflects what now exists (new screens, new `src/lib`
   modules, changed deploy details). Keep it terse — it's a map, not a
   changelog. This keeps the file the accurate first-read it's meant to be,
   and it must land in the same commit/PR as the change that prompted it.
   (Owner instruction, 2026-07-17.)

This overrides the general default of asking before pushing/merging/
deploying — it applies specifically to this repo (`cerulian-nine/zoteroaddon`),
per the owner's instruction on 2026-07-17.

## Repo shape

- **CitePocket**: a Zotero + Google Docs citation-picker PWA for Android
  tablets (Zotero has no word-processor integration on Android). See
  `README.md` for the full picture — marker-based clipboard workflow, plus
  a Bibliography screen that renders a full reference list via the Zotero
  Web API and copies it as rich text.
- **Screens** (`src/ui/`, vanilla TS, one mutable store in `src/app.ts`):
  picker, onboarding, settings, bibliography, and **document** (Scan
  document — reconcile the markers in a pasted-or-uploaded draft against
  the bibliography list, and convert plain-text citations into markers).
  The document screen takes a draft two ways: paste into the textarea, or
  **Upload document** (.docx / .odt / .txt/.md) — the file is parsed
  in-browser and its text fills the same textarea; nothing is uploaded or
  stored.
- **`src/lib/`**: `marker.ts` (all marker output syntax), `scan.ts`
  (document marker parsing + cited-vs-bibliography reconciliation +
  plain-text→marker conversion), `docimport.ts` (uploaded file → plain
  text: .docx/.odt unzipped with `fflate` and their XML text extracted,
  .txt read as-is, legacy .doc rejected with a "save as .docx" message),
  `bibliography.ts`, `search.ts`, `zotero.ts`, `db.ts`, `creators.ts`,
  `clipboard.ts`. Pure logic is unit-tested (`tests/`, vitest); the Scan
  screen's upload/re-render wiring has a jsdom test
  (`tests/document.test.ts`, `@vitest-environment jsdom`).
- Deploy target: sota.io, via `scripts/sota-deploy.mjs` and the GitHub
  Action above. Project ID is pinned in the workflow file.
- No backend, no build-time secrets beyond `SOTA_API_KEY` (GitHub Actions
  secret, used only in CI).
