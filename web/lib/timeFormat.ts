// Local-time display (chart-and-tape-fix Req 1.13, 2.13, 3.16; design D7).
//
// DISPLAY ONLY. Every time in the system stays UTC epoch ms (engine, server, protocol, candle
// buckets); these helpers only choose how a moment is written for the viewer. With no `timeZone`
// the browser's own zone is used, so each viewer sees their own zone (IST in India, a US zone in
// the USA). Intl.DateTimeFormat applies the zone's rules for the instant itself, so DST changes
// are correct without shifting any data.
//
// `timeZone` and `locale` exist as a test seam: tests pin "Asia/Kolkata" or "America/New_York".

export interface TimeFormatOptions {
  /** IANA zone such as "America/New_York". Omitted: the browser's local zone. */
  readonly timeZone?: string;
  /** BCP 47 locale for names such as month and zone abbreviations. Omitted: the browser's. */
  readonly locale?: string;
}

/** Placeholders for an invalid time. */
export const CLOCK_PLACEHOLDER = "--:--:--";
export const TIME_PLACEHOLDER = "—";

/** Lightweight Charts `TickMarkType` values (Year, Month, DayOfMonth, Time, TimeWithSeconds). */
export const TICK_YEAR = 0;
export const TICK_MONTH = 1;
export const TICK_DAY_OF_MONTH = 2;
export const TICK_TIME = 3;
export const TICK_TIME_WITH_SECONDS = 4;

type FormatKind = "clock" | "chart" | "year" | "month" | "day" | "time" | "timeSeconds";

const FORMAT_OPTIONS: Readonly<Record<FormatKind, Intl.DateTimeFormatOptions>> = {
  clock: { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
  chart: {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  },
  year: { year: "numeric" },
  month: { month: "short" },
  day: { day: "numeric" },
  time: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  timeSeconds: { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
};

const cache = new Map<string, Intl.DateTimeFormat | null>();

/** Cached formatter per kind, zone, and locale; null when the zone or locale is invalid. */
function formatter(kind: FormatKind, opts: TimeFormatOptions | undefined): Intl.DateTimeFormat | null {
  const key = `${kind}|${opts?.timeZone ?? ""}|${opts?.locale ?? ""}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let made: Intl.DateTimeFormat | null;
  try {
    const options: Intl.DateTimeFormatOptions = { ...FORMAT_OPTIONS[kind] };
    if (opts?.timeZone !== undefined) options.timeZone = opts.timeZone;
    made = new Intl.DateTimeFormat(opts?.locale, options);
  } catch {
    made = null;
  }
  cache.set(key, made);
  return made;
}

function toDate(ms: number): Date | null {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** HH:MM:SS (24 hour) in the viewer's zone for ms since the epoch, or "--:--:--" when invalid. */
export function formatClock(ms: number, opts?: TimeFormatOptions): string {
  const date = toDate(ms);
  const fmt = formatter("clock", opts);
  if (date === null || fmt === null) return CLOCK_PLACEHOLDER;
  return fmt.format(date);
}

/**
 * Crosshair text for a chart time in whole seconds: `YYYY-MM-DD HH:MM ZONE`, for example
 * `2023-11-14 22:13 UTC` or `2023-11-15 03:43 GMT+5:30`. The numeric parts come from Intl in the
 * viewer's zone and are always in this order; only the zone name follows the locale.
 */
export function formatChartTime(seconds: number, opts?: TimeFormatOptions): string {
  const date = toDate(seconds * 1000);
  const fmt = formatter("chart", opts);
  if (date === null || fmt === null) return TIME_PLACEHOLDER;
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of fmt.formatToParts(date)) parts[part.type] = part.value;
  const { year, month, day, hour, minute, timeZoneName } = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return TIME_PLACEHOLDER;
  }
  const zone = timeZoneName === undefined ? "" : ` ${timeZoneName}`;
  return `${year}-${month}-${day} ${hour}:${minute}${zone}`;
}

/**
 * Time-axis label for a tick of the given type (Lightweight Charts `TickMarkType`): the year, the
 * short month name, the day of month, or the time of day, all in the viewer's zone.
 */
export function tickMarkLabel(seconds: number, tickType: number, opts?: TimeFormatOptions): string {
  const date = toDate(seconds * 1000);
  if (date === null) return TIME_PLACEHOLDER;
  let kind: FormatKind;
  switch (tickType) {
    case TICK_YEAR:
      kind = "year";
      break;
    case TICK_MONTH:
      kind = "month";
      break;
    case TICK_DAY_OF_MONTH:
      kind = "day";
      break;
    case TICK_TIME_WITH_SECONDS:
      kind = "timeSeconds";
      break;
    default:
      kind = "time";
  }
  const fmt = formatter(kind, opts);
  return fmt === null ? TIME_PLACEHOLDER : fmt.format(date);
}
