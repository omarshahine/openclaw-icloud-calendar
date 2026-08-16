/**
 * Calendar object queries: time-range REPORT, UID lookup, single GET.
 */

import type { CalDavClient } from "./client.js";
import { CalDavError } from "../errors.js";
import type { CalendarInfo } from "./discovery.js";
import { NS, calendarQueryBody, childOf, okProp, textOf } from "./xml.js";

export interface CalendarObject {
  /** Absolute URL of the .ics resource */
  href: string;
  etag?: string;
  ics: string;
  calendar: CalendarInfo;
}

function collectObjects(client: CalDavClient, calendar: CalendarInfo, responses: ReturnType<typeof import("./xml.js").parseMultiStatus>): CalendarObject[] {
  const out: CalendarObject[] = [];
  for (const r of responses) {
    const prop = okProp(r);
    if (!prop) continue;
    const ics = textOf(childOf(prop, NS.CALDAV, "calendar-data"));
    if (!ics) continue;
    out.push({
      href: client.resolve(r.href, calendar.href),
      etag: textOf(childOf(prop, NS.DAV, "getetag")) || undefined,
      ics,
      calendar,
    });
  }
  return out;
}

export async function queryEventsInRange(
  client: CalDavClient,
  calendar: CalendarInfo,
  start: Date,
  end: Date,
): Promise<CalendarObject[]> {
  const responses = await client.report(calendar.href, calendarQueryBody({ start, end }), "1");
  return collectObjects(client, calendar, responses);
}

/**
 * Find an event by UID. iCloud rejects calendar-query prop-filter on UID
 * with a bare 412, so: (1) try GET <calendar>/<uid>.ics, which is how Apple
 * clients (and this plugin) name objects; (2) fall back to an unfiltered
 * VEVENT REPORT and scan for the UID.
 */
export async function queryByUid(client: CalDavClient, calendar: CalendarInfo, uid: string): Promise<CalendarObject | undefined> {
  const direct = `${calendar.href}${encodeURIComponent(uid)}.ics`;
  try {
    const { text, etag } = await client.get(direct);
    if (extractUid(text) === uid) return { href: direct, etag, ics: text, calendar };
  } catch (e) {
    if (!(e instanceof CalDavError && e.code === "not_found")) throw e;
  }
  const responses = await client.report(calendar.href, calendarQueryBody({}), "1");
  const objs = collectObjects(client, calendar, responses);
  return objs.find((o) => extractUid(o.ics) === uid);
}

export async function getObject(client: CalDavClient, calendar: CalendarInfo, href: string): Promise<CalendarObject> {
  const { text, etag } = await client.get(href);
  return { href, etag, ics: text, calendar };
}

/** Cheap UID extraction without full parsing (first VEVENT UID). */
export function extractUid(ics: string): string | undefined {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const m = /^UID(?:;[^:]*)?:(.*)$/m.exec(unfolded);
  return m ? m[1].trim() : undefined;
}
