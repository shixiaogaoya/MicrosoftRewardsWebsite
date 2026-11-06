import { defineContentScript } from '#imports';
import { browser } from 'wxt/browser';
import { getRndInteger, wait } from '@/entrypoints/utils/helpers';
import { oncePerPageRun } from '@/entrypoints/utils/oncePerPageRun';
import { MAX_WAIT_MS, OPEN_DELAY_MIN_MS, OPEN_DELAY_SPREAD_MS, RESULT_SELECTOR } from '@/entrypoints/utils/firstResult';

// On search tabs the extension opened (tagged with ?marAuto=1), navigate to the
// first organic Bing result after a short random delay, so the visit reads as a
// normal search-and-click rather than a results page nobody looked at. Opt-in
// from the popup and off by default, since leaving the results page risks the
// search not being credited. Manual Bing searches lack the marker and are left
// alone. The timing constants live in utils/firstResult.ts, shared with the
// background, which schedules this tab's close around the same window.

export default defineContentScript({
    matches: ['https://www.bing.com/search*'],
    async main() {
        if (!new URLSearchParams(location.search).has('marAuto')) return;
        if (!oncePerPageRun('_marFirstResultClicked')) return;

        // The marker alone is not permission. The background holds the round
        // record and knows which tabs this round opened, so it is asked before
        // any waiting starts and again right before navigating: a page that
        // merely carries ?marAuto (a bookmark, a copied link, a tab left over
        // from an earlier round) is never ours, and a round that was stopped —
        // or a setting turned off — since the tab opened must not leave the
        // results page either. A refusal means nothing is left armed: no
        // observer, no delay timer, no navigation.
        if (!(await confirmedByBackground())) return;
        const first = await waitForFirstResult();
        // No organic result rendered (ads-only page, layout change, slow load):
        // leave the tab on the results page rather than guessing at a target.
        if (!first) return;
        // Randomized pause, then navigate in place. Using location.assign (not
        // anchor.click) keeps navigation in this same background tab: it never
        // spawns a new tab and never activates this one, so the user's current
        // focus is preserved.
        await wait(OPEN_DELAY_MIN_MS + getRndInteger(0, OPEN_DELAY_SPREAD_MS));
        if (!(await confirmedByBackground())) return;
        location.assign(first.href);
    },
});

// Failing closed: without an explicit yes the tab stays on the results page. A
// missing or malformed reply, or a send that never lands, is a no.
async function confirmedByBackground(): Promise<boolean> {
    try {
        const response = await browser.runtime.sendMessage<{ action: string }, { allowed?: unknown }>({ action: 'bingFirstResult' });
        return response?.allowed === true;
    } catch {
        return false;
    }
}

// Bing renders results async, so wait for the first organic anchor to appear,
// falling back to null after a bounded wait rather than hanging.
function waitForFirstResult(): Promise<HTMLAnchorElement | null> {
    return new Promise((resolve) => {
        const existing = document.querySelector<HTMLAnchorElement>(RESULT_SELECTOR);
        if (existing) {
            resolve(existing);
            return;
        }
        const observer = new MutationObserver(() => {
            const found = document.querySelector<HTMLAnchorElement>(RESULT_SELECTOR);
            if (found) {
                observer.disconnect();
                clearTimeout(timer);
                resolve(found);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        const timer = setTimeout(() => {
            observer.disconnect();
            resolve(null);
        }, MAX_WAIT_MS);
    });
}
