import test from 'node:test';
import assert from 'node:assert/strict';
import { isWithinWorkingHours, pickMentor, dailyLoad, classesOnMentorLocalDay, MAX_CLASSES_PER_MENTOR_PER_DAY } from '../src/services/allocation.js';
import { localWallTimeToDate } from '../src/utils/time.js';

const ist = (local) => localWallTimeToDate(local, 'Asia/Kolkata');
const hour = (d) => new Date(d.getTime() + 60 * 60 * 1000);
const mentor = (id, start = '09:00', end = '21:00', workdays = [0, 1, 2, 3, 4, 5, 6]) =>
  ({ id, name: id, timezone: 'Asia/Kolkata', working_start: start, working_end: end, workdays });
const fits = (m, local) => { const s = ist(local); return isWithinWorkingHours(s, hour(s), m); };

test('day shift: a class must finish by the end of the shift', () => {
  const m = mentor('a');
  assert.equal(fits(m, '2026-10-20T09:00'), true);
  assert.equal(fits(m, '2026-10-20T20:00'), true);
  assert.equal(fits(m, '2026-10-20T20:30'), false);
  assert.equal(fits(m, '2026-10-20T08:00'), false);
});

test('overnight shift (17:00-03:00) works across midnight', () => {
  const m = mentor('b', '17:00', '03:00');
  assert.equal(fits(m, '2026-10-20T17:00'), true);
  assert.equal(fits(m, '2026-10-20T23:00'), true);
  assert.equal(fits(m, '2026-10-21T02:00'), true);
  assert.equal(fits(m, '2026-10-21T02:30'), false);
  assert.equal(fits(m, '2026-10-20T16:00'), false);
  assert.equal(fits(m, '2026-10-20T12:00'), false);
});

test('mentors only work on their configured weekdays', () => {
  const weekdaysOnly = mentor('c', '09:00', '21:00', [1, 2, 3, 4, 5]);
  assert.equal(fits(weekdaysOnly, '2026-10-19T10:00'), true);  // Monday
  assert.equal(fits(weekdaysOnly, '2026-10-18T10:00'), false); // Sunday
});

test('10 mentors x 2 classes: 20 parents succeed, the 21st gets no mentor', () => {
  const mentors = Array.from({ length: 10 }, (_, i) => mentor(`m${String(i + 1).padStart(2, '0')}`));
  const bookingsByMentor = new Map();
  const book = (local) => {
    const start = ist(local);
    const end = hour(start);
    const picked = pickMentor(mentors, bookingsByMentor, start, end);
    if (picked) bookingsByMentor.set(picked.id, [...(bookingsByMentor.get(picked.id) ?? []), { mentor_id: picked.id, start_at: start, end_at: end }]);
    return picked;
  };

  const firstTen = Array.from({ length: 10 }, () => book('2026-10-20T10:00'));
  assert.equal(new Set(firstTen.map(m => m.id)).size, 10, 'load is spread across all mentors, not piled on Mentor 01');

  const nextTen = Array.from({ length: 10 }, () => book('2026-10-20T11:00'));
  assert.ok(nextTen.every(Boolean));
  assert.equal(book('2026-10-20T12:00'), null, 'every mentor already has the daily maximum');
  for (const list of bookingsByMentor.values()) assert.equal(list.length, MAX_CLASSES_PER_MENTOR_PER_DAY);
});

test('a mentor cannot be double-booked for overlapping times', () => {
  const only = [mentor('solo')];
  const bookings = new Map();
  const start = ist('2026-10-20T10:00');
  bookings.set('solo', [{ mentor_id: 'solo', start_at: start, end_at: hour(start) }]);
  assert.equal(pickMentor(only, bookings, start, hour(start)), null);
  const later = ist('2026-10-20T11:00');
  assert.equal(pickMentor(only, bookings, later, hour(later)).id, 'solo');
});

test('the daily cap resets on the next mentor-local day', () => {
  const only = [mentor('solo')];
  const day1a = ist('2026-10-20T10:00'), day1b = ist('2026-10-20T12:00');
  const bookings = new Map([['solo', [day1a, day1b].map(s => ({ mentor_id: 'solo', start_at: s, end_at: hour(s) }))]]);
  const sameDay = ist('2026-10-20T15:00');
  const nextDay = ist('2026-10-21T10:00');
  assert.equal(pickMentor(only, bookings, sameDay, hour(sameDay)), null);
  assert.equal(pickMentor(only, bookings, nextDay, hour(nextDay)).id, 'solo');
});

// ---- regression: "a mentor was given more than 2 classes in a day" ----
const at = (local, zone) => localWallTimeToDate(local, zone);
const booked = (m, start, parentTimezone) => ({ mentor_id: m.id, start_at: start, end_at: hour(start), parent_timezone: parentTimezone });

test('a night-shift mentor cannot reach 3 classes on a UK parent\'s date, even across two Indian dates', () => {
  const night = mentor('night', '17:00', '03:00'); // IST
  // Both classes are on the Dublin date 13 Oct (7 PM and 8 PM) but on different IST dates (13th and 14th).
  const first = at('2026-10-13T19:00', 'Europe/Dublin');
  const second = at('2026-10-13T20:00', 'Europe/Dublin');
  const bookings = new Map([[night.id, [booked(night, first, 'Europe/Dublin'), booked(night, second, 'Europe/Dublin')]]]);
  const third = at('2026-10-13T21:00', 'Europe/Dublin'); // 01:30 IST on the 14th: only 1 class that IST day

  assert.equal(pickMentor([night], bookings, third, hour(third), 'Europe/Dublin'), null);
  // The old mentor-only count saw just 1 class that Indian day (so it would have accepted the booking: the bug).
  // The day-aware count sees 2 on the parent's date and refuses.
  const existing = bookings.get(night.id);
  assert.equal(classesOnMentorLocalDay(night, existing, third), 1);
  assert.equal(dailyLoad(night, existing, third, 'Europe/Dublin'), 2);
});

test('an earlier parent\'s day is protected too (their zone is checked, not just the new parent\'s)', () => {
  const m = mentor('m', '00:00', '23:59');
  const ny1 = at('2026-10-13T09:00', 'America/New_York');
  const ny2 = at('2026-10-13T10:00', 'America/New_York');
  const bookings = new Map([[m.id, [booked(m, ny1, 'America/New_York'), booked(m, ny2, 'America/New_York')]]]);
  // A UK parent picks 11:00 PM UK on the 13th = 6 PM New York on the 13th: same New York day, different UK day.
  const candidate = at('2026-10-13T23:00', 'Europe/London');
  assert.equal(pickMentor([m], bookings, candidate, hour(candidate), 'Europe/London'), null);
});

test('different days stay independent, so "try tomorrow" really works', () => {
  const m = mentor('m', '00:00', '23:59');
  const today = [at('2026-10-13T10:00', 'Europe/London'), at('2026-10-13T11:00', 'Europe/London')];
  const bookings = new Map([[m.id, today.map(s => booked(m, s, 'Europe/London'))]]);
  const tomorrow = at('2026-10-14T10:00', 'Europe/London');
  assert.equal(pickMentor([m], bookings, tomorrow, hour(tomorrow), 'Europe/London')?.id, 'm');
});
