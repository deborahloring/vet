// Daily review counters use the Pacific Time calendar day (America/Los_Angeles),
// resetting at local midnight and following daylight saving. They are not rolling
// 24-hour windows. Gemini's free-tier daily quota resets on the same boundary.

export const PACIFIC_TIME_ZONE = 'America/Los_Angeles';

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TIME_ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function localParts(instant: Date): LocalParts {
  const map: Record<string, number> = {};
  for (const p of parts.formatToParts(instant)) if (p.type !== 'literal') map[p.type] = Number(p.value);
  return { year: map['year']!, month: map['month']!, day: map['day']!, hour: map['hour']!, minute: map['minute']!, second: map['second']! };
}

/** Pacific wall-clock offset from UTC at an instant, in milliseconds (e.g. -8h in winter). */
function offsetMs(instant: Date): number {
  const p = localParts(instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The Pacific calendar day containing `now`, as YYYY-MM-DD. Used as the counter key. */
export function pacificDayKey(now: Date): string {
  const p = localParts(now);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The instant of the next 00:00 Pacific Time after `now` (when both counters reset). */
export function nextPacificMidnight(now: Date): Date {
  const p = localParts(now);
  const target = Date.UTC(p.year, p.month - 1, p.day + 1, 0, 0, 0); // next local date at 00:00, as if UTC
  let guess = target - offsetMs(new Date(target));
  guess = target - offsetMs(new Date(guess)); // second pass settles a daylight-saving change
  return new Date(guess);
}
