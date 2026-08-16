/**
 * Tool handlers: params -> CalDAV -> JSON results.
 */

import { randomUUID } from "node:crypto";
import type { ResolvedConfig } from "../config.js";
import type { CalendarInfo, Session } from "../caldav/discovery.js";
import { getObject, queryByUid, queryEventsInRange, type CalendarObject } from "../caldav/query.js";
import { CalDavError, invalidInput, notFound } from "../errors.js";
import { buildNewEvent, componentToEvent, parseEventDocument, patchEvent, resolveTimes, type Event, type EventInput } from "../ical/event.js";
import type { Recurrence } from "../ical/rrule.js";
import { formatDateOnly, formatIsoInZone, parseInput, zonedToUtc } from "../ical/tz.js";

/** Drop null-valued keys (models often send null for unused optional fields). */
function stripNulls<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as T;
}

type Nullable<T> = { [K in keyof T]: T[K] | null };

/** Wire shape of writable event fields: every optional field may be null. */
export type WireEventInput = Partial<Nullable<Omit<EventInput, "recurrence">>> & { recurrence?: Partial<Nullable<Recurrence>> | null };

/**
 * Normalise wire input into EventInput. For clearable fields (location, notes,
 * url, alarms, recurrence) null survives as "clear" when `keepClears` is set
 * (update); otherwise null means "not provided".
 */
function normaliseInput(raw: WireEventInput, keepClears: boolean): EventInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (v === null) {
      if (keepClears && ["location", "notes", "url", "alarms", "recurrence"].includes(k)) out[k] = null;
      continue;
    }
    out[k] = k === "recurrence" ? stripNulls(v as object) : v;
  }
  return out as EventInput;
}

export interface Context {
  session: Session;
  config: ResolvedConfig;
}

export interface CalendarSummary {
  id: string;
  name: string;
  color?: string;
  readOnly: boolean;
  ctag?: string;
}

function summarize(c: CalendarInfo): CalendarSummary {
  return { id: c.id, name: c.name, color: c.color, readOnly: c.readOnly, ctag: c.ctag };
}

async function allowedCalendars(ctx: Context, force = false): Promise<CalendarInfo[]> {
  const all = await ctx.session.getCalendars(force);
  const allow = ctx.config.calendars;
  if (allow.length === 0) return all;
  const needles = allow.map((a) => a.toLowerCase());
  return all.filter((c) => needles.includes(c.id.toLowerCase()) || needles.includes(c.name.toLowerCase()));
}

async function resolveAllowedCalendar(ctx: Context, idOrName: string): Promise<CalendarInfo> {
  const cal = await ctx.session.resolveCalendar(idOrName);
  const allowed = await allowedCalendars(ctx);
  if (!allowed.some((c) => c.href === cal.href)) {
    throw notFound(`Calendar "${idOrName}" is not in the configured allowlist. Available: ${allowed.map((c) => `${c.name} (${c.id})`).join(", ") || "none"}`);
  }
  return cal;
}

/** Run an operation; on not_found from a possibly-stale discovery cache, refresh once and retry. */
async function withRefresh<T>(ctx: Context, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (e instanceof CalDavError && e.code === "not_found" && e.status === 404) {
      ctx.session.invalidate();
      await ctx.session.getCalendars(true);
      return await op();
    }
    throw e;
  }
}

function toEvent(ctx: Context, obj: CalendarObject, range?: { start: Date; end: Date }): Event {
  const parsed = parseEventDocument(obj.ics);
  return componentToEvent(parsed, {
    tz: ctx.config.timezone,
    calendarId: obj.calendar.id,
    calendarName: obj.calendar.name,
    readOnly: obj.calendar.readOnly || ctx.config.readOnly,
    etag: obj.etag,
    range,
  });
}

// ---------------------------------------------------------------------------

export async function handleList(ctx: Context): Promise<{ calendars: CalendarSummary[] }> {
  const cals = await allowedCalendars(ctx);
  return { calendars: cals.map(summarize) };
}

export interface EventsParams {
  from?: string | null;
  to?: string | null;
  calendar?: string | null;
  limit?: number | null;
}

export async function handleEvents(ctx: Context, rawParams: EventsParams) {
  const params = stripNulls(rawParams);
  const tz = ctx.config.timezone;
  const start = params.from ? toInstant(parseInput(params.from, tz, "from"), tz, false) : new Date();
  const end = params.to ? toInstant(parseInput(params.to, tz, "to"), tz, true) : new Date(start.getTime() + 7 * 86_400_000);
  if (end.getTime() <= start.getTime()) throw invalidInput("to must be after from");
  if (end.getTime() - start.getTime() > 400 * 86_400_000) throw invalidInput("range too large (max 400 days)");
  const limit = params.limit ?? 200;

  const warnings: string[] = [];
  const events: Event[] = [];
  const results = await withRefresh(ctx, async () => {
    const cals = params.calendar ? [await resolveAllowedCalendar(ctx, params.calendar)] : await allowedCalendars(ctx);
    return Promise.all(cals.map(async (cal) => ({ cal, objects: await queryEventsInRange(ctx.session.client, cal, start, end) })));
  });
  const cals = results.map((r) => r.cal);
  for (const { cal, objects } of results) {
    for (const obj of objects) {
      try {
        const ev = toEvent(ctx, obj, { start, end });
        // Server time-range matching is authoritative; keep everything it returned.
        events.push(ev);
      } catch (e) {
        warnings.push(`Skipped unparseable object in ${cal.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  events.sort((a, b) => sortKey(a, tz) - sortKey(b, tz) || a.title.localeCompare(b.title));
  const truncated = events.length > limit;
  return {
    from: formatIsoInZone(start, tz),
    to: formatIsoInZone(end, tz),
    timezone: tz,
    calendars: cals.map((c) => c.name),
    count: Math.min(events.length, limit),
    truncated,
    events: events.slice(0, limit),
    ...(warnings.length ? { warnings } : {}),
  };
}

function sortKey(ev: Event, tz: string): number {
  // Recurring masters sort by their first occurrence in the queried range, not the series start.
  const p = parseInput(ev.nextOccurrences?.[0] ?? ev.start, tz);
  return p.kind === "date" ? zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0, second: 0 }, tz).getTime() : p.date.getTime();
}

function toInstant(p: ReturnType<typeof parseInput>, tz: string, endOfDay: boolean): Date {
  if (p.kind === "datetime") return p.date;
  const d = endOfDay ? { year: p.year, month: p.month, day: p.day + 1 } : p;
  return zonedToUtc({ year: d.year, month: d.month, day: d.day, hour: 0, minute: 0, second: 0 }, tz);
}

// ---------------------------------------------------------------------------

async function locate(ctx: Context, uid: string, calendar?: string): Promise<CalendarObject> {
  if (!uid || !uid.trim()) throw invalidInput("uid is required");
  const u = uid.trim();
  return withRefresh(ctx, async () => {
    if (calendar) {
      const cal = await resolveAllowedCalendar(ctx, calendar);
      const obj = await queryByUid(ctx.session.client, cal, u);
      if (!obj) throw notFound(`No event with uid "${u}" in calendar "${cal.name}"`);
      return obj;
    }
    const cals = await allowedCalendars(ctx);
    const found = await Promise.all(cals.map((cal) => queryByUid(ctx.session.client, cal, u)));
    const obj = found.find((o): o is CalendarObject => !!o);
    if (!obj) throw notFound(`No event with uid "${u}" in any accessible calendar`);
    return obj;
  });
}

export async function handleGet(ctx: Context, params: { uid: string; calendar?: string | null }): Promise<Event> {
  const obj = await locate(ctx, params.uid, params.calendar ?? undefined);
  return toEvent(ctx, obj);
}

// ---------------------------------------------------------------------------

export interface CreateParams extends WireEventInput {
  title: string;
  start: string;
  calendar: string;
}

function assertWritable(ctx: Context, cal: CalendarInfo): void {
  if (ctx.config.readOnly) throw new CalDavError("read_only_calendar", "This plugin is configured readOnly");
  if (cal.readOnly) throw new CalDavError("read_only_calendar", `Calendar "${cal.name}" is read-only (subscribed, shared read-only, or Birthdays)`);
}

interface Verification {
  requestedStart: string;
  storedStart: string;
  startMatch: boolean;
  requestedEnd?: string;
  storedEnd: string;
  endMatch: boolean;
  allFieldsMatch: boolean;
}

function verify(ctx: Context, input: EventInput, existing: Event | undefined, stored: Event): Verification {
  const tz = ctx.config.timezone;
  const t = resolveTimes(input, tz, existing);
  const requestedStart = t.allDay && t.startDate ? formatDateOnly(t.startDate.year, t.startDate.month, t.startDate.day) : formatIsoInZone(t.start!, tz);
  const requestedEnd = t.allDay && t.endDate ? formatDateOnly(...inclusive(t.endDate)) : formatIsoInZone(t.end!, tz);
  const startMatch = requestedStart === stored.start;
  const endMatch = requestedEnd === stored.end;
  return { requestedStart, storedStart: stored.start, startMatch, requestedEnd, storedEnd: stored.end, endMatch, allFieldsMatch: startMatch && endMatch };
}

function inclusive(exclusiveEnd: { year: number; month: number; day: number }): [number, number, number] {
  const d = new Date(Date.UTC(exclusiveEnd.year, exclusiveEnd.month - 1, exclusiveEnd.day - 1));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

export async function handleCreate(ctx: Context, rawParams: CreateParams): Promise<{ event: Event; verification: Verification }> {
  const { calendar, ...rest } = rawParams;
  const params = normaliseInput(rest, false);
  const cal = await resolveAllowedCalendar(ctx, calendar);
  assertWritable(ctx, cal);
  const uid = randomUUID().toUpperCase();
  const { ics } = buildNewEvent(params, ctx.config.timezone, uid);
  const href = `${cal.href}${uid}.ics`;
  await withRefresh(ctx, () => ctx.session.client.put(href, ics, { ifNoneMatch: "*" }));
  const stored = await getObject(ctx.session.client, cal, href);
  const event = toEvent(ctx, stored);
  return { event, verification: verify(ctx, params, undefined, event) };
}

export interface UpdateParams extends WireEventInput {
  uid: string;
  calendar?: string | null;
  clearRecurrence?: boolean | null;
}

export async function handleUpdate(ctx: Context, params: UpdateParams): Promise<{ event: Event; verification?: Verification }> {
  const { uid, calendar, clearRecurrence, ...rest } = params;
  const input: EventInput = normaliseInput(rest, true);
  if (clearRecurrence) input.recurrence = null;
  const timeFieldsTouched = input.start !== undefined || input.end !== undefined || input.duration !== undefined || input.allDay !== undefined;
  const hasChange = Object.values(input).some((v) => v !== undefined);
  if (!hasChange) throw invalidInput("Nothing to update: provide at least one field");
  // Normalise "clear" semantics: empty string -> null (remove).
  for (const k of ["location", "notes", "url"] as const) if (input[k] === "") input[k] = null;
  if (Array.isArray(input.alarms) && input.alarms.length === 0) input.alarms = null;

  const attempt = async (obj: CalendarObject): Promise<CalendarObject> => {
    assertWritable(ctx, obj.calendar);
    const parsed = parseEventDocument(obj.ics);
    const current = componentToEvent(parsed, { tz: ctx.config.timezone, calendarId: obj.calendar.id, calendarName: obj.calendar.name, readOnly: false, etag: obj.etag });
    const ics = patchEvent(parsed, current, input, ctx.config.timezone);
    await ctx.session.client.put(obj.href, ics, obj.etag ? { ifMatch: obj.etag } : {});
    return obj;
  };

  let obj = await locate(ctx, uid, calendar ?? undefined);
  const before = toEvent(ctx, obj);
  try {
    await attempt(obj);
  } catch (e) {
    if (e instanceof CalDavError && e.code === "conflict") {
      obj = await getObject(ctx.session.client, obj.calendar, obj.href);
      await attempt(obj);
    } else throw e;
  }
  const stored = await getObject(ctx.session.client, obj.calendar, obj.href);
  const event = toEvent(ctx, stored);
  return { event, ...(timeFieldsTouched ? { verification: verify(ctx, input, before, event) } : {}) };
}

export async function handleDelete(ctx: Context, params: { uid: string; calendar?: string | null }): Promise<{ deleted: true; uid: string; calendar: string; title: string }> {
  const obj = await locate(ctx, params.uid, params.calendar ?? undefined);
  assertWritable(ctx, obj.calendar);
  const ev = toEvent(ctx, obj);
  try {
    await ctx.session.client.delete(obj.href, obj.etag ? { ifMatch: obj.etag } : {});
  } catch (e) {
    if (e instanceof CalDavError && e.code === "conflict") {
      const fresh = await getObject(ctx.session.client, obj.calendar, obj.href);
      await ctx.session.client.delete(obj.href, fresh.etag ? { ifMatch: fresh.etag } : {});
    } else throw e;
  }
  return { deleted: true, uid: ev.uid, calendar: obj.calendar.name, title: ev.title };
}

export type { Event, EventInput, Recurrence };
