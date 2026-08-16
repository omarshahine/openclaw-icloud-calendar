# openclaw-icloud-calendar: design

Date: 2026-08-16

## Goal

An OpenClaw plugin that reads and writes Apple iCloud Calendar server-to-server over CalDAV, authenticated with an Apple Account email and an app-specific password. Runs on any host with Node 22 (Linux gateway included); no macOS, no EventKit, no local device.

Public plugin, single account per install, calendar CRUD only in v1.

## Non-goals (v1)

- Reminders (VTODO), Contacts (CardDAV), free/busy, attendees/invitations
- Per-instance edits of recurring events (whole-series only)
- Multi-account per agent
- CLI or MCP surface (OpenClaw plugin only)

## Approach

Hand-rolled zero-runtime-dependency CalDAV client (`fetch` + a small namespace-aware XML parser scoped to DAV multistatus responses). `@sinclair/typebox` is used only for tool parameter schemas (same as openclaw-parcel); `openclaw` is the SDK peer.

## Components

```
src/
  index.ts              OpenClaw entry: definePluginEntry, resolve config/secret, register tools
  config.ts             config parsing, SecretRef resolution (env | file+jsonPointer), tz default
  errors.ts             CalDavError with typed codes
  caldav/
    xml.ts              minimal XML parser + DAV request body builders
    client.ts           fetch wrapper: Basic auth, PROPFIND/REPORT/GET/PUT/DELETE, manual redirects, status mapping
    discovery.ts        current-user-principal -> calendar-home-set -> calendar list; cached Session
    query.ts            calendar-query (time-range), UID lookup, multiget
  ical/
    component.ts        iCalendar tree parse/serialize (unfold, escape, fold), preserves unknown props
    tz.ts               ISO <-> iCal date conversion with Intl (no tz lib)
    event.ts            Component -> Event JSON; Event input -> Component; patch
    rrule.ts            RRULE parse/build + best-effort occurrence expansion
  tools/
    schemas.ts          typebox schemas for the tools
    handlers.ts         tool args -> caldav/ical -> JSON result
  sanitize.ts           datamarking of untrusted free text (port of apple-pim lib/sanitize.js)
skills/icloud-calendar/SKILL.md
```

Data flow (read): tool call -> handler -> Session (discovery, cached) -> REPORT -> ICS -> event.ts -> JSON -> sanitize -> result.
Data flow (write): JSON -> event.ts -> ICS -> PUT (`If-None-Match: *` on create, `If-Match: etag` on update) -> re-GET -> event + `verification`.

## Tools

| Tool | Params | Notes |
|---|---|---|
| `icloud_calendar_list` | none | `[{id, name, color, readOnly, ctag}]`; `id` = last path segment of the calendar href |
| `icloud_calendar_events` | `from`, `to` (default now..+7d), `calendar?`, `limit?` (200) | Merged across calendars, sorted by start. Recurring masters include `recurrence` and `nextOccurrences` (best-effort, cap 50) |
| `icloud_calendar_get` | `uid`, `calendar?` | Searches all calendars if not given |
| `icloud_calendar_create` | `title`, `start`, `end?`/`duration?`, `calendar` (required), `allDay?`, `location?`, `notes?`, `url?`, `alarms?`, `recurrence?` | New UID via `crypto.randomUUID()` |
| `icloud_calendar_update` | `uid`, `calendar?`, subset of create fields | Patch only supplied fields; 412 -> one refetch+retry |
| `icloud_calendar_delete` | `uid`, `calendar?` | `If-Match`; returns `{deleted:true, uid}` |

Event JSON: `{ uid, calendarId, calendar, title, start, end, allDay, timezone, location?, notes?, url?, status?, recurrence?, alarms?, etag, lastModified?, readOnly }`.

Times: ISO 8601 with offset in the configured `timezone`; all-day as `YYYY-MM-DD`. Naive inputs are interpreted in `timezone`. Written as UTC (`Z`) except all-day (`VALUE=DATE`).

## Config

| Key | Type | Notes |
|---|---|---|
| `appleId` | string, required | Apple Account email |
| `appPassword` | string / `${ENV}` / SecretRef, required | `uiHints.sensitive` |
| `timezone` | IANA string, default host tz | validated with Intl |
| `serverUrl` | string, default `https://caldav.icloud.com` | must be https unless localhost |
| `calendars` | string[] | allowlist by id or name; empty = all |
| `readOnly` | boolean, default false | write tools are not registered |

Env fallbacks: `ICLOUD_APPLE_ID`, `ICLOUD_APP_PASSWORD`.

## Security

- Basic auth over TLS only.
- Secret resolved once in `register()`, held in closure; never in results, logs, or errors.
- Destructive tools require exact `uid`; no bulk ops.
- All server-sourced free text is datamarked; suspicious instruction-like text is flagged.
- `contracts.tools` lists every tool.

## Errors

`auth_failed`, `not_found`, `conflict`, `read_only_calendar`, `invalid_input`, `server_error`. Discovery cache invalidated on 404/3xx from a cached href. One retry on 5xx/network error.

## Testing

- vitest unit tests: iCal round-trips (all-day, UTC, TZID, floating, RRULE, EXDATE, VALARM, folding, escaping), XML parser on captured multistatus fixtures, tz DST boundaries, client with injected fetch mock (headers, Depth, If-Match, 401/412/404/redirect).
- Integration (opt-in via `ICLOUD_INTEGRATION=1`, `ICLOUD_TEST_APPLE_ID`, `ICLOUD_TEST_APP_PASSWORD`, `ICLOUD_TEST_CALENDAR`): create/get/update/delete a `[openclaw-test]` event.
- `plugin-inspector` + `/openclaw-plugin-audit` before ClawHub publish.
