# Movie marathon tracker + who's-watching profiles

## Problem

Niranjan and his girlfriend track shared movie-watching progress (e.g. an MCU rewatch) in an external Google Keep checklist: a manually ordered list of titles, each with per-person scores (`A:9/10 N:10/10`) and freeform notes (`poopy movie 3/10`, `Skipped - too many recasts`). It works but isn't tied to PookieFlix at all, and there's no per-person identity in the app to attribute a review to.

## Goals

- Recreate the "marathon list" workflow inside PookieFlix: named ordered lists of movies, each markable pending/done/skipped, each independently reviewable (1–10 score + optional note) by either person.
- Add a lightweight "who's watching" concept so a review can be attributed to a person, without building real multi-user accounts.
- Support movies whether or not they're in the PookieFlix library — marathons commonly include titles never hosted in the app (watched elsewhere, skipped, or only partially watched).

## Non-goals

- No migration/import of the existing Google Keep list. It's freeform and irregularly formatted (some items have two scores, some only a note, some say "skipped" or "summary only"); auto-parsing it reliably costs more than manually re-entering the handful of marathons worth keeping.
- No auto-detection of "watched" status from library playback history. PookieFlix currently only stores a resume position (`last_time`/`last_played_at`), not a real completion signal, so it can't reliably infer "finished." Marking done/skipped stays a manual action.
- No real multi-user auth (separate passwords, per-profile access control, spoofing prevention). This is a review-attribution label for two people sharing one household login, not an access-control system.
- No TMDB/poster-art integration. Non-library movie entries are a plain title, matching the current list.

## Identity: "who's watching" screen

The household already has exactly one shared password (`server/src/auth.ts`, `wt_session` cookie) gating the whole app — that stays as-is and is not weakened. `Settings.tsx` already stores two display names (`USER_NAME`, `PARTNER_NAME`); the who's-watching screen reuses these directly rather than introducing a new profile-name field.

- New route `/whos-watching`, shown once per session right after the password gate — i.e. it becomes the landing screen instead of Home, exactly once (until the browser's local viewer-selection is cleared).
- Two tappable tiles (initials-based avatar, following the app's existing color tokens), one per name from Settings.
- Tapping a tile stores the choice in `localStorage` (e.g. `pf_viewer = "niranjan" | "anamika"`) and navigates to Home. This is purely client-side — no server session, no per-profile password.
- A small "switch profile" icon added to the topbar (next to Settings) clears the stored viewer and returns to `/whos-watching`, without re-prompting the household password.
- If a review action is reached with no viewer selected yet (e.g. a deep link), redirect to `/whos-watching` first rather than failing or guessing.
- If `USER_NAME`/`PARTNER_NAME` are unset in Settings, fall back to generic labels ("Person 1"/"Person 2") — must not crash if Settings was never filled in.

This is intentionally not real auth: the client sends whichever viewer string is currently selected when it calls the review endpoints, and the server trusts it. Given this is a two-person household app behind one shared password, spoofing your partner's review isn't a threat worth building defenses against.

## Data model

Three new SQLite tables (same `data/app.db`, alongside existing `rooms`/`library_meta`):

```sql
CREATE TABLE marathons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE marathon_items (
  id INTEGER PRIMARY KEY,
  marathon_id INTEGER NOT NULL REFERENCES marathons(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  library_filename TEXT,          -- nullable; optional link to a real library file
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'done' | 'skipped'
  created_at TEXT NOT NULL
);

CREATE TABLE marathon_reviews (
  item_id INTEGER NOT NULL REFERENCES marathon_items(id) ON DELETE CASCADE,
  viewer TEXT NOT NULL,           -- e.g. "niranjan" | "anamika" — free string, not a FK (no user table exists)
  score INTEGER,                  -- 1-10, nullable
  note TEXT,                      -- nullable
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_id, viewer)
);
```

Notes:
- `library_filename` is a soft reference, not a foreign key with `ON DELETE` behavior — if the underlying file is later moved/deleted from disk, the item just behaves as a plain title (see Error handling).
- `marathon_reviews` uses `(item_id, viewer)` as the primary key so each person has exactly one review per item, upserted on edit — matches the "independent, whenever, editable" review model.
- A blank/absent score is stored as `NULL`, rendered as "—" in the UI, never coerced to `0`.

## API (REST, matching existing `/api/...` fetch pattern, Fastify)

- `GET /api/marathons` — list marathons with item counts / done counts for progress display (e.g. "8/13 done").
- `POST /api/marathons` — create `{ name }`.
- `PATCH /api/marathons/:id` — rename, or reposition.
- `DELETE /api/marathons/:id` — cascades to items and reviews (see confirm UX below).
- `GET /api/marathons/:id` — marathon detail with ordered items + each item's reviews.
- `POST /api/marathons/:id/items` — add item `{ title, library_filename? }`, appended at end position.
- `PATCH /api/marathons/:id/items/:itemId` — update `{ title?, library_filename?, status?, position? }`.
- `DELETE /api/marathons/:id/items/:itemId` — cascades to its reviews (confirm UX).
- `PUT /api/marathons/:id/items/:itemId/review` — upsert current viewer's review `{ viewer, score?, note? }`.

All routes reuse the existing `requireAdmin` (household-password) guard — the who's-watching selection is not itself an auth boundary, it rides inside the already-authenticated session.

## Screens

**Marathons list** (new nav destination, alongside Home/Library/Settings): cards showing each marathon's name and progress ("8/13 done"). "+ New marathon" creates one with just a name, then opens straight into it empty.

**Marathon detail**: ordered list of items. Each row shows:
- Title (and a small "linked" icon if tied to a library file — tapping the row body opens the player for that file; tapping elsewhere opens the review/edit sheet)
- Status control (pending/done/skipped) — a simple 3-state toggle, not a Radix Dialog
- Both reviews inline once present, e.g. `N: 9/10 · A: 10/10`; missing ones shown as `— ` for that initial
- Reordering via up/down move buttons for v1 (not drag-and-drop — smaller lift; the existing app has no drag-reorder pattern to reuse, and this is easy to upgrade later if two-button reordering feels tedious in practice)

**Add item**: title text field + optional "link to a library file" picker (reuses the existing library file list from `/api/library`).

**Review edit** (per item, per current viewer): score 1–10 (optional) + note (optional, freeform text), matches the old list's shape exactly. Saved independently by whoever's the current viewer — no prompt to also fill in the other person's score.

## Error handling / edge cases

- **Deleting a marathon or item**: confirm dialog (Radix `AlertDialog`, matching existing patterns in the app) before cascading delete — no undo, so a confirm step is the safety net for a 2-person app.
- **Linked library file goes missing** (moved/deleted from disk): item silently falls back to plain-title behavior — no broken link, no crash, just loses the "tap to play" affordance until re-linked.
- **No viewer selected** when a review action is attempted: redirect to `/whos-watching`, don't fail silently or guess.
- **Settings names unset**: who's-watching falls back to generic labels rather than breaking.
- **Score bounds**: server validates 1–10 integer or null; reject out-of-range rather than silently clamping.

## Testing

- Server: unit tests for the new marathon/item/review endpoints — CRUD, cascade deletes, status transitions, review upsert semantics (same person editing twice updates, doesn't duplicate), score validation bounds. Follows the existing test setup already in `server/`.
- Client: no new e2e infra for this project; verify manually against the local dev build (per this project's existing pattern — Niranjan reviews live UI, Claude does not have reliable browser access on this project). No box/prod deploy until explicitly requested — build and test locally only.
