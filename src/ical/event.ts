/**
 * Event JSON <-> iCalendar VEVENT.
 */

import { invalidInput } from "../errors.js";
import {
  escapeText,
  getProp,
  getProps,
  parseICalendar,
  removeProp,
  serializeICalendar,
  setProp,
  unescapeText,
  type Component,
} from "./component.js";
import { expandRrule, recurrenceToRrule, rruleToRecurrence, type Recurrence } from "./rrule.js";
import {
  addDays,
  formatDateOnly,
  formatIsoInZone,
  parseICalDate,
  parseInput,
  partsInZone,
  toICalDate,
  toICalUtc,
  zonedToUtc,
  type ICalDateValue,
} from "./tz.js";

export const PRODID = "-//omarshahine//openclaw-icloud-calendar//EN";

export interface Event {
  uid: string;
  calendarId: string;
  calendar: string;
  title: string;
  /** ISO 8601 with offset (timed) or YYYY-MM-DD (all-day, inclusive) */
  start: string;
  /** ISO 8601 with offset (timed) or YYYY-MM-DD (all-day, inclusive last day) */
  end: string;
  allDay: boolean;
  timezone: string;
  location?: string;
  notes?: string;
  url?: string;
  status?: string;
  recurrence?: Recurrence;
  /** Best-effort expansion of upcoming occurrences within the queried range */
  nextOccurrences?: string[];
  nextOccurrencesTruncated?: boolean;
  /** Number of per-instance overrides present on the server (not editable in v1) */
  overrideCount?: number;
  /** Minutes before start */
  alarms?: number[];
  etag?: string;
  lastModified?: string;
  readOnly: boolean;
}

export interface EventInput {
  title?: string;
  start?: string;
  end?: string;
  /** Minutes; alternative to end */
  duration?: number;
  allDay?: boolean;
  location?: string | null;
  notes?: string | null;
  url?: string | null;
  alarms?: number[] | null;
  recurrence?: Recurrence | null;
}

export interface ParsedEvent {
  vcal: Component;
  master: Component;
  overrides: Component[];
}

export function parseEventDocument(ics: string): ParsedEvent {
  const vcal = parseICalendar(ics);
  const vevents = vcal.children.filter((c) => c.name === "VEVENT");
  if (vevents.length === 0) throw new Error("iCalendar document has no VEVENT");
  const master = vevents.find((v) => !getProp(v, "RECURRENCE-ID")) ?? vevents[0];
  return { vcal, master, overrides: vevents.filter((v) => v !== master) };
}

function textValue(c: Component, name: string): string | undefined {
  const p = getProp(c, name);
  if (!p) return undefined;
  const v = unescapeText(p.value);
  return v.length ? v : undefined;
}

/** Parse a VALARM TRIGGER duration like -PT15M / -P1D / PT0S into minutes-before. */
export function triggerToMinutes(trigger: string): number | undefined {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(trigger.trim());
  if (!m) return undefined;
  const sign = m[1] === "-" ? -1 : 1;
  const mins = (+(m[2] ?? 0)) * 7 * 1440 + (+(m[3] ?? 0)) * 1440 + (+(m[4] ?? 0)) * 60 + (+(m[5] ?? 0)) + Math.round((+(m[6] ?? 0)) / 60);
  if (mins === 0) return 0;
  return sign < 0 ? mins : -mins; // "before" is positive in our JSON
}

export function minutesToTrigger(minutesBefore: number): string {
  const total = Math.abs(minutesBefore);
  const sign = minutesBefore >= 0 ? "-" : "";
  if (total === 0) return "PT0S";
  if (total % 1440 === 0) return `${sign}P${total / 1440}D`;
  if (total % 60 === 0) return `${sign}PT${total / 60}H`;
  return `${sign}PT${total}M`;
}

export interface ToEventOptions {
  tz: string;
  calendarId: string;
  calendarName: string;
  readOnly: boolean;
  etag?: string;
  /** If provided, recurring masters get nextOccurrences within this range */
  range?: { start: Date; end: Date };
  occurrenceCap?: number;
}

export function componentToEvent(parsed: ParsedEvent, opts: ToEventOptions): Event {
  const v = parsed.master;
  const dtstartProp = getProp(v, "DTSTART");
  if (!dtstartProp) throw new Error("VEVENT missing DTSTART");
  const start = parseICalDate(dtstartProp.value, dtstartProp.params, opts.tz);
  let end: ICalDateValue | undefined;
  const dtendProp = getProp(v, "DTEND");
  const durProp = getProp(v, "DURATION");
  if (dtendProp) end = parseICalDate(dtendProp.value, dtendProp.params, opts.tz);
  else if (durProp) end = applyDuration(start, durProp.value);
  if (!end) end = start.kind === "date" ? { kind: "date", ...addDays(start.year, start.month, start.day, 1) } : { kind: "datetime", date: start.date, floating: start.floating };

  const allDay = start.kind === "date";
  const ev: Event = {
    uid: textValue(v, "UID") ?? "",
    calendarId: opts.calendarId,
    calendar: opts.calendarName,
    title: textValue(v, "SUMMARY") ?? "",
    start: allDay && start.kind === "date" ? formatDateOnly(start.year, start.month, start.day) : formatIsoInZone((start as { date: Date }).date, opts.tz),
    end: formatEnd(end, allDay, opts.tz),
    allDay,
    timezone: opts.tz,
    readOnly: opts.readOnly,
  };
  const loc = textValue(v, "LOCATION");
  if (loc) ev.location = loc;
  const notes = textValue(v, "DESCRIPTION");
  if (notes) ev.notes = notes;
  const url = getProp(v, "URL")?.value;
  if (url) ev.url = url;
  const status = getProp(v, "STATUS")?.value;
  if (status) ev.status = status.toUpperCase();
  const rrule = getProp(v, "RRULE")?.value;
  if (rrule) {
    ev.recurrence = rruleToRecurrence(rrule, opts.tz);
    if (opts.range) {
      const exdates = new Set<string>();
      for (const ex of getProps(v, "EXDATE")) {
        for (const val of ex.value.split(",")) {
          try {
            const d = parseICalDate(val, ex.params, opts.tz);
            exdates.add(d.kind === "date" ? formatDateOnly(d.year, d.month, d.day) : d.date.toISOString());
          } catch {
            /* ignore malformed EXDATE */
          }
        }
      }
      const startParts = start.kind === "date" ? { year: start.year, month: start.month, day: start.day, hour: 0, minute: 0, second: 0 } : partsInZone(start.date, start.tzid ?? opts.tz);
      const zone = start.kind === "datetime" && start.tzid ? start.tzid : opts.tz;
      const exp = expandRrule(rrule, { start: startParts, allDay, tz: zone, rangeStart: opts.range.start, rangeEnd: opts.range.end, exdates, cap: opts.occurrenceCap ?? 50 });
      if (exp.supported) {
        ev.nextOccurrences = exp.occurrences.map((o) => (o instanceof Date ? formatIsoInZone(o, opts.tz) : formatDateOnly(o.year, o.month, o.day)));
        if (exp.truncated) ev.nextOccurrencesTruncated = true;
      }
    }
  }
  if (parsed.overrides.length) ev.overrideCount = parsed.overrides.length;
  const alarms = v.children
    .filter((c) => c.name === "VALARM")
    .map((a) => getProp(a, "TRIGGER"))
    .filter((t): t is NonNullable<typeof t> => !!t && !t.params.VALUE)
    .map((t) => triggerToMinutes(t.value))
    .filter((n): n is number => n !== undefined);
  if (alarms.length) ev.alarms = alarms;
  if (opts.etag) ev.etag = opts.etag;
  const lm = getProp(v, "LAST-MODIFIED")?.value;
  if (lm) {
    try {
      const d = parseICalDate(lm, {}, "UTC");
      if (d.kind === "datetime") ev.lastModified = d.date.toISOString();
    } catch {
      /* ignore */
    }
  }
  return ev;
}

function formatEnd(end: ICalDateValue, allDay: boolean, tz: string): string {
  if (end.kind === "date") {
    // iCalendar DTEND for all-day is exclusive; present inclusive last day.
    const inc = addDays(end.year, end.month, end.day, -1);
    return formatDateOnly(inc.year, inc.month, inc.day);
  }
  if (allDay) {
    const p = partsInZone(end.date, tz);
    return formatDateOnly(p.year, p.month, p.day);
  }
  return formatIsoInZone(end.date, tz);
}

function applyDuration(start: ICalDateValue, dur: string): ICalDateValue {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(dur.trim());
  if (!m) return start;
  const sign = m[1] === "-" ? -1 : 1;
  const days = (+(m[2] ?? 0)) * 7 + (+(m[3] ?? 0));
  const secs = (+(m[4] ?? 0)) * 3600 + (+(m[5] ?? 0)) * 60 + (+(m[6] ?? 0));
  if (start.kind === "date") return { kind: "date", ...addDays(start.year, start.month, start.day, sign * days) };
  return { kind: "datetime", date: new Date(start.date.getTime() + sign * (days * 86400 + secs) * 1000), tzid: start.tzid, floating: start.floating };
}

// ---------------------------------------------------------------------------
// Build / patch
// ---------------------------------------------------------------------------

interface ResolvedTimes {
  allDay: boolean;
  startDate?: { year: number; month: number; day: number };
  endDate?: { year: number; month: number; day: number }; // exclusive
  start?: Date;
  end?: Date;
}

/**
 * Resolve start/end/duration/allDay from agent input. `existing` supplies
 * defaults for update. For all-day events `end` is the inclusive last day.
 */
export function resolveTimes(input: EventInput, tz: string, existing?: Event): ResolvedTimes {
  const startRaw = input.start ?? existing?.start;
  if (!startRaw) throw invalidInput("start is required");
  const startParsed = parseInput(startRaw, tz, "start");
  const wantAllDay = input.allDay ?? (input.start !== undefined ? startParsed.kind === "date" : existing?.allDay ?? startParsed.kind === "date");

  if (wantAllDay) {
    const s = startParsed.kind === "date" ? startParsed : partsInZone(startParsed.date, tz);
    let endInclusive: { year: number; month: number; day: number };
    if (input.end !== undefined) {
      const e = parseInput(input.end, tz, "end");
      endInclusive = e.kind === "date" ? e : partsInZone(e.date, tz);
    } else if (input.duration !== undefined) {
      if (!Number.isInteger(input.duration) || input.duration <= 0) throw invalidInput("duration must be a positive integer number of minutes");
      endInclusive = addDays(s.year, s.month, s.day, Math.max(1, Math.ceil(input.duration / 1440)) - 1);
    } else if (existing?.allDay && input.start === undefined && existing.end) {
      const e = parseInput(existing.end, tz, "end");
      endInclusive = e.kind === "date" ? e : partsInZone(e.date, tz);
    } else {
      endInclusive = { year: s.year, month: s.month, day: s.day };
    }
    const startDate = { year: s.year, month: s.month, day: s.day };
    if (cmp(endInclusive, startDate) < 0) throw invalidInput("end must not be before start");
    return { allDay: true, startDate, endDate: addDays(endInclusive.year, endInclusive.month, endInclusive.day, 1) };
  }

  const start = startParsed.kind === "date" ? dateAtMidnight(startParsed, tz) : startParsed.date;
  let end: Date;
  if (input.end !== undefined) {
    const e = parseInput(input.end, tz, "end");
    end = e.kind === "date" ? dateAtMidnight(e, tz) : e.date;
  } else if (input.duration !== undefined) {
    if (!Number.isInteger(input.duration) || input.duration <= 0) throw invalidInput("duration must be a positive integer number of minutes");
    end = new Date(start.getTime() + input.duration * 60000);
  } else if (existing && !existing.allDay && input.start !== undefined) {
    // Keep the existing duration when only start moves.
    const es = parseInput(existing.start, tz).kind === "datetime" ? (parseInput(existing.start, tz) as { date: Date }).date : start;
    const ee = parseInput(existing.end, tz).kind === "datetime" ? (parseInput(existing.end, tz) as { date: Date }).date : es;
    end = new Date(start.getTime() + Math.max(0, ee.getTime() - es.getTime()));
  } else if (existing && !existing.allDay) {
    end = (parseInput(existing.end, tz) as { date: Date }).date;
  } else {
    end = new Date(start.getTime() + 60 * 60000);
  }
  if (end.getTime() < start.getTime()) throw invalidInput("end must not be before start");
  return { allDay: false, start, end };
}

function dateAtMidnight(d: { year: number; month: number; day: number }, tz: string): Date {
  return zonedToUtc({ year: d.year, month: d.month, day: d.day, hour: 0, minute: 0, second: 0 }, tz);
}

function cmp(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

function applyTimes(v: Component, t: ResolvedTimes): void {
  removeProp(v, "DURATION");
  if (t.allDay && t.startDate && t.endDate) {
    setProp(v, "DTSTART", toICalDate(t.startDate.year, t.startDate.month, t.startDate.day), { VALUE: "DATE" });
    setProp(v, "DTEND", toICalDate(t.endDate.year, t.endDate.month, t.endDate.day), { VALUE: "DATE" });
  } else if (t.start && t.end) {
    setProp(v, "DTSTART", toICalUtc(t.start));
    setProp(v, "DTEND", toICalUtc(t.end));
  }
}

function applyOptionalText(v: Component, name: string, value: string | null | undefined): void {
  if (value === undefined) return;
  if (value === null || value === "") removeProp(v, name);
  else setProp(v, name, escapeText(value));
}

function applyAlarms(v: Component, alarms: number[] | null | undefined): void {
  if (alarms === undefined) return;
  v.children = v.children.filter((c) => c.name !== "VALARM");
  if (!alarms) return;
  for (const mins of alarms) {
    if (!Number.isInteger(mins) || mins < 0 || mins > 4 * 7 * 1440) throw invalidInput("alarms entries must be whole minutes before start (0..40320)");
    v.children.push({
      name: "VALARM",
      props: [
        { name: "ACTION", params: {}, value: "DISPLAY" },
        { name: "DESCRIPTION", params: {}, value: "Reminder" },
        { name: "TRIGGER", params: {}, value: minutesToTrigger(mins) },
      ],
      children: [],
    });
  }
}

function applyRecurrence(v: Component, rec: Recurrence | null | undefined, tz: string, allDay: boolean): void {
  if (rec === undefined) return;
  if (rec === null) {
    removeProp(v, "RRULE");
    removeProp(v, "EXDATE");
    removeProp(v, "RDATE");
    return;
  }
  setProp(v, "RRULE", recurrenceToRrule(rec, tz, allDay));
}

export function buildNewEvent(input: EventInput, tz: string, uid: string): { ics: string; uid: string } {
  if (!input.title || !input.title.trim()) throw invalidInput("title is required");
  const times = resolveTimes(input, tz);
  const now = toICalUtc(new Date());
  const v: Component = {
    name: "VEVENT",
    props: [
      { name: "UID", params: {}, value: uid },
      { name: "DTSTAMP", params: {}, value: now },
      { name: "CREATED", params: {}, value: now },
      { name: "LAST-MODIFIED", params: {}, value: now },
      { name: "SUMMARY", params: {}, value: escapeText(input.title.trim()) },
    ],
    children: [],
  };
  applyTimes(v, times);
  applyOptionalText(v, "LOCATION", input.location);
  applyOptionalText(v, "DESCRIPTION", input.notes);
  if (input.url) setProp(v, "URL", input.url);
  applyRecurrence(v, input.recurrence, tz, times.allDay);
  applyAlarms(v, input.alarms);
  const vcal: Component = {
    name: "VCALENDAR",
    props: [
      { name: "VERSION", params: {}, value: "2.0" },
      { name: "PRODID", params: {}, value: PRODID },
      { name: "CALSCALE", params: {}, value: "GREGORIAN" },
    ],
    children: [v],
  };
  return { ics: serializeICalendar(vcal), uid };
}

/** Apply a partial update to an existing document's master VEVENT and re-serialize. */
export function patchEvent(parsed: ParsedEvent, current: Event, input: EventInput, tz: string): string {
  const v = parsed.master;
  if (input.title !== undefined) {
    if (!input.title.trim()) throw invalidInput("title cannot be empty");
    setProp(v, "SUMMARY", escapeText(input.title.trim()));
  }
  if (input.start !== undefined || input.end !== undefined || input.duration !== undefined || input.allDay !== undefined) {
    const times = resolveTimes(input, tz, current);
    applyTimes(v, times);
    if (times.allDay !== current.allDay) {
      // Switching all-day <-> timed invalidates per-instance overrides and RRULE date types.
      parsed.vcal.children = parsed.vcal.children.filter((c) => c === v || c.name !== "VEVENT");
      parsed.overrides = [];
      if (input.recurrence === undefined && current.recurrence) {
        setProp(v, "RRULE", recurrenceToRrule(current.recurrence, tz, times.allDay));
      }
    }
  }
  applyOptionalText(v, "LOCATION", input.location);
  applyOptionalText(v, "DESCRIPTION", input.notes);
  if (input.url !== undefined) {
    if (input.url === null || input.url === "") removeProp(v, "URL");
    else setProp(v, "URL", input.url);
  }
  const allDayNow = getProp(v, "DTSTART")?.params.VALUE === "DATE";
  applyRecurrence(v, input.recurrence, tz, allDayNow);
  applyAlarms(v, input.alarms);
  const now = toICalUtc(new Date());
  setProp(v, "DTSTAMP", now);
  setProp(v, "LAST-MODIFIED", now);
  setProp(v, "SEQUENCE", String((parseInt(getProp(v, "SEQUENCE")?.value ?? "0", 10) || 0) + 1));
  return serializeICalendar(parsed.vcal);
}
