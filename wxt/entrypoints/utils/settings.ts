// Single source of truth for setting defaults, used by install seeding,
// background reads (fallbacks), and the popup's useStorage defaults.
export const DEFAULTS = {
    active: true,
    autoDaily: true,
    accountLevel: 'member',
    timeout: 60,
    searches: 5,
    closeTime: 5,
    // When on, each search tab opens its first organic result after a short
    // random delay (without stealing focus); otherwise the tab just loads the SERP.
    // Off by default: navigating off the results page risks the search not being
    // credited, so this stays opt-in.
    openFirstResult: false,
    // When on, the dashboard run also presses "Ready to claim" and confirms in
    // the flyout it opens. Off by default: it clicks through a real transaction
    // on the account, so existing users opt in rather than being enrolled by an
    // update — and with "Daily set" off it is what makes the dashboard tab open
    // at all, which briefly takes focus.
    claimPoints: false,
    // Whether startup and the daily alarm may start a round on their own.
    // Independent of the three task toggles: those say which tasks a round runs,
    // this says whether a round starts without the user pressing the button.
    // A new install keeps the old behaviour, which was "on whenever any task is".
    autoRunEnabled: true,
} as const;

// Selecting an account level sets a sensible default number of daily searches
// (the user can still override the number manually).
export const LEVEL_SEARCHES: Record<string, number> = {
    member: 5,
    silver: 10,
    gold: 20,
};

export type NumericSetting = 'searches' | 'timeout' | 'closeTime';

// Inclusive integer bounds. 0 is a real timeout and a real close time: the
// runner turns a 0s gap into about 1s, and treats a 0s close time as "close
// once the tab has loaded". Those meanings stay; only values outside the range
// are rejected.
export const SETTING_LIMITS: Record<NumericSetting, { min: number; max: number }> = {
    searches: { min: 1, max: 999 },
    timeout: { min: 0, max: 9999 },
    closeTime: { min: 0, max: 300 },
};

// Whole integers only. A blank field, a decimal and anything outside the range
// are not a setting — the caller keeps the previous value.
export function parseSettingInput(kind: NumericSetting, raw: string): number | null {
    const text = raw.trim();
    if (!/^\d+$/.test(text)) return null;
    const value = Number(text);
    const { min, max } = SETTING_LIMITS[kind];
    if (value < min || value > max) return null;
    return value;
}

// What a round actually runs. A missing or invalid stored value uses the
// default for that field; a valid short gap is kept as the user saved it.
export function clampSetting(kind: NumericSetting, value: unknown): number {
    if (typeof value === 'number' && Number.isInteger(value)) {
        const { min, max } = SETTING_LIMITS[kind];
        if (value >= min && value <= max) return value;
    }
    return DEFAULTS[kind];
}
