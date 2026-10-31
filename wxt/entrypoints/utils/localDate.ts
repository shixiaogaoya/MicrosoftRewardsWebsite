// The extension's scheduling boundary is the device's local calendar day.
// This is not Microsoft's points-reset clock: a day that rolls over at local
// midnight can still be the previous day on the rewards service, and the other
// way around. Callers that need "did we already try today" use this id; they do
// not use toLocaleDateString(), whose shape changes with the UI language.

export function localDateId(now: Date = new Date()): string {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// The previous once-per-day marker was written with toLocaleDateString() and
// synced. Only a value that is exactly today's rendering in the locale this
// browser is currently using counts as "tried today". Anything else — another
// locale's spelling, a different day, garbage — is ignored, so a migrated
// install is never told it already succeeded.
export function isLegacyToday(value: unknown, now: Date = new Date()): boolean {
    return typeof value === 'string' && value === now.toLocaleDateString();
}
