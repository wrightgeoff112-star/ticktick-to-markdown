/**
 * Recurrence (repeat-rule) parsing.
 *
 * The sortday original delegated to an internal `@repo/providers` RRULE engine
 * to produce a fully-typed `Recurrence` object. That engine is not part of this
 * standalone tool, so we keep the raw + canonical RRULE string (lossless) and
 * additionally do a light, dependency-free structured parse of the most common
 * RRULE fields. Downstream consumers that need the full rule should read
 * `raw` / `canonical`; `parsed` is a best-effort convenience.
 */

export type DidaRepeatParseStatus = "parsed" | "fallback_raw" | "invalid";

export interface ParsedRRule {
  freq?: string;
  interval?: number;
  byDay?: string[];
  byMonthDay?: number[];
  byMonth?: number[];
  count?: number;
  until?: string;
  weekStart?: string;
}

export interface DidaRepeatParsedResult {
  raw: string;
  canonical: string;
  parseStatus: DidaRepeatParseStatus;
  parsed: ParsedRRule | null;
}

export function normalizeDidaRepeatRule(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  return value.startsWith("RRULE:") ? value : `RRULE:${value}`;
}

const KNOWN_FREQ = new Set([
  "SECONDLY",
  "MINUTELY",
  "HOURLY",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
]);

function parseIntList(value: string): number[] {
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * Best-effort structured parse of an RRULE body. Returns null when no FREQ is
 * present (which we treat as "not a real recurrence rule").
 */
function parseRRuleBody(canonical: string): ParsedRRule | null {
  const body = canonical.replace(/^RRULE:/, "");
  const parts = body
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);

  const out: ParsedRRule = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).toUpperCase();
    const value = part.slice(eq + 1).trim();
    if (!value) continue;

    switch (key) {
      case "FREQ":
        out.freq = value.toUpperCase();
        break;
      case "INTERVAL": {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) out.interval = n;
        break;
      }
      case "BYDAY":
        out.byDay = value.split(",").map((s) => s.trim().toUpperCase());
        break;
      case "BYMONTHDAY":
        out.byMonthDay = parseIntList(value);
        break;
      case "BYMONTH":
        out.byMonth = parseIntList(value);
        break;
      case "COUNT": {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) out.count = n;
        break;
      }
      case "UNTIL":
        out.until = value;
        break;
      case "WKST":
        out.weekStart = value.toUpperCase();
        break;
      default:
        break;
    }
  }

  if (!out.freq || !KNOWN_FREQ.has(out.freq)) {
    return null;
  }
  return out;
}

export function parseDidaRepeatRule(raw: string): DidaRepeatParsedResult {
  const canonical = normalizeDidaRepeatRule(raw);

  if (!canonical) {
    return { raw, canonical, parseStatus: "invalid", parsed: null };
  }

  const parsed = parseRRuleBody(canonical);
  if (parsed) {
    return { raw, canonical, parseStatus: "parsed", parsed };
  }

  // We kept the raw rule but could not structure it.
  return { raw, canonical, parseStatus: "fallback_raw", parsed: null };
}
