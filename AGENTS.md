# openclaw-icloud-calendar

OpenClaw plugin: Apple iCloud Calendar over CalDAV (Apple ID + app-specific password), server-to-server, zero runtime deps for the CalDAV path. Published to ClawHub and npm as `openclaw-icloud-calendar`.

## Project Structure

- `src/index.ts` — plugin entry (`definePluginEntry`), registers `icloud_calendar_*` tools; write tools skipped when `readOnly`
- `src/config.ts` — config + SecretRef resolution (`env` / `file` provider into `~/.openclaw/secrets.json`)
- `src/caldav/` — `xml.ts` (parser + DAV bodies), `client.ts` (fetch, manual redirects, retry, error mapping), `discovery.ts` (principal → home → calendars, cached `Session`), `query.ts` (time-range REPORT, UID lookup)
- `src/ical/` — `component.ts` (RFC 5545 parse/serialize), `tz.ts` (Intl-only tz), `rrule.ts` (parse/build/expand), `event.ts` (Event JSON ⇄ VEVENT)
- `src/tools/` — `schemas.ts` (typebox; optional params are nullable), `handlers.ts`
- `src/sanitize.ts` — datamarking of server-sourced free text
- `skills/icloud-calendar/SKILL.md`, `openclaw.plugin.json`, `marketplace.json`
- `test/` — vitest: unit, fake in-memory iCloud (`test/helpers/fake-icloud.ts`), opt-in live test (`test/integration`)
- `docs/superpowers/specs/` — design spec

## iCloud quirks (do not "fix" these away)

- `calendar-query` with a UID `prop-filter` returns a bare 412 → UID lookup is `GET <calendar>/<uid>.ics` then unfiltered scan.
- Discovery hops to `pNN-caldav.icloud.com`; auth must survive the cross-host redirect (client follows redirects manually).
- Models send `null` for unused optional params; schemas accept null and handlers normalise.

## Commands

```bash
npm test                 # unit + fake server
npm run typecheck && npm run build
npm run plugin:check     # plugin-inspector
ICLOUD_INTEGRATION=1 ICLOUD_TEST_APPLE_ID=... ICLOUD_TEST_APP_PASSWORD=... ICLOUD_TEST_CALENDAR=Personal npm run test:integration
scripts/check-versions.sh
```

## Pre-publish validation (do all of these; each caught a real break once)

```bash
npm test && npm run typecheck && npm run build
npm run plugin:ci                       # inspector incl. runtime capture; must show Captured 2 / Failed 0
npm pack && openclaw plugins install --force npm-pack:./openclaw-icloud-calendar-<v>.tgz
openclaw plugins inspect openclaw-icloud-calendar --runtime   # must list 6 tools, no "invalid config"
openclaw plugins uninstall --force openclaw-icloud-calendar
```

Rules learned: no TS-only runtime syntax (parameter properties, enums) — the runtime loader strips types only; never put `required` in `configSchema` (the installer writes an empty entry and the CLI refuses to start); ship `runtimeExtensions: ["./dist/index.js"]` and keep `openclaw` a peerDependency.

## Publishing

Versions must agree in `package.json`, `marketplace.json`, `openclaw.plugin.json` (CI enforces).

Automated: bump versions, commit, push, then tag:

```bash
git tag -a v0.2.0 -m "what changed"
git push origin v0.2.0
```

`publish-clawhub.yml` publishes to ClawHub (needs `CLAWHUB_TOKEN` repo secret); `publish-npm.yml` publishes to npm via OIDC trusted publishing (configure the trusted publisher on npmjs.com for this repo/workflow after the first manual publish).

Manual fallback: `./publish-clawhub.sh --changelog "..."` (needs `clawhub login`), `npm publish --access public`.

Verify: `clawhub package inspect openclaw-icloud-calendar`, `openclaw plugins install openclaw-icloud-calendar`.
