import { describe, expect, it } from 'vitest';
import { arrivalDateOf, calendarDateKey, calendarMonthCells, createEmptyItem, shiftCalendarMonth } from '@ea/shared';

const now = new Date('2026-10-19T12:00:00Z');
const parcel = (eta: string, latestTime = '2026-10-18 12:00') => createEmptyItem({ mailNo: '123456', source: 'jd', eta, latestTime, state: 0 });

describe('arrival calendar', () => {
  it('anchors relative ETA to the record date instead of moving with today', () => {
    expect(arrivalDateOf(parcel('明天送达'), now)).toBe('2026-10-19');
    expect(arrivalDateOf(parcel('明天送达'), new Date('2026-10-23'))).toBe('2026-10-19');
  });
  it('handles year boundaries and leap days', () => {
    expect(arrivalDateOf(parcel('1月2日送达', '2026-12-31'), now)).toBe('2027-01-02');
    expect(arrivalDateOf(parcel('明天送达', '2028-02-28'), now)).toBe('2028-02-29');
    expect(arrivalDateOf(parcel('2026-02-29送达'), now)).toBeNull();
  });
  it('excludes completed items and shipping dates', () => {
    expect(arrivalDateOf({ ...parcel('今天送达'), state: 3, stateNum: 107 }, now)).toBeNull();
    expect(arrivalDateOf(parcel('10月20日前发货'), now)).toBeNull();
  });
  it('uses the configured timezone for ISO timestamps', () => {
    expect(calendarDateKey(new Date('2026-10-18T20:00:00Z'))).toBe('2026-10-19');
    expect(arrivalDateOf(parcel('明天送达', '2026-10-18T20:00:00Z'), now)).toBe('2026-10-20');
  });
  it('keeps the calendar usable if a stored timezone is invalid', () => {
    expect(calendarDateKey(now, 'invalid-timezone')).toBe('2026-10-19');
    expect(calendarDateKey(new Date('invalid'))).toBe('');
  });
  it('falls back from an unavailable AI ETA to the platform ETA', () => {
    expect(arrivalDateOf({ ...parcel('10月20日送达'), aiEta: '暂无预计时间' }, now)).toBe('2026-10-20');
  });
  it('renders a complete month with Monday first and navigates across years', () => {
    const cells = calendarMonthCells('2028-02');
    expect(cells[0]).toBeNull();
    expect(cells[1]).toBe('2028-02-01');
    expect(cells.filter(Boolean)).toHaveLength(29);
    expect(cells.length % 7).toBe(0);
    expect(shiftCalendarMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftCalendarMonth('2027-01', -1)).toBe('2026-12');
  });
});
