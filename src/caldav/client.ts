/**
 * Thin CalDAV HTTP client over global fetch.
 *
 * - HTTP Basic auth (Apple ID + app-specific password) over TLS
 * - Manual redirect following so the Authorization header survives the
 *   caldav.icloud.com -> pNN-caldav.icloud.com hop (fetch strips auth on
 *   cross-origin redirects when following automatically)
 * - One retry on 5xx / network failure
 * - Maps HTTP status to typed CalDavError codes; never echoes credentials
 */

import { CalDavError } from "../errors.js";
import { parseMultiStatus, type MultiStatusResponse } from "./xml.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  serverUrl: string;
  username: string;
  password: string;
  fetch?: FetchLike;
  /** Milliseconds; default 30s */
  timeoutMs?: number;
  userAgent?: string;
}

export interface DavResponse {
  status: number;
  headers: Headers;
  text: string;
  /** Final URL after redirects */
  url: string;
}

const MAX_REDIRECTS = 5;

/**
 * Registrable-domain heuristic: the last two labels, or three for
 * two-part public suffixes such as .com.cn / .co.uk.
 */
export function baseDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split(".");
  if (parts.length <= 2) return parts.join(".");
  const tld2 = parts.slice(-2).join(".");
  if (/^(com|co|org|net|gov|edu|ac)\.[a-z]{2}$/.test(tld2)) return parts.slice(-3).join(".");
  return tld2;
}

export class CalDavClient {
  readonly serverUrl: string;
  /** Credentials are only ever sent to hosts within this registrable domain (from serverUrl). */
  readonly trustedDomain: string;
  private readonly authHeader: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(opts: ClientOptions) {
    const url = new URL(opts.serverUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new CalDavError("invalid_input", "serverUrl must use https (credentials are sent with HTTP Basic auth)");
    }
    this.serverUrl = url.toString();
    this.trustedDomain = baseDomain(url.hostname);
    this.authHeader = "Basic " + Buffer.from(`${opts.username}:${opts.password}`, "utf8").toString("base64");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.userAgent = opts.userAgent ?? "openclaw-icloud-calendar/0.1";
  }

  /** True if credentials may be sent to this URL (same registrable domain as serverUrl, https). */
  isTrustedUrl(url: string): boolean {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && !(u.hostname === "localhost" || u.hostname === "127.0.0.1")) return false;
      const host = u.hostname.toLowerCase();
      return host === this.trustedDomain || host.endsWith("." + this.trustedDomain);
    } catch {
      return false;
    }
  }

  /** Resolve a possibly-relative href against the server or a base URL. */
  resolve(href: string, base?: string): string {
    return new URL(href, base ?? this.serverUrl).toString();
  }

  async request(
    method: string,
    url: string,
    opts: { headers?: Record<string, string>; body?: string; depth?: "0" | "1" | "infinity" } = {},
  ): Promise<DavResponse> {
    let current = url;
    let attempt = 0;
    let redirects = 0;
    if (!this.isTrustedUrl(current)) {
      throw new CalDavError("server_error", `Refusing to send credentials to untrusted host ${safeHost(current)} (trusted: *.${this.trustedDomain})`);
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const headers: Record<string, string> = {
        Authorization: this.authHeader,
        "User-Agent": this.userAgent,
        Accept: "*/*",
        ...(opts.depth !== undefined ? { Depth: opts.depth } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/xml; charset=utf-8" } : {}),
        ...(opts.headers ?? {}),
      };
      let res: Response;
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.timeoutMs);
        try {
          res = await this.fetchImpl(current, {
            method,
            headers,
            body: opts.body,
            redirect: "manual",
            signal: ac.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        if (attempt === 0) {
          attempt++;
          await sleep(500);
          continue;
        }
        throw new CalDavError("server_error", `Network error talking to CalDAV server: ${describe(e)}`);
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc || redirects >= MAX_REDIRECTS) {
          throw new CalDavError("server_error", `Too many redirects or missing Location (status ${res.status})`, res.status);
        }
        redirects++;
        const next = new URL(loc, current).toString();
        if (!this.isTrustedUrl(next)) {
          throw new CalDavError("server_error", `Refusing to follow redirect to untrusted host ${safeHost(next)} (trusted: *.${this.trustedDomain})`);
        }
        current = next;
        continue;
      }

      if (res.status >= 500 && attempt === 0) {
        attempt++;
        await sleep(500);
        continue;
      }

      const text = await res.text();
      this.throwForStatus(res.status, method, current, text);
      return { status: res.status, headers: res.headers, text, url: current };
    }
  }

  private throwForStatus(status: number, method: string, url: string, body: string): void {
    if (status < 400) return;
    const path = safePath(url);
    switch (status) {
      case 401:
      case 403:
        throw new CalDavError(
          "auth_failed",
          "Authentication failed (HTTP " + status + "). Check the Apple ID and make sure you are using an app-specific password from appleid.apple.com, not your Apple Account password.",
          status,
        );
      case 404:
        throw new CalDavError("not_found", `${method} ${path}: not found`, status);
      case 412:
        throw new CalDavError("conflict", `${method} ${path}: precondition failed (the event changed on the server)`, status);
      case 423:
        throw new CalDavError("conflict", `${method} ${path}: resource is locked`, status);
      default:
        throw new CalDavError(
          "server_error",
          `${method} ${path}: HTTP ${status}${body ? " " + body.slice(0, 200).replace(/\s+/g, " ") : ""}`,
          status,
        );
    }
  }

  /** PROPFIND; `url` in the result is the final URL after redirects (resolve relative hrefs against it). */
  async propfind(url: string, body: string, depth: "0" | "1"): Promise<{ responses: MultiStatusResponse[]; url: string }> {
    const res = await this.request("PROPFIND", url, { body, depth });
    return { responses: parseMultiStatus(res.text), url: res.url };
  }

  async report(url: string, body: string, depth: "0" | "1" = "1"): Promise<MultiStatusResponse[]> {
    const res = await this.request("REPORT", url, { body, depth });
    return parseMultiStatus(res.text);
  }

  async get(url: string): Promise<{ text: string; etag?: string }> {
    const res = await this.request("GET", url, { headers: { Accept: "text/calendar" } });
    return { text: res.text, etag: res.headers.get("etag") ?? undefined };
  }

  async put(url: string, ics: string, cond: { ifMatch?: string; ifNoneMatch?: "*" }): Promise<{ etag?: string }> {
    const headers: Record<string, string> = { "Content-Type": "text/calendar; charset=utf-8" };
    if (cond.ifMatch) headers["If-Match"] = cond.ifMatch;
    if (cond.ifNoneMatch) headers["If-None-Match"] = cond.ifNoneMatch;
    const res = await this.request("PUT", url, { headers, body: ics });
    return { etag: res.headers.get("etag") ?? undefined };
  }

  async delete(url: string, cond: { ifMatch?: string } = {}): Promise<void> {
    const headers: Record<string, string> = {};
    if (cond.ifMatch) headers["If-Match"] = cond.ifMatch;
    await this.request("DELETE", url, { headers });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.name === "AbortError" ? "timeout" : e.message;
  return String(e);
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "<invalid-url>";
  }
}

/** Path only, so error messages never include a userinfo component. */
function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return "<url>";
  }
}
