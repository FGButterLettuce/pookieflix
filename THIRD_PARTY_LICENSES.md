# Third-Party Licenses

PookieFlix itself is MIT licensed (see [LICENSE](LICENSE)). The Docker image
also bundles the following third-party binary, built from source at image
build time and invoked as a separate command-line process (never linked into
the PookieFlix codebase):

## alass

- **Project:** [kaegi/alass](https://github.com/kaegi/alass) — Automatic Language-Agnostic Subtitle Synchronization
- **Version used:** `v2.0.0` (pinned tag, unmodified)
- **License:** GPL-3.0
- **Source:** https://github.com/kaegi/alass/tree/v2.0.0

The Docker image builds this exact, unmodified tagged release from source
(see the `alass-build` stage in the [Dockerfile](Dockerfile)) and ships the
resulting binary at `/usr/local/bin/alass`. This notice, plus the pinned tag
above, serves as the written offer for alass's corresponding source as
required by the GPL-3.0.
