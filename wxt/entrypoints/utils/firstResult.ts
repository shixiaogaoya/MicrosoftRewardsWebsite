// Timing shared by the bing-result content script and the background's search
// runner. The script waits for the first organic result, pauses a randomized
// while, then navigates to it; the background schedules the same tab's close,
// and a close that lands inside that pause would kill the navigation. Both
// sides therefore read these numbers from one place.

export const RESULT_SELECTOR = '#b_results li.b_algo h2 a';

// Bing renders results async, so the script waits for the first organic anchor
// up to this bound before giving up on navigating at all.
export const MAX_WAIT_MS = 8000;

// Wait a randomized 1.5–5.5s before opening so it isn't an instant, robotic jump.
export const OPEN_DELAY_MIN_MS = 1500;
export const OPEN_DELAY_SPREAD_MS = 4000;

// The latest instant the script may still navigate: the bounded wait for a
// result plus the longest randomized pause, with a margin for the permission
// ask that precedes the navigation. The close of a marked tab is scheduled
// only after this window, so no random draw can race the navigation — a zero
// close time used to close the tab 0–1s in (before the navigation could ever
// happen), and the 5s default closed it at 4.5–5.5s, right inside the
// 1.5–5.5s navigation window.
export const FIRST_RESULT_NAV_WINDOW_MS = MAX_WAIT_MS + OPEN_DELAY_MIN_MS + OPEN_DELAY_SPREAD_MS + 1000;
