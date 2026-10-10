// Pure allocation rules: no database access, so they are easy to unit-test.
import { dateAtZone, timeAtZone, weekdayAtZone } from '../utils/time.js';

export const MAX_CLASSES_PER_MENTOR_PER_DAY = 2;

const MINUTES_PER_DAY = 1440;
const toMinutes = (time) => {
  const [h, m] = String(time).split(':');
  return Number(h) * 60 + Number(m);
};

// A shift may cross midnight (e.g. 17:00-03:00 in the mentor's own zone), which is how
// mentors in India cover US evenings. We measure "minutes since the shift began".
export function isWithinWorkingHours(startAt, endAt, mentor) {
  if (!mentor.workdays.includes(weekdayAtZone(startAt, mentor.timezone))) return false;
  const shiftStart = toMinutes(mentor.working_start);
  const shiftEnd = toMinutes(mentor.working_end);
  const shiftLength = ((shiftEnd - shiftStart + MINUTES_PER_DAY) % MINUTES_PER_DAY) || MINUTES_PER_DAY;
  const sinceShiftStart =
    (toMinutes(timeAtZone(startAt, mentor.timezone)) - shiftStart + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const classLength = (endAt.getTime() - startAt.getTime()) / 60000;
  return sinceShiftStart + classLength <= shiftLength;
}

// Classes this mentor has on the same calendar date as `instant`, as seen in `zone`.
export function classesOnDay(bookings, instant, zone) {
  const day = dateAtZone(instant, zone);
  return bookings.filter(b => dateAtZone(b.start_at, zone) === day).length;
}

// "A day" depends on who is looking, and a limit of 2 must hold for every one of them:
//  - the mentor's own calendar day (the mentor in India: 2 classes per day), and
//  - the calendar date the parent is booking on in the parent's zone (a UK parent's "today" spans
//    two Indian dates, so the mentor-only rule alone let a mentor reach 4 classes on one parent date), and
//  - the date seen by each parent who already booked this mentor, so their day stays within 2 as well.
// The result is the busiest of those views.
export function dailyLoad(mentor, bookings, instant, parentTimezone) {
  const views = new Set([mentor.timezone, parentTimezone, ...bookings.map(b => b.parent_timezone)].filter(Boolean));
  let load = 0;
  for (const zone of views) load = Math.max(load, classesOnDay(bookings, instant, zone));
  return load;
}

// Kept for callers/tests that only care about the mentor's own day.
export const classesOnMentorLocalDay = (mentor, bookings, instant) => classesOnDay(bookings, instant, mentor.timezone);

export function overlaps(bookings, startAt, endAt) {
  return bookings.some(b => b.start_at < endAt && b.end_at > startAt);
}

export function groupByMentor(bookingRows) {
  const map = new Map();
  for (const row of bookingRows) {
    if (!map.has(row.mentor_id)) map.set(row.mentor_id, []);
    map.get(row.mentor_id).push(row);
  }
  return map;
}

// Picks the eligible mentor with the fewest classes that day (ties: first by name),
// so work is spread evenly instead of always filling Mentor 01 first.
// `parentTimezone` is the zone of the parent who is booking (their date decides "that day").
export function pickMentor(mentors, bookingsByMentor, startAt, endAt, parentTimezone) {
  let best = null;
  let bestLoad = Infinity;
  for (const mentor of mentors) {
    const bookings = bookingsByMentor.get(mentor.id) ?? [];
    if (!isWithinWorkingHours(startAt, endAt, mentor)) continue;
    const load = dailyLoad(mentor, bookings, startAt, parentTimezone);
    if (load >= MAX_CLASSES_PER_MENTOR_PER_DAY) continue;
    if (overlaps(bookings, startAt, endAt)) continue;
    if (load < bestLoad) { best = mentor; bestLoad = load; }
  }
  return best;
}
