/**
 * Plugin configuration and secret resolution.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CalDavError } from "./errors.js";
import { isValidTimeZone } from "./ical/tz.js";

export interface SecretRef {
  source: "env" | "file";
  provider: string;
  id: string;
}

export interface RawPluginConfig {
  appleId?: string;
  appPassword?: string | SecretRef;
  timezone?: string;
  serverUrl?: string;
  calendars?: string[];
  readOnly?: boolean;
}

export interface ResolvedConfig {
  appleId: string;
  appPassword: string;
  timezone: string;
  serverUrl: string;
  calendars: string[];
  readOnly: boolean;
}

export const DEFAULT_SERVER_URL = "https://caldav.icloud.com";

export function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === "object" && value !== null && "source" in value && "provider" in value && "id" in value;
}

/** RFC 6901 JSON pointer lookup. */
export function jsonPointer(doc: unknown, pointer: string): unknown {
  if (!pointer) return doc;
  const parts = pointer
    .replace(/^\//, "")
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function resolveSecretRef(ref: SecretRef, secretsPath = join(homedir(), ".openclaw", "secrets.json")): string | undefined {
  switch (ref.source) {
    case "env":
      return process.env[ref.id] || undefined;
    case "file": {
      if (ref.provider !== "secrets") return undefined;
      if (!existsSync(secretsPath)) return undefined;
      try {
        const doc = JSON.parse(readFileSync(secretsPath, "utf8"));
        const v = jsonPointer(doc, ref.id);
        return typeof v === "string" && v ? v : undefined;
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** Expand a single "${VAR}" reference; plain strings pass through. */
function expandEnv(value: string): string {
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
  return m ? process.env[m[1]] ?? "" : value;
}

function resolveSecretValue(value: string | SecretRef | undefined, envFallback: string): string | undefined {
  if (isSecretRef(value)) {
    const r = resolveSecretRef(value);
    if (r) return r;
  } else if (typeof value === "string" && value.trim()) {
    const v = expandEnv(value);
    if (v) return v;
  }
  return process.env[envFallback] || undefined;
}

export function resolveConfig(raw: RawPluginConfig | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const appleId = (typeof raw?.appleId === "string" && expandEnv(raw.appleId)) || env.ICLOUD_APPLE_ID || "";
  const appPassword = resolveSecretValue(raw?.appPassword, "ICLOUD_APP_PASSWORD") ?? "";
  if (!appleId) throw new CalDavError("not_configured", "appleId is not configured (set plugin config appleId or ICLOUD_APPLE_ID)");
  if (!appPassword) throw new CalDavError("not_configured", "appPassword is not configured (set plugin config appPassword, a SecretRef, or ICLOUD_APP_PASSWORD)");

  let timezone: string;
  if (raw?.timezone?.trim()) {
    timezone = raw.timezone.trim();
    if (!isValidTimeZone(timezone)) throw new CalDavError("not_configured", `timezone "${timezone}" is not a valid IANA time zone`);
  } else {
    timezone = [env.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC"].find((t): t is string => !!t && isValidTimeZone(t)) ?? "UTC";
  }

  const serverUrl = raw?.serverUrl?.trim() || DEFAULT_SERVER_URL;
  try {
    new URL(serverUrl);
  } catch {
    throw new CalDavError("not_configured", `serverUrl "${serverUrl}" is not a valid URL`);
  }

  const calendars = Array.isArray(raw?.calendars) ? raw!.calendars.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim()) : [];
  return { appleId, appPassword, timezone, serverUrl, calendars, readOnly: raw?.readOnly === true };
}
