/**
 * CalDAV discovery: principal -> calendar-home-set -> calendars.
 *
 * iCloud specifics: PROPFIND on https://caldav.icloud.com/ with Depth: 0
 * returns current-user-principal (often on a pNN-caldav.icloud.com host);
 * the calendar home lives on that partition host. Never hardcode it.
 */

import { CalDavError } from "../errors.js";
import type { CalDavClient } from "./client.js";
import { NS, childOf, childrenOf, findAll, okProp, propfindBody, textOf, type XmlNode } from "./xml.js";

export interface CalendarInfo {
  /** Stable short id: last non-empty path segment of the calendar href */
  id: string;
  name: string;
  /** Absolute URL of the calendar collection (always ends with "/") */
  href: string;
  color?: string;
  readOnly: boolean;
  ctag?: string;
  /** Component types the collection accepts (VEVENT, VTODO...) */
  components: string[];
}

export function calendarIdFromHref(href: string): string {
  const parts = href.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] ?? "");
}

export async function discoverPrincipal(client: CalDavClient): Promise<string> {
  const { responses, url } = await client.propfind(client.serverUrl, propfindBody([{ ns: NS.DAV, local: "current-user-principal" }]), "0");
  for (const r of responses) {
    const prop = okProp(r);
    const cup = prop && childOf(prop, NS.DAV, "current-user-principal");
    const href = cup && textOf(childOf(cup, NS.DAV, "href"));
    if (href) return client.resolve(href, url);
  }
  throw new CalDavError("server_error", "Could not discover current-user-principal from the CalDAV server");
}

export async function discoverHomeSet(client: CalDavClient, principalUrl: string): Promise<string> {
  const { responses, url } = await client.propfind(principalUrl, propfindBody([{ ns: NS.CALDAV, local: "calendar-home-set" }]), "0");
  for (const r of responses) {
    const prop = okProp(r);
    const hs = prop && childOf(prop, NS.CALDAV, "calendar-home-set");
    const href = hs && textOf(childOf(hs, NS.DAV, "href"));
    if (href) return ensureTrailingSlash(client.resolve(href, url));
  }
  throw new CalDavError("server_error", "Could not discover calendar-home-set from the CalDAV server");
}

const CALENDAR_PROPS = [
  { ns: NS.DAV, local: "resourcetype" },
  { ns: NS.DAV, local: "displayname" },
  { ns: NS.DAV, local: "current-user-privilege-set" },
  { ns: NS.CALDAV, local: "supported-calendar-component-set" },
  { ns: NS.APPLE, local: "calendar-color" },
  { ns: NS.CS, local: "getctag" },
];

export async function listCalendars(client: CalDavClient, homeUrl: string): Promise<CalendarInfo[]> {
  const { responses, url: base } = await client.propfind(homeUrl, propfindBody(CALENDAR_PROPS), "1");
  const out: CalendarInfo[] = [];
  for (const r of responses) {
    const prop = okProp(r);
    if (!prop) continue;
    const rt = childOf(prop, NS.DAV, "resourcetype");
    if (!rt || !childOf(rt, NS.CALDAV, "calendar")) continue;
    const href = ensureTrailingSlash(client.resolve(r.href, base));
    const components = childrenOf(childOf(prop, NS.CALDAV, "supported-calendar-component-set") ?? emptyNode(), NS.CALDAV, "comp")
      .map((c) => c.attrs.name)
      .filter(Boolean);
    // Only surface collections that can hold events. iCloud reports
    // VEVENT for calendars and VTODO for reminder lists.
    if (components.length > 0 && !components.includes("VEVENT")) continue;
    const name = textOf(childOf(prop, NS.DAV, "displayname")) || calendarIdFromHref(href);
    const color = normalizeColor(textOf(childOf(prop, NS.APPLE, "calendar-color")));
    out.push({
      id: calendarIdFromHref(href),
      name,
      href,
      color,
      readOnly: !canWrite(childOf(prop, NS.DAV, "current-user-privilege-set")),
      ctag: textOf(childOf(prop, NS.CS, "getctag")) || undefined,
      components,
    });
  }
  return out;
}

function canWrite(privSet: XmlNode | undefined): boolean {
  // If the server did not report privileges, assume writable and let the
  // server reject with 403 on write.
  if (!privSet) return true;
  const privs = findAll(privSet, NS.DAV, "privilege");
  if (privs.length === 0) return true;
  return privs.some((p) => p.children.some((c) => c.ns === NS.DAV && (c.local === "write" || c.local === "write-content" || c.local === "all")));
}

function normalizeColor(c: string): string | undefined {
  if (!c) return undefined;
  // iCloud sends #RRGGBBAA; strip alpha for a conventional CSS hex.
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(c.trim());
  return m ? `#${m[1].toUpperCase()}` : c.trim();
}

function ensureTrailingSlash(u: string): string {
  return u.endsWith("/") ? u : u + "/";
}

function emptyNode(): XmlNode {
  return { ns: "", local: "", attrs: {}, children: [], text: "" };
}

// ---------------------------------------------------------------------------
// Session: caches discovery results for the lifetime of the plugin
// ---------------------------------------------------------------------------

export class Session {
  private homeUrl?: string;
  private calendars?: CalendarInfo[];
  private inflight?: Promise<CalendarInfo[]>;

  constructor(readonly client: CalDavClient) {}

  invalidate(): void {
    this.homeUrl = undefined;
    this.calendars = undefined;
    this.inflight = undefined;
  }

  async getCalendars(force = false): Promise<CalendarInfo[]> {
    if (!force && this.calendars) return this.calendars;
    if (!force && this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        if (!this.homeUrl || force) {
          const principal = await discoverPrincipal(this.client);
          this.homeUrl = await discoverHomeSet(this.client, principal);
        }
        this.calendars = await listCalendars(this.client, this.homeUrl);
        return this.calendars;
      } catch (e) {
        this.homeUrl = undefined;
        this.calendars = undefined;
        throw e;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  /**
   * Resolve a calendar by id or (case-insensitive) display name. Throws
   * not_found with the list of available names.
   */
  async resolveCalendar(idOrName: string): Promise<CalendarInfo> {
    const cals = await this.getCalendars();
    const needle = idOrName.trim().toLowerCase();
    const found =
      cals.find((c) => c.id.toLowerCase() === needle) ??
      cals.find((c) => c.name.toLowerCase() === needle) ??
      cals.find((c) => c.href.toLowerCase() === needle);
    if (!found) {
      throw new CalDavError(
        "not_found",
        `Calendar "${idOrName}" not found. Available: ${cals.map((c) => `${c.name} (${c.id})`).join(", ") || "none"}`,
        404,
      );
    }
    return found;
  }
}
