/**
 * RRULE parse/build and best-effort occurrence expansion for the common
 * cases (DAILY, WEEKLY+BYDAY, MONTHLY by month-day or ordinal weekday,
 * YEARLY). Exotic rules are preserved verbatim on read but not expanded.
 */

import { invalidInput } from "../errors.js";
import { addDays, formatDateOnly, formatIsoInZone, parseInput, toICalDate, toICalUtc, zonedToUtc, type LocalParts } from "./tz.js";

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Recurrence {
  frequency: Frequency;
  interval?: number;
  count?: number;
  /** ISO date or date-time (as supplied / as formatted in configured tz) */
  until?: string;
  /** e.g. ["MO","WE"] or ["2TU"] (ordinal weekday for MONTHLY) */
  byDay?: string[];
  byMonthDay?: number[];
  /** Raw RRULE for anything we do not model */
  raw?: string;
}

interface ParsedRule {
  freq: Frequency;
  interval: number;
  count?: number;
  until?: { kind: "date"; year: number; month: number; day: number } | { kind: "datetime"; date: Date };
  byDay: { ord: number; day: Weekday }[];
  byMonthDay: number[];
  other: Record<string, string>;
}

function parseRuleString(raw: string): ParsedRule | undefined {
  const parts: Record<string, string> = {};
  for (const kv of raw.split(";")) {
    const eq = kv.indexOf("=");
    if (eq === -1) continue;
    parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1);
  }
  const freq = parts.FREQ as Frequency | undefined;
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return undefined;
  const rule: ParsedRule = { freq, interval: parseInt(parts.INTERVAL ?? "1", 10) || 1, byDay: [], byMonthDay: [], other: {} };
  if (parts.COUNT) rule.count = parseInt(parts.COUNT, 10);
  if (parts.UNTIL) {
    const u = parts.UNTIL;
    if (/^\d{8}$/.test(u)) rule.until = { kind: "date", year: +u.slice(0, 4), month: +u.slice(4, 6), day: +u.slice(6, 8) };
    else if (/^\d{8}T\d{6}Z?$/.test(u)) {
      const d = new Date(Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8), +u.slice(9, 11), +u.slice(11, 13), +u.slice(13, 15)));
      rule.until = { kind: "datetime", date: d };
    }
  }
  if (parts.BYDAY) {
    for (const tok of parts.BYDAY.split(",")) {
      const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok.trim().toUpperCase());
      if (m) rule.byDay.push({ ord: m[1] ? parseInt(m[1], 10) : 0, day: m[2] as Weekday });
    }
  }
  if (parts.BYMONTHDAY) rule.byMonthDay = parts.BYMONTHDAY.split(",").map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
  for (const [k, v] of Object.entries(parts)) {
    if (!["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "WKST"].includes(k)) rule.other[k] = v;
  }
  return rule;
}

/** RRULE value -> Recurrence JSON (for the agent). */
export function rruleToRecurrence(raw: string, tz: string): Recurrence {
  const r = parseRuleString(raw);
  if (!r) return { frequency: "DAILY", raw };
  const out: Recurrence = { frequency: r.freq };
  if (r.interval !== 1) out.interval = r.interval;
  if (r.count) out.count = r.count;
  if (r.until) out.until = r.until.kind === "date" ? formatDateOnly(r.until.year, r.until.month, r.until.day) : formatIsoInZone(r.until.date, tz);
  if (r.byDay.length) out.byDay = r.byDay.map((b) => (b.ord ? `${b.ord}${b.day}` : b.day));
  if (r.byMonthDay.length) out.byMonthDay = r.byMonthDay;
  if (Object.keys(r.other).length) out.raw = raw;
  return out;
}

/** Recurrence JSON (from the agent) -> RRULE value. */
export function recurrenceToRrule(rec: Recurrence, tz: string, allDay: boolean): string {
  if (rec.raw) return rec.raw;
  const freq = String(rec.frequency ?? "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) throw invalidInput(`recurrence.frequency must be DAILY, WEEKLY, MONTHLY, or YEARLY`);
  const parts = [`FREQ=${freq}`];
  if (rec.interval !== undefined) {
    if (!Number.isInteger(rec.interval) || rec.interval < 1) throw invalidInput("recurrence.interval must be a positive integer");
    if (rec.interval !== 1) parts.push(`INTERVAL=${rec.interval}`);
  }
  if (rec.count !== undefined && rec.until !== undefined) throw invalidInput("recurrence: specify count or until, not both");
  if (rec.count !== undefined) {
    if (!Number.isInteger(rec.count) || rec.count < 1) throw invalidInput("recurrence.count must be a positive integer");
    parts.push(`COUNT=${rec.count}`);
  }
  if (rec.until !== undefined) {
    const u = parseInput(rec.until, tz, "recurrence.until");
    if (u.kind === "date") {
      // For timed events UNTIL must be a UTC date-time; use end of that local day.
      parts.push(`UNTIL=${allDay ? toICalDate(u.year, u.month, u.day) : toICalUtc(zonedToUtc({ year: u.year, month: u.month, day: u.day, hour: 23, minute: 59, second: 59 }, tz))}`);
    } else {
      parts.push(`UNTIL=${toICalUtc(u.date)}`);
    }
  }
  if (rec.byDay?.length) {
    const days = rec.byDay.map((d) => d.toUpperCase().trim());
    for (const d of days) if (!/^([+-]?[1-5])?(SU|MO|TU|WE|TH|FR|SA)$/.test(d)) throw invalidInput(`recurrence.byDay entry "${d}" is not valid (use MO, TU, ... or 2TU)`);
    parts.push(`BYDAY=${days.join(",")}`);
  }
  if (rec.byMonthDay?.length) {
    for (const n of rec.byMonthDay) if (!Number.isInteger(n) || n === 0 || n < -31 || n > 31) throw invalidInput("recurrence.byMonthDay entries must be 1..31 or -1..-31");
    parts.push(`BYMONTHDAY=${rec.byMonthDay.join(",")}`);
  }
  return parts.join(";");
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

export interface ExpandOptions {
  /** DTSTART wall-clock parts (in `tz`) */
  start: LocalParts;
  allDay: boolean;
  tz: string;
  rangeStart: Date;
  rangeEnd: Date;
  /** EXDATE instants (timed) or Y-M-D keys (all-day) */
  exdates: Set<string>;
  cap: number;
}

export interface ExpansionResult {
  /** Instants (timed) or Y-M-D triples (all-day) */
  occurrences: (Date | { year: number; month: number; day: number })[];
  truncated: boolean;
  supported: boolean;
}

function weekdayOf(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Yield candidate wall-clock dates (Y-M-D) for the rule, unbounded; caller stops. */
function* candidates(rule: ParsedRule, start: LocalParts): Generator<{ year: number; month: number; day: number }> {
  const s = { year: start.year, month: start.month, day: start.day };
  if (rule.freq === "DAILY") {
    let i = 0;
    for (;;) yield addDays(s.year, s.month, s.day, i++ * rule.interval);
  }
  if (rule.freq === "WEEKLY") {
    const days = rule.byDay.length ? rule.byDay.map((b) => WEEKDAYS.indexOf(b.day)) : [weekdayOf(s.year, s.month, s.day)];
    // Week start Monday-ish is irrelevant for the set of days; iterate from the start's week.
    const startWd = weekdayOf(s.year, s.month, s.day);
    const weekAnchor = addDays(s.year, s.month, s.day, -startWd); // Sunday of start week
    for (let w = 0; ; w += rule.interval) {
      const base = addDays(weekAnchor.year, weekAnchor.month, weekAnchor.day, w * 7);
      for (const wd of [...days].sort((a, b) => a - b)) {
        const c = addDays(base.year, base.month, base.day, wd);
        if (w === 0 && cmpYmd(c, s) < 0) continue;
        yield c;
      }
    }
  }
  if (rule.freq === "MONTHLY") {
    for (let k = 0; ; k += rule.interval) {
      const t = new Date(Date.UTC(s.year, s.month - 1 + k, 1));
      const y = t.getUTCFullYear();
      const m = t.getUTCMonth() + 1;
      const dim = daysInMonth(y, m);
      const found: number[] = [];
      if (rule.byDay.length) {
        for (const b of rule.byDay) {
          const wd = WEEKDAYS.indexOf(b.day);
          const first = weekdayOf(y, m, 1);
          const firstMatch = 1 + ((wd - first + 7) % 7);
          if (b.ord > 0) {
            const d = firstMatch + (b.ord - 1) * 7;
            if (d <= dim) found.push(d);
          } else if (b.ord < 0) {
            const lastMatch = firstMatch + Math.floor((dim - firstMatch) / 7) * 7;
            const d = lastMatch + (b.ord + 1) * 7;
            if (d >= 1) found.push(d);
          } else {
            for (let d = firstMatch; d <= dim; d += 7) found.push(d);
          }
        }
      } else if (rule.byMonthDay.length) {
        for (const md of rule.byMonthDay) {
          const d = md > 0 ? md : dim + md + 1;
          if (d >= 1 && d <= dim) found.push(d);
        }
      } else if (s.day <= dim) {
        found.push(s.day);
      }
      for (const d of [...new Set(found)].sort((a, b) => a - b)) {
        const c = { year: y, month: m, day: d };
        if (k === 0 && cmpYmd(c, s) < 0) continue;
        yield c;
      }
    }
  }
  if (rule.freq === "YEARLY") {
    for (let k = 0; ; k += rule.interval) {
      const y = s.year + k;
      if (s.day <= daysInMonth(y, s.month)) yield { year: y, month: s.month, day: s.day };
    }
  }
}

function cmpYmd(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export function expandRrule(raw: string, opts: ExpandOptions): ExpansionResult {
  const rule = parseRuleString(raw);
  if (!rule || Object.keys(rule.other).length > 0 || (rule.freq === "YEARLY" && (rule.byDay.length || rule.byMonthDay.length)) || (rule.freq === "DAILY" && (rule.byDay.length || rule.byMonthDay.length)) || (rule.freq === "WEEKLY" && rule.byMonthDay.length)) {
    return { occurrences: [], truncated: false, supported: false };
  }
  const out: ExpansionResult["occurrences"] = [];
  let produced = 0; // counts toward COUNT (includes occurrences before the range)
  let truncated = false;
  const gen = candidates(rule, opts.start);
  let guard = 0;
  for (const c of gen) {
    if (++guard > 100_000) break;
    if (rule.count !== undefined && produced >= rule.count) break;
    if (opts.allDay) {
      if (rule.until?.kind === "date" && cmpYmd(c, rule.until) > 0) break;
      if (rule.until?.kind === "datetime" && Date.UTC(c.year, c.month - 1, c.day) > rule.until.date.getTime()) break;
      produced++;
      const key = formatDateOnly(c.year, c.month, c.day);
      if (opts.exdates.has(key)) continue;
      const startMs = Date.UTC(c.year, c.month - 1, c.day);
      if (startMs >= opts.rangeEnd.getTime()) break;
      if (startMs + 86_400_000 <= opts.rangeStart.getTime()) continue;
      if (out.length >= opts.cap) {
        truncated = true;
        break;
      }
      out.push(c);
    } else {
      const inst = zonedToUtc({ ...c, hour: opts.start.hour, minute: opts.start.minute, second: opts.start.second }, opts.tz);
      if (rule.until?.kind === "datetime" && inst.getTime() > rule.until.date.getTime()) break;
      if (rule.until?.kind === "date" && cmpYmd(c, rule.until) > 0) break;
      produced++;
      if (opts.exdates.has(inst.toISOString())) continue;
      if (inst.getTime() >= opts.rangeEnd.getTime()) break;
      if (inst.getTime() < opts.rangeStart.getTime()) continue;
      if (out.length >= opts.cap) {
        truncated = true;
        break;
      }
      out.push(inst);
    }
  }
  return { occurrences: out, truncated, supported: true };
}
