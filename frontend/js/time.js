// Deadline handling: "2026-10-12 23:59 in Cairo" -> an exact moment, whatever this computer's time zone is.

export const CAIRO_TIME_ZONE = "Africa/Cairo";
export const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** How far ahead of UTC the zone's wall clock is at the given moment, in ms (DST-aware). */
function zoneOffsetMs(utcMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(utcMs))
      .map(({ type, value }) => [type, Number(value)]),
  );
  const wallClockAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallClockAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The moment when the wall clock in `timeZone` shows `date` ("YYYY-MM-DD") `time` ("HH:MM").
 * Returns null when the date is empty or malformed.
 */
export function deadlineInstant(date, time, timeZone) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  if (!dateMatch) return null;
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time || "23:59");
  if (!timeMatch) return null;
  const [year, month, day] = dateMatch.slice(1).map(Number);
  const [hour, minute] = timeMatch.slice(1).map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the offset correctly around daylight-saving changes.
  let instant = asUtc - zoneOffsetMs(asUtc, timeZone);
  instant = asUtc - zoneOffsetMs(instant, timeZone);
  return new Date(instant);
}

export function formatInZone(moment, timeZone) {
  return new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: "medium", timeStyle: "short" }).format(moment);
}
