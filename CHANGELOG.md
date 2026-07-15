## v1.5.4 - 2026-07-15

- Fix stuck HLS transcodes, serialize them, wider library cards ([#17](https://github.com/FGButterLettuce/pookieflix/pull/17))

## v1.5.3 - 2026-07-14

- Add in-app tunnel reconnect and manual transcode controls ([#15](https://github.com/FGButterLettuce/pookieflix/pull/15))

## v1.5.2 - 2026-07-13

- Fix sync buffer-safety bypass and live-stream-looking HLS output ([#12](https://github.com/FGButterLettuce/pookieflix/pull/12))

## v1.5.1 - 2026-07-13

- Hide theme toggle on Room page ([#11](https://github.com/FGButterLettuce/pookieflix/pull/11))

## v1.5.0 - 2026-07-13

- Redesign onboarding wizard: light/dark theme, visual steps, domain helper ([#10](https://github.com/FGButterLettuce/pookieflix/pull/10))

## v1.4.0 - 2026-07-13

- Add mandatory wizard password step and live tunnel status card ([#9](https://github.com/FGButterLettuce/pookieflix/pull/9))

## v1.3.0 - 2026-07-13

- Add advanced port setting to the tunnel setup step ([#7](https://github.com/FGButterLettuce/pookieflix/pull/7))

## v1.2.1 - 2026-07-13

- Fix mockup pointer alignment and stale Cloudflare route instructions ([#6](https://github.com/FGButterLettuce/pookieflix/pull/6))

## v1.2.0 - 2026-07-13

- Robustly extract the tunnel token from whatever users paste ([#5](https://github.com/FGButterLettuce/pookieflix/pull/5)) - handles the full install/run command from any OS/Docker tab, adds a visual guide for which tab to pick, and a "Remove tunnel" action in Settings
- Pre-fill the base URL field with its required http(s):// scheme ([#4](https://github.com/FGButterLettuce/pookieflix/pull/4))

## v1.1.0 - 2026-07-13

- Bundle and self-manage cloudflared ([#3](https://github.com/FGButterLettuce/pookieflix/pull/3))

## v1.0.1 - 2026-07-13

First versioned release.

- Manual subtitle auto-sync via alass ([#1](https://github.com/FGButterLettuce/pookieflix/pull/1)) - realigns the currently-applied subtitle to the video's real audio track, with single-level undo
- Fixed upload from HTTPS pages to a plain-HTTP LAN server (mixed-content browser block) ([#2](https://github.com/FGButterLettuce/pookieflix/pull/2))
- Fixed Chrome playback failures caused by Chrome's experimental native HLS support - now restricted to real Safari, direct MP4 for everyone else ([#2](https://github.com/FGButterLettuce/pookieflix/pull/2))
- Added automated semver release workflow (this release) - version bump, changelog, GitHub Release, and versioned Docker tags (`latest`, `vX.Y.Z`, `X.Y`) on every merge to main going forward

