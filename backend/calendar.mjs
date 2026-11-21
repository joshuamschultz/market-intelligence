const NY_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const dayNumber = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const shiftDate = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

function dateOf(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function nthWeekday(year, month, dayOfWeek, ordinal) {
  const start = dateOf(year, month, 1);
  return shiftDate(start, (dayOfWeek - dayNumber(start) + 7) % 7 + 7 * (ordinal - 1));
}

function observed(date, saturday = true) {
  return dayNumber(date) === 0 ? shiftDate(date, 1) : dayNumber(date) === 6 && saturday ? shiftDate(date, -1) : date;
}

function easter(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const l = (32 + 2 * e + 2 * Math.floor(c / 4) - h - c % 4) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const value = h + l - 7 * m + 114;
  return dateOf(year, Math.floor(value / 31), value % 31 + 1);
}

const extraClosures = new Set([
  '2001-09-11', '2001-09-12', '2001-09-13', '2001-09-14', '2004-06-11',
  '2007-01-02', '2012-10-29', '2012-10-30', '2018-12-05', '2025-01-09',
]);
const annualClosures = new Map();

function holidays(year) {
  if (annualClosures.has(year)) return annualClosures.get(year);
  const endOfMay = dateOf(year, 5, 31);
  const calendar = new Set([
    observed(dateOf(year, 1, 1), false), nthWeekday(year, 2, 1, 3),
    shiftDate(easter(year), -2), shiftDate(endOfMay, -((dayNumber(endOfMay) + 6) % 7)),
    observed(dateOf(year, 7, 4)), nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4), observed(dateOf(year, 12, 25)),
  ]);
  if (year >= 1998) calendar.add(nthWeekday(year, 1, 1, 3));
  if (year >= 2022) calendar.add(observed(dateOf(year, 6, 19)));
  annualClosures.set(year, calendar);
  return calendar;
}

export function isMarketSession(date) {
  const day = dayNumber(date);
  return day > 0 && day < 6 && !extraClosures.has(date) && !holidays(Number(date.slice(0, 4))).has(date);
}

export function expectedSessions(start, end) {
  const sessions = [];
  for (let date = start; date <= end; date = shiftDate(date, 1)) {
    if (isMarketSession(date)) sessions.push(date);
  }
  return sessions;
}

export function weekEnd(date) {
  return shiftDate(date, (5 - dayNumber(date) + 7) % 7);
}

export function latestFinalizableSession(now = new Date(), after = '20:30') {
  const parts = Object.fromEntries(NY_TIME.formatToParts(now).map(({ type, value }) => [type, value]));
  let date = `${parts.year}-${parts.month}-${parts.day}`;
  if (`${parts.hour}:${parts.minute}` < after) date = shiftDate(date, -1);
  while (!isMarketSession(date)) date = shiftDate(date, -1);
  return date;
}
