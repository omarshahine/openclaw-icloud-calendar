/**
 * Timezone and date helpers using only Intl (no tz database dependency).
 */

import { invalidInput } from "../errors.js";

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a zone. */
export function partsInZone(date: Date, tz: string): LocalParts {
  const parts = dtf(tz).formatToParts(date);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** Offset of `tz` from UTC at `date`, in minutes (e.g. -420 for PDT). */
export function offsetMinutes(date: Date, tz: string): number {
  const p = partsInZone(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Convert wall-clock parts in `tz` to an instant. Handles DST gaps/overlaps reasonably. */
export function zonedToUtc(p: LocalParts, tz: string): Date {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  let off = offsetMinutes(new Date(guess), tz);
  let result = guess - off * 60000;
  const off2 = offsetMinutes(new Date(result), tz);
  if (off2 !== off) {
    off = off2;
    result = guess - off * 60000;
  }
  return new Date(result);
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function formatOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** ISO 8601 with offset in the given zone: 2026-08-16T09:00:00-07:00 */
export function formatIsoInZone(date: Date, tz: string): string {
  const p = partsInZone(date, tz);
  const off = offsetMinutes(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${formatOffset(off)}`;
}

export function formatDateOnly(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

// ---------------------------------------------------------------------------
// User input parsing
// ---------------------------------------------------------------------------

export type ParsedInput = { kind: "date"; year: number; month: number; day: number } | { kind: "datetime"; date: Date };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse an agent-supplied date/time. Accepts YYYY-MM-DD (date), ISO 8601
 * with Z or offset, or a naive local time interpreted in `tz`.
 */
export function parseInput(input: string, tz: string, field = "date"): ParsedInput {
  const s = input.trim();
  let m = DATE_RE.exec(s);
  if (m) {
    const [year, month, day] = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
    validateYmd(year, month, day, field, s);
    return { kind: "date", year, month, day };
  }
  m = DATETIME_RE.exec(s);
  if (m) {
    const parts: LocalParts = {
      year: parseInt(m[1], 10),
      month: parseInt(m[2], 10),
      day: parseInt(m[3], 10),
      hour: parseInt(m[4], 10),
      minute: parseInt(m[5], 10),
      second: m[6] ? parseInt(m[6], 10) : 0,
    };
    validateYmd(parts.year, parts.month, parts.day, field, s);
    if (parts.hour > 23 || parts.minute > 59 || parts.second > 60) throw invalidInput(`Invalid time in ${field}: "${s}"`);
    const zone = m[7];
    if (!zone) return { kind: "datetime", date: zonedToUtc(parts, tz) };
    if (zone === "Z") return { kind: "datetime", date: new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)) };
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const offMin = sign * (parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2, 4), 10));
    const utc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - offMin * 60000;
    return { kind: "datetime", date: new Date(utc) };
  }
  throw invalidInput(`Invalid ${field}: "${s}". Use YYYY-MM-DD for all-day, or ISO 8601 like 2026-08-16T09:00 (local, ${tz}) or 2026-08-16T16:00:00Z.`);
}

function validateYmd(y: number, m: number, d: number, field: string, raw: string): void {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) throw invalidInput(`Invalid ${field}: "${raw}"`);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) throw invalidInput(`Invalid ${field}: "${raw}" (no such day)`);
}

// ---------------------------------------------------------------------------
// iCalendar date-time values
// ---------------------------------------------------------------------------

export type ICalDateValue =
  | { kind: "date"; year: number; month: number; day: number }
  | { kind: "datetime"; date: Date; tzid?: string; floating: boolean };

const ICAL_DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const ICAL_DT_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;

/**
 * Parse a DTSTART/DTEND/etc value. Floating times (no TZID, no Z) are
 * interpreted in `defaultTz`. Unknown TZIDs fall back to `defaultTz`.
 */
export function parseICalDate(value: string, params: Record<string, string>, defaultTz: string): ICalDateValue {
  const v = value.trim();
  let m = ICAL_DATE_RE.exec(v);
  if (m || params.VALUE === "DATE") {
    m = m ?? ICAL_DATE_RE.exec(v.slice(0, 8));
    if (!m) throw new Error(`Bad iCalendar DATE: ${v}`);
    return { kind: "date", year: parseInt(m[1], 10), month: parseInt(m[2], 10), day: parseInt(m[3], 10) };
  }
  m = ICAL_DT_RE.exec(v);
  if (!m) throw new Error(`Bad iCalendar DATE-TIME: ${v}`);
  const parts: LocalParts = {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10),
    day: parseInt(m[3], 10),
    hour: parseInt(m[4], 10),
    minute: parseInt(m[5], 10),
    second: parseInt(m[6], 10),
  };
  if (m[7] === "Z") {
    return { kind: "datetime", date: new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)), floating: false };
  }
  const tzid = params.TZID;
  if (tzid) {
    const zone = normalizeTzid(tzid);
    if (zone && isValidTimeZone(zone)) return { kind: "datetime", date: zonedToUtc(parts, zone), tzid: zone, floating: false };
    return { kind: "datetime", date: zonedToUtc(parts, defaultTz), tzid, floating: false };
  }
  return { kind: "datetime", date: zonedToUtc(parts, defaultTz), floating: true };
}

/** Map a few common non-IANA TZID spellings; return undefined if hopeless. */
export function normalizeTzid(tzid: string): string | undefined {
  const t = tzid.trim().replace(/^\/(?:[^/]+\/)*?(?=[A-Z][a-z]+\/)/, ""); // strip Olson-style prefixes like /freeassociation.sourceforge.net/
  if (isValidTimeZone(t)) return t;
  const WINDOWS: Record<string, string> = {
    "Pacific Standard Time": "America/Los_Angeles",
    "Mountain Standard Time": "America/Denver",
    "Central Standard Time": "America/Chicago",
    "Eastern Standard Time": "America/New_York",
    "GMT Standard Time": "Europe/London",
    "W. Europe Standard Time": "Europe/Berlin",
    "Central Europe Standard Time": "Europe/Budapest",
    "Romance Standard Time": "Europe/Paris",
    "Tokyo Standard Time": "Asia/Tokyo",
    "China Standard Time": "Asia/Shanghai",
    "India Standard Time": "Asia/Kolkata",
    "AUS Eastern Standard Time": "Australia/Sydney",
    UTC: "UTC",
    GMT: "UTC",
    Z: "UTC",
  };
  return WINDOWS[t];
}

export function toICalUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function toICalDate(y: number, m: number, d: number): string {
  return `${y}${pad(m)}${pad(d)}`;
}

/** Add days to a Y-M-D triple (UTC arithmetic, calendar-safe). */
export function addDays(y: number, m: number, d: number, n: number): { year: number; month: number; day: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}
