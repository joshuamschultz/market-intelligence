import { segment } from './ui.js';

const periods = [
  [21, '1M', 5, 1],
  [63, '3M', 13, 3],
  [126, '6M', 26, 6],
  [252, '1Y', 52, 12],
  [1260, '5Y', 260, 60],
];

export const chartRanges = periods.map(([sessions, label]) => [sessions, label]);
export const longestChartRange = periods.at(-1)[0];

export function rangeLimit(sessions, cadence = 'daily') {
  const period = periods.find(([duration]) => duration === Number(sessions));
  if (cadence === 'weekly') return period?.[2] ?? Math.ceil(Number(sessions) * 52 / 252);
  if (cadence === 'monthly') return period?.[3] ?? Math.ceil(Number(sessions) / 21);
  return Number(sessions);
}

export function rangeSegment(action, sessions) {
  return segment(action, chartRanges, sessions);
}
