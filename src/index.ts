/**
 * OpenClaw plugin entry: Apple iCloud Calendar over CalDAV.
 *
 * Tools: icloud_calendar_list, icloud_calendar_events, icloud_calendar_get,
 * icloud_calendar_create, icloud_calendar_update, icloud_calendar_delete
 * (write tools are not registered when config.readOnly is true).
 */

import { definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import type { Static } from "@sinclair/typebox";
import { CalDavClient } from "./caldav/client.js";
import { Session } from "./caldav/discovery.js";
import { resolveConfig, type RawPluginConfig, type ResolvedConfig } from "./config.js";
import { CalDavError } from "./errors.js";
import { datamarkingPreamble, markCalendar, markEvent } from "./sanitize.js";
import { handleCreate, handleDelete, handleEvents, handleGet, handleList, handleUpdate, type Context } from "./tools/handlers.js";
import { createSchema, deleteSchema, eventsSchema, getSchema, listSchema, updateSchema } from "./tools/schemas.js";

type EventsParams = Static<typeof eventsSchema>;
type GetParams = Static<typeof getSchema>;
type CreateParams = Static<typeof createSchema>;
type UpdateParams = Static<typeof updateSchema>;
type DeleteParams = Static<typeof deleteSchema>;

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown> | null;
}

function ok(payload: unknown, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details };
}

function fail(e: unknown, action: string): ToolResult {
  const code = e instanceof CalDavError ? e.code : "server_error";
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: JSON.stringify({ success: false, error: { code, message } }, null, 2) }], details: { action, errorCode: code } };
}

const pluginEntry: OpenClawPluginDefinition = definePluginEntry({
  id: "openclaw-icloud-calendar",
  name: "iCloud Calendar",
  description: "Read and write Apple iCloud Calendar over CalDAV using an Apple ID and app-specific password",

  register(api) {
    const raw = api.pluginConfig as RawPluginConfig | undefined;
    const log = api.logger;

    // Resolve config lazily on first use so a misconfigured plugin still
    // loads and reports a clear error from the tool instead of failing the
    // whole gateway. Once resolved, the client/session are cached; secrets
    // are held only in this closure.
    let ctx: Context | null = null;
    let configError: string | null = null;
    let readOnlyFromConfig = raw?.readOnly === true;

    async function getContext(): Promise<Context> {
      if (ctx) return ctx;
      if (configError) throw new CalDavError("not_configured", configError);
      let config: ResolvedConfig;
      try {
        config = resolveConfig(raw);
      } catch (e) {
        configError = e instanceof Error ? e.message : String(e);
        log?.warn?.(`icloud-calendar: not configured: ${configError}`);
        throw e;
      }
      readOnlyFromConfig = config.readOnly;
      const client = new CalDavClient({ serverUrl: config.serverUrl, username: config.appleId, password: config.appPassword });
      ctx = { session: new Session(client), config };
      log?.info?.(`icloud-calendar: connected as ${config.appleId} (${config.timezone}${config.readOnly ? ", read-only" : ""})`);
      return ctx;
    }

    api.registerTool({
      name: "icloud_calendar_list",
      label: "iCloud Calendar List",
      description: "List the iCloud calendars available to this account (id, name, color, readOnly). Use the id or name with the other icloud_calendar_* tools.",
      parameters: listSchema,
      async execute() {
        try {
          const c = await getContext();
          const res = await handleList(c);
          return ok({ preamble: datamarkingPreamble(), calendars: res.calendars.map(markCalendar) }, { action: "list", count: res.calendars.length });
        } catch (e) {
          return fail(e, "list");
        }
      },
    });

    api.registerTool({
      name: "icloud_calendar_events",
      label: "iCloud Calendar Events",
      description:
        "List iCloud calendar events in a date range (default: next 7 days), across all calendars or one calendar. Returns events sorted by start with uid, title, start/end (ISO 8601 in the configured timezone), allDay, location, notes, recurrence and upcoming occurrences.",
      parameters: eventsSchema,
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const c = await getContext();
          const res = await handleEvents(c, params as EventsParams);
          return ok({ preamble: datamarkingPreamble(), ...res, events: res.events.map(markEvent) }, { action: "events", count: res.count, truncated: res.truncated });
        } catch (e) {
          return fail(e, "events");
        }
      },
    });

    api.registerTool({
      name: "icloud_calendar_get",
      label: "iCloud Calendar Get",
      description: "Get a single iCloud calendar event by uid.",
      parameters: getSchema,
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const c = await getContext();
          const ev = await handleGet(c, params as GetParams);
          return ok({ preamble: datamarkingPreamble(), event: markEvent(ev) }, { action: "get", uid: ev.uid });
        } catch (e) {
          return fail(e, "get");
        }
      },
    });

    if (readOnlyFromConfig) log?.info?.("icloud-calendar: readOnly=true, write tools not registered");
    else {
      api.registerTool({
        name: "icloud_calendar_create",
        label: "iCloud Calendar Create",
        description:
          "Create an event in an iCloud calendar. Requires title, start, and calendar (id or name). Provide end or duration (minutes); defaults to 1 hour (timed) or one day (all-day). Optional location, notes, url, alarms (minutes before), recurrence. Returns the stored event and a verification block comparing requested vs stored times.",
        parameters: createSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const c = await getContext();
            const res = await handleCreate(c, params as CreateParams);
            return ok({ success: true, event: markEvent(res.event), verification: res.verification }, { action: "create", uid: res.event.uid });
          } catch (e) {
            return fail(e, "create");
          }
        },
      });

      api.registerTool({
        name: "icloud_calendar_update",
        label: "iCloud Calendar Update",
        description:
          "Update fields of an existing iCloud calendar event by uid. Only supplied fields change. Empty string clears location/notes/url; empty alarms array removes alarms; clearRecurrence=true makes a recurring event one-off. Recurring events are updated as a whole series.",
        parameters: updateSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const c = await getContext();
            const res = await handleUpdate(c, params as UpdateParams);
            return ok({ success: true, event: markEvent(res.event), ...(res.verification ? { verification: res.verification } : {}) }, { action: "update", uid: res.event.uid });
          } catch (e) {
            return fail(e, "update");
          }
        },
      });

      api.registerTool({
        name: "icloud_calendar_delete",
        label: "iCloud Calendar Delete",
        description: "Delete an iCloud calendar event by uid. For recurring events this deletes the entire series. Confirm with the user before calling.",
        parameters: deleteSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const c = await getContext();
            const res = await handleDelete(c, params as DeleteParams);
            return ok({ success: true, ...res }, { action: "delete", uid: res.uid });
          } catch (e) {
            return fail(e, "delete");
          }
        },
      });
    }
  },
});

export default pluginEntry;
