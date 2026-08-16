/**
 * In-memory fake of iCloud's CalDAV surface, driven through the client's
 * injectable fetch. Mirrors the shapes we rely on:
 *  - PROPFIND / (Depth 0)             -> current-user-principal on pNN host
 *  - PROPFIND principal (Depth 0)     -> calendar-home-set
 *  - PROPFIND home (Depth 1)          -> calendars with props
 *  - REPORT calendar (calendar-query) -> time-range or UID prop-filter
 *  - GET/PUT/DELETE object            -> etag + If-Match / If-None-Match
 */

import { extractUid } from "../../src/caldav/query.js";
import { parseICalendar, getProp } from "../../src/ical/component.js";
import { parseICalDate } from "../../src/ical/tz.js";
import type { FetchLike } from "../../src/caldav/client.js";

export interface FakeCalendar {
  path: string; // e.g. "/1234/calendars/home/"
  name: string;
  color?: string;
  readOnly?: boolean;
  components?: string[];
  ctag?: string;
}

interface StoredObject {
  ics: string;
  etag: string;
}

export interface RequestLog {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export class FakeICloud {
  readonly root = "https://caldav.icloud.com/";
  readonly partition = "https://p42-caldav.icloud.com";
  readonly principalPath = "/1234/principal/";
  readonly homePath = "/1234/calendars/";
  readonly log: RequestLog[] = [];
  readonly objects = new Map<string, StoredObject>(); // absolute URL -> object
  private etagCounter = 1;
  username = "user@icloud.com";
  password = "abcd-efgh-ijkl-mnop";
  /** When set, the next matching request returns this status once */
  failNext?: { method: string; status: number };

  constructor(readonly calendars: FakeCalendar[]) {}

  get fetch(): FetchLike {
    return async (input, init) => this.handle(input, init);
  }

  seed(calendarPath: string, filename: string, ics: string): string {
    const url = `${this.partition}${calendarPath}${filename}`;
    this.objects.set(url, { ics, etag: `"e${this.etagCounter++}"` });
    return url;
  }

  private authorized(headers: Record<string, string>): boolean {
    const expected = "Basic " + Buffer.from(`${this.username}:${this.password}`).toString("base64");
    return headers.authorization === expected;
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const body = typeof init.body === "string" ? init.body : undefined;
    this.log.push({ method, url, headers, body });

    if (this.failNext && this.failNext.method === method) {
      const status = this.failNext.status;
      this.failNext = undefined;
      return new Response("simulated failure", { status });
    }

    if (!this.authorized(headers)) return new Response("Unauthorized", { status: 401 });

    const u = new URL(url);
    // Root PROPFIND on caldav.icloud.com redirects to the partition host (as iCloud does for some clients)
    if (u.origin === "https://caldav.icloud.com" && method === "PROPFIND" && u.pathname === "/") {
      return new Response(null, { status: 301, headers: { Location: `${this.partition}/` } });
    }
    if (u.origin !== this.partition) return new Response("Not found", { status: 404 });

    if (method === "PROPFIND") {
      if (u.pathname === "/") {
        return xml(207, multistatus([response("/", `<D:current-user-principal><D:href>${this.principalPath}</D:href></D:current-user-principal>`)]));
      }
      if (u.pathname === this.principalPath) {
        return xml(207, multistatus([response(this.principalPath, `<C:calendar-home-set><D:href>${this.partition}${this.homePath}</D:href></C:calendar-home-set>`)]));
      }
      if (u.pathname === this.homePath) {
        if (headers.depth !== "1") return new Response("Bad Depth", { status: 400 });
        const items = [response(this.homePath, `<D:resourcetype><D:collection/></D:resourcetype><D:displayname>Home</D:displayname>`)];
        for (const c of this.calendars) {
          const comps = (c.components ?? ["VEVENT"]).map((n) => `<C:comp name="${n}"/>`).join("");
          const priv = c.readOnly ? `<D:privilege><D:read/></D:privilege>` : `<D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege>`;
          items.push(
            response(
              c.path,
              `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>` +
                `<D:displayname>${esc(c.name)}</D:displayname>` +
                (c.color ? `<A:calendar-color symbolic-color="custom">${c.color}</A:calendar-color>` : "") +
                `<CS:getctag>${c.ctag ?? "ctag-1"}</CS:getctag>` +
                `<D:current-user-privilege-set>${priv}</D:current-user-privilege-set>` +
                `<C:supported-calendar-component-set>${comps}</C:supported-calendar-component-set>`,
            ),
          );
        }
        // iCloud also lists inbox/outbox/notification collections; include one to make sure we skip it.
        items.push(response(`${this.homePath}inbox/`, `<D:resourcetype><D:collection/><C:schedule-inbox/></D:resourcetype>`));
        return xml(207, multistatus(items));
      }
      return new Response("Not found", { status: 404 });
    }

    if (method === "REPORT") {
      const cal = this.calendars.find((c) => c.path === u.pathname);
      if (!cal) return new Response("Not found", { status: 404 });
      if (headers.depth !== "1") return new Response("Bad Depth", { status: 400 });
      const b = body ?? "";
      const uidMatch = /<C:text-match[^>]*>([^<]*)<\/C:text-match>/.exec(b);
      const range = /<C:time-range start="(\d{8}T\d{6}Z)" end="(\d{8}T\d{6}Z)"\/>/.exec(b);
      const items: string[] = [];
      for (const [objUrl, obj] of this.objects) {
        if (!objUrl.startsWith(`${this.partition}${cal.path}`)) continue;
        if (uidMatch) {
          if (extractUid(obj.ics) !== unesc(uidMatch[1])) continue;
        } else if (range) {
          if (!overlaps(obj.ics, isoFromICal(range[1]), isoFromICal(range[2]))) continue;
        }
        items.push(response(new URL(objUrl).pathname, `<D:getetag>${esc(obj.etag)}</D:getetag><C:calendar-data>${esc(obj.ics)}</C:calendar-data>`));
      }
      return xml(207, multistatus(items));
    }

    if (method === "GET") {
      const obj = this.objects.get(url);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.ics, { status: 200, headers: { ETag: obj.etag, "Content-Type": "text/calendar" } });
    }

    if (method === "PUT") {
      const cal = this.calendars.find((c) => u.pathname.startsWith(c.path));
      if (!cal) return new Response("Not found", { status: 404 });
      if (cal.readOnly) return new Response("Forbidden", { status: 403 });
      const existing = this.objects.get(url);
      if (headers["if-none-match"] === "*" && existing) return new Response("Exists", { status: 412 });
      if (headers["if-match"] && (!existing || existing.etag !== headers["if-match"])) return new Response("Precondition Failed", { status: 412 });
      const etag = `"e${this.etagCounter++}"`;
      this.objects.set(url, { ics: body ?? "", etag });
      return new Response(null, { status: existing ? 204 : 201, headers: { ETag: etag } });
    }

    if (method === "DELETE") {
      const existing = this.objects.get(url);
      if (!existing) return new Response("Not found", { status: 404 });
      if (headers["if-match"] && existing.etag !== headers["if-match"]) return new Response("Precondition Failed", { status: 412 });
      this.objects.delete(url);
      return new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405 });
  }
}

function overlaps(ics: string, start: Date, end: Date): boolean {
  const vcal = parseICalendar(ics);
  const v = vcal.children.find((c) => c.name === "VEVENT");
  if (!v) return false;
  const ds = getProp(v, "DTSTART");
  if (!ds) return false;
  const s = parseICalDate(ds.value, ds.params, "UTC");
  const de = getProp(v, "DTEND");
  const e = de ? parseICalDate(de.value, de.params, "UTC") : undefined;
  const sMs = s.kind === "date" ? Date.UTC(s.year, s.month - 1, s.day) : s.date.getTime();
  const eMs = e ? (e.kind === "date" ? Date.UTC(e.year, e.month - 1, e.day) : e.date.getTime()) : sMs + 3_600_000;
  // Recurring: treat as overlapping if start is before range end (fake server keeps it simple)
  if (getProp(v, "RRULE")) return sMs < end.getTime();
  return sMs < end.getTime() && eMs > start.getTime();
}

function isoFromICal(v: string): Date {
  return new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function unesc(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function response(href: string, props: string): string {
  return `<D:response><D:href>${esc(href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multistatus(responses: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/">${responses.join("")}</D:multistatus>`;
}

function xml(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
