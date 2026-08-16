/**
 * iCalendar (RFC 5545) component tree: parse and serialize while preserving
 * properties and sub-components we do not understand.
 */

export interface Property {
  name: string; // upper-case
  params: Record<string, string>; // upper-case keys, raw values (quotes stripped)
  value: string; // raw (still escaped for TEXT values)
}

export interface Component {
  name: string; // VCALENDAR, VEVENT, VALARM, VTIMEZONE...
  props: Property[];
  children: Component[];
}

/** Unfold folded lines (CRLF or LF followed by space/tab). */
export function unfold(ics: string): string[] {
  return ics
    .replace(/\r\n[ \t]|\n[ \t]|\r[ \t]/g, "")
    .split(/\r\n|\n|\r/)
    .filter((l) => l.length > 0);
}

function parseContentLine(line: string): Property {
  // NAME(;PARAM=VALUE)*:VALUE with quoted param values possibly containing ':' or ';'
  let i = 0;
  let quote = false;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') quote = !quote;
    else if (c === ":" && !quote) break;
    i++;
  }
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts: string[] = [];
  let cur = "";
  quote = false;
  for (const c of head) {
    if (c === '"') {
      quote = !quote;
      cur += c;
    } else if (c === ";" && !quote) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const k = p.slice(0, eq).toUpperCase();
    let v = p.slice(eq + 1);
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { name, params, value };
}

export function parseICalendar(ics: string): Component {
  const lines = unfold(ics);
  const root: Component = { name: "#ROOT", props: [], children: [] };
  const stack: Component[] = [root];
  for (const line of lines) {
    const prop = parseContentLine(line);
    if (prop.name === "BEGIN") {
      const c: Component = { name: prop.value.trim().toUpperCase(), props: [], children: [] };
      stack[stack.length - 1].children.push(c);
      stack.push(c);
    } else if (prop.name === "END") {
      if (stack.length > 1) stack.pop();
    } else {
      stack[stack.length - 1].props.push(prop);
    }
  }
  const vcal = root.children.find((c) => c.name === "VCALENDAR");
  if (!vcal) throw new Error("Not an iCalendar document (missing VCALENDAR)");
  return vcal;
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/** Fold a content line at 75 octets (RFC 5545 §3.1). */
export function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    const limit = first ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);
    // Do not split a multi-byte UTF-8 sequence: back off continuation bytes.
    while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
    out.push((first ? "" : " ") + bytes.subarray(start, end).toString("utf8"));
    start = end;
    first = false;
  }
  return out.join("\r\n");
}

function needsQuoting(v: string): boolean {
  return /[;:,]/.test(v);
}

export function serializeProperty(p: Property): string {
  let line = p.name;
  for (const [k, v] of Object.entries(p.params)) {
    line += `;${k}=${needsQuoting(v) ? `"${v}"` : v}`;
  }
  line += `:${p.value}`;
  return fold(line);
}

export function serializeComponent(c: Component): string {
  const lines: string[] = [`BEGIN:${c.name}`];
  for (const p of c.props) lines.push(serializeProperty(p));
  for (const ch of c.children) lines.push(serializeComponent(ch));
  lines.push(`END:${c.name}`);
  return lines.join("\r\n");
}

export function serializeICalendar(vcal: Component): string {
  return serializeComponent(vcal) + "\r\n";
}

// ---------------------------------------------------------------------------
// Property helpers
// ---------------------------------------------------------------------------

export function getProp(c: Component, name: string): Property | undefined {
  return c.props.find((p) => p.name === name);
}

export function getProps(c: Component, name: string): Property[] {
  return c.props.filter((p) => p.name === name);
}

export function setProp(c: Component, name: string, value: string, params: Record<string, string> = {}): void {
  const idx = c.props.findIndex((p) => p.name === name);
  const prop: Property = { name, params, value };
  if (idx === -1) c.props.push(prop);
  else c.props[idx] = prop;
}

export function removeProp(c: Component, name: string): void {
  c.props = c.props.filter((p) => p.name !== name);
}

/** Escape a TEXT value (RFC 5545 §3.3.11). */
export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

export function unescapeText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}
