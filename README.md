# openclaw-icloud-calendar

OpenClaw plugin that reads and writes **Apple iCloud Calendar** directly over CalDAV, using an
Apple ID and an app-specific password. Server-to-server: it runs wherever your OpenClaw gateway
runs (Linux, a Raspberry Pi, a VPS). No macOS, no EventKit, no phone in the loop.

Zero runtime dependencies for the CalDAV path: `fetch` plus a small XML/iCalendar layer written
for exactly the responses iCloud sends.

## Tools

| Tool | What it does |
|------|--------------|
| `icloud_calendar_list` | Calendars available to the account (id, name, color, readOnly) |
| `icloud_calendar_events` | Events in a range (default next 7 days), one calendar or all, sorted |
| `icloud_calendar_get` | One event by UID |
| `icloud_calendar_create` | New event (title, start, calendar; end/duration, location, notes, url, alarms, recurrence) |
| `icloud_calendar_update` | Change fields on an event by UID (etag-protected) |
| `icloud_calendar_delete` | Delete an event by UID (whole series for recurring events) |

Set `readOnly: true` and the three write tools are not registered at all.

## Install

```bash
openclaw plugins install openclaw-icloud-calendar
```

## Setup

1. Turn on two-factor authentication for your Apple Account if it is not already on.
2. Create an app-specific password at <https://account.apple.com> → Sign-In and Security →
   App-Specific Passwords. Name it "OpenClaw". Copy the `xxxx-xxxx-xxxx-xxxx` value.
3. Put the password somewhere the gateway can read it. Environment variable is simplest:

   ```bash
   export ICLOUD_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   ```

4. Configure the plugin in `openclaw.json`:

   ```jsonc
   {
     "plugins": {
       "entries": {
         "openclaw-icloud-calendar": {
           "enabled": true,
           "config": {
             "appleId": "you@icloud.com",
             "appPassword": "${ICLOUD_APP_PASSWORD}",
             "timezone": "America/Los_Angeles"
           }
         }
       }
     }
   }
   ```

   `appPassword` also accepts a SecretRef (`{"source":"env","provider":"env","id":"ICLOUD_APP_PASSWORD"}`
   or `{"source":"file","provider":"secrets","id":"/icloud/appPassword"}` pointing into
   `~/.openclaw/secrets.json`). Plain strings work but are discouraged.

   Without any config, the plugin falls back to `ICLOUD_APPLE_ID` and `ICLOUD_APP_PASSWORD`
   environment variables.

## Configuration

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `appleId` | string | | Apple Account email. Required. |
| `appPassword` | string / `${ENV}` / SecretRef | | App-specific password. Required. Never your Apple Account password. |
| `timezone` | IANA string | host time zone | Used to interpret naive times the agent sends and to format results. |
| `serverUrl` | string | `https://caldav.icloud.com` | Must be `https`. Any CalDAV server that speaks the same dialect should work, but iCloud is what is tested. |
| `calendars` | string[] | all | Allowlist of calendar ids or names the agent may see and modify. |
| `readOnly` | boolean | `false` | Do not register create/update/delete. |

## Behavior worth knowing

- **Times.** Results are ISO 8601 with an offset in `timezone`; all-day events use `YYYY-MM-DD`
  with an inclusive `end`. Inputs may be naive local (`2026-08-20T09:00`), `Z`, or offset times.
  Timed events are written to iCloud in UTC; all-day events as `VALUE=DATE`.
- **Recurring events.** Queries return the series master with `recurrence` and a best-effort
  `nextOccurrences` list within the queried range (daily/weekly/monthly/yearly with the common
  BYDAY/BYMONTHDAY forms). Exotic rules are passed through in `recurrence.raw`. Updates and deletes
  apply to the whole series. Per-instance overrides made elsewhere are preserved on update and
  reported as `overrideCount`.
- **Concurrency.** Updates and deletes send `If-Match` with the etag from the last read. On a 412 the
  plugin re-reads once and retries; a second conflict returns `conflict`.
- **Verification.** `create` and time-changing `update` return a `verification` block comparing what
  was requested with what iCloud stored, so date parsing drift is visible to the agent.
- **Discovery.** Principal and calendar-home discovery follow iCloud's redirects to the per-account
  `pNN-caldav.icloud.com` host and are cached; a 404 on a cached URL triggers rediscovery.
- **UID lookup.** iCloud answers `calendar-query` UID prop-filters with a bare 412, so lookups try
  `GET <calendar>/<uid>.ics` first (how Apple clients and this plugin name objects) and fall back to
  scanning the calendar. Pass `calendar` to update/get/delete when you know it; it avoids the scan.
- **Untrusted content.** Titles, notes, locations and URLs are wrapped in per-session
  `[UNTRUSTED_CALENDAR_DATA_…]` markers and instruction-like text is flagged, so the agent does not
  treat invitation text as commands.
- **Errors.** Tool results carry `error.code`: `auth_failed`, `not_found`, `conflict`,
  `read_only_calendar`, `invalid_input`, `not_configured`, `server_error`.

## Troubleshooting

- `auth_failed` with credentials you are sure about: you are using the Apple Account password. Only
  app-specific passwords work over CalDAV. Also note Apple revokes every app-specific password when
  you change your Apple Account password.
- Nothing listed / calendar missing: shared calendars you only have read access to and the Birthdays
  calendar show as `readOnly`; reminder lists (VTODO) are hidden on purpose.
- Times off by hours: set `timezone` explicitly. The default is the gateway host's zone.

## Development

```bash
npm install
npm test                # unit + fake-server tests, no network
npm run typecheck
npm run build
npm run plugin:check    # @openclaw/plugin-inspector
```

Live test against a real account (creates and deletes one `[openclaw-test]` event):

```bash
ICLOUD_INTEGRATION=1 ICLOUD_TEST_APPLE_ID=you@icloud.com ICLOUD_TEST_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
ICLOUD_TEST_CALENDAR=Home npm run test:integration
```

Design notes live in `docs/superpowers/specs/`.

## Not in v1

Reminders (VTODO), Contacts (CardDAV), attendees/invitations, free-busy, per-instance edits of
recurring events, multiple accounts.

## License

MIT
