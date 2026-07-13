## v1.1.0 - 2026-07-13

- Bundle and self-manage cloudflared ([#3](https://github.com/FGButterLettuce/pookieflix/pull/3))

## v1.0.1 - 2026-07-13

First versioned release.

- Manual subtitle auto-sync via alass ([#1](https://github.com/FGButterLettuce/pookieflix/pull/1)) - realigns the currently-applied subtitle to the video's real audio track, with single-level undo
- Fixed upload from HTTPS pages to a plain-HTTP LAN server (mixed-content browser block) ([#2](https://github.com/FGButterLettuce/pookieflix/pull/2))
- Fixed Chrome playback failures caused by Chrome's experimental native HLS support - now restricted to real Safari, direct MP4 for everyone else ([#2](https://github.com/FGButterLettuce/pookieflix/pull/2))
- Added automated semver release workflow (this release) - version bump, changelog, GitHub Release, and versioned Docker tags (`latest`, `vX.Y.Z`, `X.Y`) on every merge to main going forward

