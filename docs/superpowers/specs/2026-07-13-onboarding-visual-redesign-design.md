---
title: Onboarding wizard visual redesign
status: approved
date: 2026-07-13
---

# Onboarding wizard visual redesign

## Context

PookieFlix's first-run setup wizard (`client/src/pages/Setup.tsx`) and Settings page
(`client/src/pages/Settings.tsx`) work, but were explicitly flagged as unfinished after the
2026-07-13 onboarding hardening session: dark-theme-only with poor contrast, walls of
instructional text, only one visual aid (the Cloudflare OS-picker mockup), and no help for
users who hit the Cloudflare Tunnel path without owning a domain. This redesign is the
deferred follow-up, scoped for real end users — someone setting this up for a partner, not a
sysadmin — rather than a patch to the existing wizard.

Brainstormed with the visual companion; mockups referenced below live in
`.superpowers/brainstorm/17688-1783944358/content/` for this session
(`step-layout-v2.html`, `dark-theme-v3.html`, `domain-helper.html`).

## Design system

The redesign does not invent a new visual language. `pookieflix.com`'s marketing site (sibling
repo `~/Projects/Personal/pookieflix/`) already has a fully realized, battle-tested design
system built for exactly this audience — the "Pookie" mode (light, warm, non-technical) vs.
"Techie"/"You" mode (dark, technical). The wizard adopts those tokens directly instead of
inventing its own:

**Light theme** (from `[data-mode="pookie"]` in the site's `index.css`):
```
--bg: #eae6ef        --text: #34203f         --accent: #e0457f
--bg2: #f5f1f8        --text-muted: #6b566f   --accent-hover: #c73569
--surface: #ffffff    --text-subtle: #9a7bb5  --border: rgba(52,32,63,0.1)
```

**Dark theme** (from `[data-mode="you"]`, with the typography fixes below):
```
--bg: #130b1c         --text: #fff5ef             --accent: #ff7fab
--bg2: #1a1028        --text-muted: rgba(255,245,239,0.68)   (was #9a7bb5 — too low contrast)
--surface: #1f1029    --border: rgba(255,245,239,0.08)
```

**Typography:** Figtree 900 for headings (already loaded in `index.css`), Plus Jakarta Sans
for body (already loaded). Both themes share the same type scale:
- Step title: 22px, `letter-spacing: 0.01em` (open, not the tight `-0.02em` the marketing
  site uses for hero headlines — this reads as a calm dialog heading, not a pitch), margin-bottom 16px
- Body/description: 15px, line-height 1.6 (this was tuned live — an earlier attempt at 1.8
  line-height was an overcorrection and reverted)
- Instructions/hints: 15px, line-height 1.8 (denser numbered lists benefit from more air; this
  is distinct from body-paragraph line-height)

**Buttons:** pill-shaped (`border-radius: 999px`), primary CTA uses `--accent` with the site's
glow-shadow recipe (`box-shadow: 0 4px 16px rgba(accent-rgb, 0.3)`), secondary/back actions use
a flat `rgba(text, 0.06)` background.

**Copy voice:** lowercase, warm, second-person ("where will you two be watching from?"),
matching the Pookie-mode voice — but dialed back from the marketing site's exclamation-heavy
register, since this is a functional wizard the user needs to complete, not a pitch to read.

**Illustration approach:** no icon-illustration library, no cartoon mascots. The established
house style (both the marketing site's `FeatureVisuals.tsx` and the wizard's existing
`.cf-mockup`) is small faux-UI recreations — a simplified copy of the *actual* third-party
screen the user is about to see, with a highlighted element and a pointer. This redesign
extends that pattern rather than replacing it with a different illustration style:
- Existing: Cloudflare's OS-picker (Docker highlighted)
- New: Cloudflare's "Add route" tab (Published application highlighted) — the step already
  has this instruction in text; it becomes an annotated mockup like the OS-picker one
- New: a simplified Spaceship domain-search box mockup on the domain-suggestion screen, so
  the CTA buttons feel like "one click gets you to that screen," not a mystery link

## Theme system (technical)

- `data-theme="light" | "dark"` attribute on `<html>`, mirroring the mechanism
  `pookieflix-site`'s `App.tsx` already uses for `data-mode` (`document.documentElement.setAttribute`).
- Default: `window.matchMedia('(prefers-color-scheme: dark)')`, checked once on load.
- Override: a `ThemeToggle` component (adapted from the site's `ModeToggle.tsx` — same
  `toggle-pill` two-button pattern, swapped to ☀️/🌙) persists the explicit choice to
  `localStorage`. If the user has never toggled, it keeps following the system preference live
  (listens for `matchMedia` change events); once they toggle manually, that choice is fixed
  until they toggle again.
- Mounted once in `App.tsx` (not per-page), so it's present on Setup, Settings, Home, and Room
  — this is why theming is app-wide rather than onboarding-only (confirmed with Niranjan:
  the CSS variables are global in `index.css`, so a wizard-only toggle would hand off into a
  library view that ignores the choice).
- `index.css` restructures `:root` into `:root, [data-theme="light"]` (light is the default
  token set) and `[data-theme="dark"]` (override block), replacing the current single
  hardcoded dark `:root`.

## Wizard step flow (Setup.tsx)

Restructured, not just restyled — the domain-helper insertion and prerequisite-first framing
require reordering, not just new CSS:

1. **Welcome** — same role as today, restyled.
2. **Where will you watch from?** — comparison-column layout (validated in
   `step-layout-v2.html`, option B): three cards side by side, each with an icon, one-line
   description, and a prerequisite pill row shown *before* the user picks (requirement 4) —
   e.g. the Tunnel card visibly says "needs a domain" / "needs a free Cloudflare account"
   right on the card, not three steps later.
3. **Home path** → straight to step 5 (password), unchanged logic.
4. **DDNS path** → existing instructions, restyled only (bigger/better-spaced text, no
   structural change — DDNS has no domain dependency to solve for).
5. **Tunnel path** (new sub-flow inserted before the existing Cloudflare instructions):
   - 5a. "Got a domain already?" fork — two buttons, yes/no.
   - 5b. *(if no)* Collect two names (their name, partner's name) — plain text inputs, no
     visual complexity needed here.
   - 5c. *(if no)* Personalized suggestion screen (validated in `domain-helper.html`):
     ~6-8 generated domain ideas as cards. Spaceship does not publicly document a prefill query
     parameter for its domain-search page (checked directly — their search page 403s automated
     fetches, and no API docs mention one), so rather than fabricate a deep link that might not
     work, each card gets a "copy name" button (reusing the app's existing `.copy-btn` pattern)
     next to a "search on Spaceship" CTA button that opens `spaceship.com/domain-search/` in a
     new tab — still a real clickable CTA per requirement 3, just honest about what's actually
     prefillable. Upfront framing states real cheap pricing (~$3-12/year) to make the ask feel
     low-friction (requirement 5).
   - 5d. Existing Cloudflare tunnel instructions (steps that are today's `tunnelSubStep`
     0/1/2), restyled with the typography/color fixes and the new "Add route" mockup.
6. **Password + subtitles** — same logic as today, restyled.
7. **Done** — restyled.

### Domain name suggestion algorithm

Client-side only (per the "suggestions + outbound links" decision — no registrar API, no
server route, no API key for self-hosters to configure). Given `userName` and `partnerName`,
generate a fixed set of patterns:
- Direct blend: `{user}{partner}.com` / `.app`
- Couple-word + name: `our.movienight.app`, `watch.with{partner}.com` (a small fixed list of
  couple-flavored words: `movienight`, `together`, `ourfilm`)
- Playful TLD variant: `{user}{partner}watch.xyz`

This produces the same ~6-8 ideas deterministically from the two names — no randomness, no
"is this actually available" claim (the CTA button is where availability gets checked, by
Spaceship itself).

## Server-side changes

- `persistedConfig.ts`: add `USER_NAME?: string` and `PARTNER_NAME?: string` fields.
- `routes.ts`: thread both through `/api/setup` (POST) and `/api/settings` (GET/POST), same
  pattern as the existing `APP_BASE_URL`/`OPENSUBTITLES_API_KEY` fields (no masking needed,
  these aren't secrets).
- No new routes — this is additive to the existing config read/write paths.

## Settings.tsx

Gets the same design-system pass (theme tokens, typography scale, pill buttons,
`ThemeToggle` visible on the page) but keeps its current single-page form structure — it
doesn't need the wizard's step-by-step treatment. Two new fields added for "Your name" /
"Partner's name" (editable later, consistent with how every other persisted field on this
page already works), placed near the top since they're app-wide info now, not
Tunnel-specific.

## Testing plan

Per the standing practice from the previous onboarding session: every change gets verified
against a real Docker build on `twogether-box` (LAN, `192.168.0.91`, SSH alias
`twogether-box`), not just checked in isolation locally. Specifically:
- Both themes (light/dark) checked for real contrast on an actual device, not just in
  browser devtools color-picker numbers.
- The full Tunnel → no-domain → suggestions → Spaceship CTA → back to Cloudflare steps path
  walked through end-to-end against a locally built test image, the same way the previous
  session's Cloudflare Tunnel bundling was verified.
- Release held back until Niranjan has seen and approved the new onboarding in the running
  app — no release-pipeline run for this until that happens (per this session's standing
  instruction).

## Out of scope

- No live domain availability checking (explicitly deferred — see brainstorm decision).
- No redesign of Home.tsx's library grid or Room.tsx's player chrome beyond inheriting the
  new theme tokens — their own layouts are unchanged, only colors/typography shift with the
  toggle.
- No changes to the DDNS or Home-only step *logic* — only Tunnel gets the new domain-helper
  sub-flow, since it's the only path with a hard domain dependency.
