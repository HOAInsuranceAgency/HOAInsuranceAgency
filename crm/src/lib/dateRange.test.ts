import { describe, expect, it } from 'vitest';
import { dateRangeError, dateRangePreset, reportToday } from './dateRange';

describe('financial report date ranges', () => {
  it('uses the New York agency day across UTC midnight and daylight saving time', () => {
    expect(reportToday(new Date('2026-01-01T02:00:00Z'))).toBe('2025-12-31');
    expect(reportToday(new Date('2026-07-01T03:59:59Z'))).toBe('2026-06-30');
    expect(reportToday(new Date('2026-07-01T04:00:00Z'))).toBe('2026-07-01');
  });

  it('clamps a leap day to the last real day of February in the prior year', () => {
    expect(dateRangePreset('12mo', '2024-02-29')).toEqual({ from: '2023-02-28', to: '2024-02-29' });
    expect(dateRangePreset('12mo', '2025-03-31')).toEqual({ from: '2024-03-31', to: '2025-03-31' });
    expect(dateRangePreset('ytd', '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-01-01' });
    expect(dateRangePreset('all')).toEqual({ from: '', to: '' });
  });

  it('allows open bounds only for reports that support them', () => {
    expect(dateRangeError({ from: '', to: '2026-01-01' })).toBeTruthy();
    expect(dateRangeError({ from: '', to: '2026-01-01' }, { allowOpenEnded: true })).toBe('');
    expect(dateRangeError({ from: '2026-01-01', to: '' }, { allowOpenEnded: true })).toBe('');
    expect(dateRangeError({ from: '', to: '' }, { allowOpenEnded: true })).toBe('');
  });

  it.each(['2026-02-29', '2026-13-01', '0000-01-01', '2026-1-01'])('rejects a non-calendar date %s before loading a report', date => {
    expect(dateRangeError({ from: date, to: '2026-12-31' })).toBe('Choose a valid start and end date.');
  });
});
