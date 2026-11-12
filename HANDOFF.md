# AccentLab Studio continuation handoff

**Updated:** 2026-11-13
**Site brand:** AccentLab Studio
**Webdev project UID:** `wdp_d7c415ad0e73fced06ca7e72`
**Project resource:** `manus-resource://manus-webdev/project/wdp_d7c415ad0e73fced06ca7e72`

This note contains no OAuth secret values, session codes, temporary Colab URLs, or recordings.

## Current source of truth

Continue development in the Webdev project above. Its `origin` is the Manus-managed repository for this Webdev project; it is not a GitHub remote. The current project config has protected `GOOGLE_COLAB_CLIENT_ID` and `GOOGLE_COLAB_CLIENT_SECRET` values and has auto-publish enabled. A push to the project’s `main` branch can therefore publish the change; confirm deployment success before treating a checkpoint as a verified live release.

The current app pipeline is `identity-anchored-v4-expressive-text-safe`. It preserves the two-pass, chunked, text-verified `identity-anchored-v3-text-safe` core and adds explicit mood and speaker-vocalization cues. “Seed-VC v2” is the pinned upstream model version, not the old AccentLab three-pass “v2 trial.” The historical three-pass path remains unverified and is not restored. The 85–95% likeness request is an aspiration, not a measured or guaranteed score.

## Backups and stored data

- **GitHub:** No GitHub remote is connected to this Webdev project, and this v4 change has not been pushed to GitHub. The prior audit found `topspeedmgt/accentlab-backup` and `topspeedmgt/accentlab-test` had identical `main` commit `f27a874506702f783288e53120f37707ef225242` and tree `383eead45d4950991c67dbde7389c113b6314e46` as of 2026-11-12. Those are old snapshots; they do not contain the current v4 expression changes. Do not delete either repository until a fresh complete comparison and a separate backup of this Webdev source are confirmed.
- **Google Drive:** The prior metadata audit found historical source ZIPs, Git bundles, checksums, TODO files, Colab notebooks, and some WAV/script assets. This build did not edit, upload, move, or delete any Drive files. Drive is not this website’s automatic source-control or generation-output store.
- **Generated audio:** The app has no managed database and does not save generated WAVs to Drive. The in-browser result is temporary; Colab processes event/reference files in a temporary runtime and applies its existing short output retention.
- **Secrets:** The two Google OAuth secret names are configured as protected Webdev secrets. Never add their values to GitHub, this file, or chat. If a new project/account lacks the protected values, use the secure secret-input flow and recheck its Google OAuth callback registration for that site’s actual domain.

## What is implemented and what remains open

The v4 UI supports `[mood:neutral]`, `[mood:playful]`, `[mood:excited]`, `[mood:sad]`, `[mood:calm]`, `[laugh]`, `[giggle]`, and `[sob]`. Mood markers apply until the next mood marker; laugh/giggle and sob cues insert optional short clips from the original speaker. Mood shaping is approximate. The speaker samples are inserted sounds, not newly generated vocal events. The Pronunciation Guard checks speech segments and does not treat vocal samples as spoken words.

The code, tests, TypeScript check, production build, Python syntax check, and source-synchronization check pass. These offline checks do not establish naturalness or an 85–95% identity score. The managed Google OAuth login was verified earlier. A prior managed bootstrap failed because its installer used `/content/accentlab-runtime/seed-vc` but its preflight checked `/content/seed-vc`; the managed paths are now aligned and an AST regression protects that agreement. The fix has not yet been retried on a live Colab runtime, so automatic URL/access-code population and readiness remain open in `TODO.md`. No real-speaker v4 listening comparison has been completed. The separate initial-start optimization is explicitly deferred until the user asks to resume it.

## Low-friction continuation across accounts

1. Prefer continuing in the same Webdev project and owner account. If using another account, grant that account access to this exact project (or invite it into the owning team and explicitly verify it can open this project). Joining a team alone did not grant access to a previous AccentLab project in the earlier audit.
2. Do not start another duplicate project as the first step. If the other account cannot access this project, use one deliberately selected GitHub repository as a source backup/import after checking branch and tree state; then securely configure secrets, domains, OAuth callback, and publish settings in the destination project.
3. Use Drive ZIP/bundle/notebook files only as historical recovery snapshots, not as the current editing source. Keep the `TODO.md` and this handoff file with the code.
4. Do not delete older websites or either GitHub repository yet. First verify a successfully published v4 site, managed free-T4 readiness, the current OAuth callback, and an independently restorable source backup. Deleting early can lose a working URL/domain, project history/configuration, or the only copy of older code/settings.
5. Avoid personal-profile-to-team migration unless the goal is to move the whole personal account. Manus’s migration guide says it is irreversible, changes data ownership to the organization, cancels an active personal Pro subscription, and resets the original personal profile. It is not the same as sharing one Webdev project.

Manus documentation: [Make a Copy](https://manus.im/docs/website-builder/make-a-copy) (a copy is an independent project; publishing/domain and GitHub linkage are not inherited), [Collab](https://manus.im/docs/features/collab), and [personal-to-team data migration](https://help.manus.im/en/articles/14816451-how-to-migrate-personal-account-data-to-a-team-account).

## Safe maintenance commands

From the project root:

```bash
pnpm check
pnpm test
pnpm build
pnpm check:colab-sync
```

After editing the canonical `colab/accentlab_seedvc_backend.py`, run `pnpm sync:colab` and then `pnpm check:colab-sync`. Preserve the existing free-T4-only, safe start/reuse, manual URL/access-code fallback, strict production origin checks, and narrow confirmed repair rules. Do not stop/delete an unrelated Colab runtime or use a paid fallback.
