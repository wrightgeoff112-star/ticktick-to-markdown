/**
 * Reminder-trigger parsing for TickTick / 滴答 CSV exports.
 *
 * Ported from the sortday implementation, with the i18n label formatting and
 * the temporal-polyfill <-> internal-reminder conversions removed (those are
 * sortday-specific). We keep the ISO-8601 duration parsing, which is the part
 * that actually understands the export format.
 */

export type DidaReminderTriggerMode = "relative" | "day_clock" | "unknown";
export type DidaReminderParseStatus = "parsed" | "fallback_raw" | "invalid";

export interface DidaReminderRule {
  triggerRaw: string;
  triggerCanonical: string;
  triggerSeconds: number | null;
  triggerMode: DidaReminderTriggerMode;
  parseStatus: DidaReminderParseStatus;
}

type DurationParts = {
  sign: 1 | -1;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
};

const ISO_DURATION_REGEX =
  /^([+-])?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function parseIsoDurationParts(raw: string): DurationParts | null {
  const value = raw.trim();
  if (!value) return null;

  const match = value.match(ISO_DURATION_REGEX);
  if (!match) return null;

  const hasAnyDurationToken =
    match[2] !== undefined ||
    match[3] !== undefined ||
    match[4] !== undefined ||
    match[5] !== undefined;
  if (!hasAnyDurationToken) return null;

  const sign = match[1] === "-" ? -1 : 1;
  const days = Number.parseInt(match[2] ?? "0", 10);
  const hours = Number.parseInt(match[3] ?? "0", 10);
  const minutes = Number.parseInt(match[4] ?? "0", 10);
  const seconds = Number.parseInt(match[5] ?? "0", 10);

  if ([days, hours, minutes, seconds].some((n) => Number.isNaN(n))) {
    return null;
  }

  return { sign, days, hours, minutes, seconds };
}

function toSeconds(parts: DurationParts): number {
  const base =
    parts.days * 24 * 60 * 60 +
    parts.hours * 60 * 60 +
    parts.minutes * 60 +
    parts.seconds;
  if (base === 0) return 0;
  return base * parts.sign;
}

function normalizeReminderRaw(raw: string): string {
  return raw.replace(/\s+/g, "").trim().toUpperCase();
}

function inferMode(
  parts: DurationParts,
  isAllDay: boolean,
): DidaReminderTriggerMode {
  const isPositive = parts.sign === 1;
  const isDayClockPattern =
    isAllDay &&
    isPositive &&
    parts.days === 0 &&
    parts.hours > 0 &&
    parts.minutes === 0 &&
    parts.seconds === 0;

  if (isDayClockPattern) return "day_clock";
  return "relative";
}

export function parseDidaReminderRules(
  raw: string | undefined,
  options: { isAllDay: boolean },
): DidaReminderRule[] {
  const triggers = String(raw ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const parsedRules = triggers.map<DidaReminderRule>((triggerRaw) => {
    const triggerCanonical = `TRIGGER:${triggerRaw}`;
    const parsed = parseIsoDurationParts(triggerRaw);

    if (!parsed) {
      return {
        triggerRaw,
        triggerCanonical,
        triggerSeconds: null,
        triggerMode: "unknown",
        parseStatus: "fallback_raw",
      };
    }

    return {
      triggerRaw,
      triggerCanonical,
      triggerSeconds: toSeconds(parsed),
      triggerMode: inferMode(parsed, options.isAllDay),
      parseStatus: "parsed",
    };
  });

  return normalizeDidaReminderRules(parsedRules);
}

export function normalizeDidaReminderRules(
  rules: DidaReminderRule[] | null | undefined,
): DidaReminderRule[] {
  if (!rules || rules.length === 0) return [];
  const deduped: DidaReminderRule[] = [];
  const indexByKey = new Map<string, number>();
  for (const rule of rules) {
    const key = normalizeReminderRaw(rule.triggerRaw);
    if (!key) continue;
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, deduped.length);
      deduped.push(rule);
      continue;
    }

    const existing = deduped[existingIndex];
    if (!existing) continue;
    const shouldReplace =
      existing.parseStatus !== "parsed" && rule.parseStatus === "parsed";
    if (shouldReplace) {
      deduped[existingIndex] = rule;
    }
  }
  return deduped;
}
