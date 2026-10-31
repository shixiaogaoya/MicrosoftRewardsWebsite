import { describe, expect, it } from 'vitest';
import { DEFAULTS, clampSetting, parseSettingInput } from './settings';

describe('parseSettingInput', () => {
  it('accepts an integer inside each range, including the documented zeros', () => {
    expect(parseSettingInput('searches', '1')).toBe(1);
    expect(parseSettingInput('searches', '999')).toBe(999);
    expect(parseSettingInput('timeout', '0')).toBe(0);
    expect(parseSettingInput('timeout', '5')).toBe(5);
    expect(parseSettingInput('closeTime', '0')).toBe(0);
    expect(parseSettingInput('closeTime', '300')).toBe(300);
  });

  it('rejects a blank, a decimal, a negative and an out-of-range value', () => {
    expect(parseSettingInput('searches', '')).toBeNull();
    expect(parseSettingInput('searches', '  ')).toBeNull();
    expect(parseSettingInput('timeout', '1.5')).toBeNull();
    expect(parseSettingInput('timeout', '-1')).toBeNull();
    expect(parseSettingInput('searches', '0')).toBeNull();
    expect(parseSettingInput('searches', '1000')).toBeNull();
    expect(parseSettingInput('timeout', '10000')).toBeNull();
    expect(parseSettingInput('closeTime', '301')).toBeNull();
    expect(parseSettingInput('searches', 'abc')).toBeNull();
  });
});

describe('clampSetting', () => {
  it('keeps a valid short gap instead of rewriting it', () => {
    expect(clampSetting('timeout', 0)).toBe(0);
    expect(clampSetting('timeout', 5)).toBe(5);
    expect(clampSetting('closeTime', 0)).toBe(0);
  });

  it('replaces a missing or invalid stored value with that field default', () => {
    expect(clampSetting('searches', null)).toBe(DEFAULTS.searches);
    expect(clampSetting('searches', Number.NaN)).toBe(DEFAULTS.searches);
    expect(clampSetting('searches', 1.5)).toBe(DEFAULTS.searches);
    expect(clampSetting('searches', -3)).toBe(DEFAULTS.searches);
    expect(clampSetting('searches', 5000)).toBe(DEFAULTS.searches);
    expect(clampSetting('timeout', '5')).toBe(DEFAULTS.timeout);
    expect(clampSetting('closeTime', 9999)).toBe(DEFAULTS.closeTime);
  });
});
