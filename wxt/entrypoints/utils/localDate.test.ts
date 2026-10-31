// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isLegacyToday, localDateId } from './localDate';

describe('localDateId', () => {
  it('uses the local calendar day, zero-padded, independent of locale formatting', () => {
    // Month is 0-based. 2026-03-07 local, whatever the UI language spells that as.
    expect(localDateId(new Date(2026, 2, 7, 23, 59))).toBe('2026-03-07');
  });

  it('rolls over at local midnight, not at a fixed UTC offset', () => {
    expect(localDateId(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
    expect(localDateId(new Date(2025, 11, 31, 23, 55))).toBe('2025-12-31');
  });

  it('reads the calendar day of the Date it is given, so a zone shift changes it', () => {
    // 2026-06-15 02:30 UTC is 2026-06-14 in a UTC-12 zone and 2026-06-15 in a
    // UTC+14 zone. The id is taken from the Date's local fields, which is what
    // a machine whose clock sits in one of those zones would produce.
    const instant = new Date('2026-06-15T02:30:00Z');
    const asUtcMinus12 = new Date(instant.toLocaleString('en-US', { timeZone: 'Etc/GMT+12' }));
    const asUtcPlus14 = new Date(instant.toLocaleString('en-US', { timeZone: 'Pacific/Kiritimati' }));
    expect(localDateId(asUtcMinus12)).toBe('2026-06-14');
    expect(localDateId(asUtcPlus14)).toBe('2026-06-15');
  });
});

describe('isLegacyToday', () => {
  it('matches only the current locale rendering of today', () => {
    const now = new Date(2026, 5, 15, 12);
    expect(isLegacyToday(now.toLocaleDateString(), now)).toBe(true);
  });

  it('rejects another day, a stable id, and non-strings', () => {
    const now = new Date(2026, 5, 15, 12);
    expect(isLegacyToday(new Date(2026, 5, 14).toLocaleDateString(), now)).toBe(false);
    expect(isLegacyToday('2026-06-15', now)).toBe(false);
    expect(isLegacyToday(null, now)).toBe(false);
  });
});
