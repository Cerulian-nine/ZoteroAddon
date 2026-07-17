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

This overrides the general default of asking before pushing/merging/
deploying — it applies specifically to this repo (`cerulian-nine/zoteroaddon`),
per the owner's instruction on 2026-07-17.

## Repo shape

- **CitePocket**: a Zotero + Google Docs citation-picker PWA for Android
  tablets (Zotero has no word-processor integration on Android). See
  `README.md` for the full picture — marker-based clipboard workflow, plus
  a Bibliography screen that renders a full reference list via the Zotero
  Web API and copies it as rich text.
- Deploy target: sota.io, via `scripts/sota-deploy.mjs` and the GitHub
  Action above. Project ID is pinned in the workflow file.
- No backend, no build-time secrets beyond `SOTA_API_KEY` (GitHub Actions
  secret, used only in CI).
