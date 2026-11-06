// Unlike the background suites, this one needs a DOM (anchors, location,
// MutationObserver), so it runs in the default happy-dom environment. The
// script's only external dependency is the background's reply, and the fake
// browser's runtime messaging is a stub, so the module is mocked wholesale and
// each test sets the reply it wants to exercise.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContentScriptContext } from 'wxt/utils/content-script-context';

const sendMessage = vi.hoisted(() => vi.fn());
vi.mock('wxt/browser', () => ({
    browser: { runtime: { sendMessage } },
}));

import script from '../bingResult.content';

const TARGET_HREF = 'https://example.com/first-organic-result';
// The randomized pause before navigating is 1.5–5.5s; advancing past the whole
// range settles it whatever Math.random returned.
const MAX_OPEN_DELAY_MS = 5500;

function loadSerp(query: string): void {
    // replaceState only rewrites the URL — no navigation — and the script reads
    // nothing but location.search off it.
    history.replaceState(null, '', `/search?q=${query}`);
    document.body.innerHTML = `<ol id="b_results"><li class="b_algo"><h2><a href="${TARGET_HREF}">result</a></h2></li></ol>`;
}

async function runMain(): Promise<void> {
    // The script ignores the context it is handed; it is passed only because
    // main's signature takes one.
    const finished = script.main(new ContentScriptContext('test'));
    await vi.advanceTimersByTimeAsync(MAX_OPEN_DELAY_MS + 1);
    await finished;
}

describe('bingResult content script', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // oncePerPageRun marks the window; clear it so each test starts fresh.
        delete (window as unknown as Record<string, unknown>)._marFirstResultClicked;
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        sendMessage.mockReset();
    });

    it('navigates to the first organic result when the background allows it', async () => {
        loadSerp('test&marAuto=1');
        const assign = vi.spyOn(location, 'assign');
        sendMessage.mockResolvedValue({ allowed: true });

        await runMain();

        expect(assign).toHaveBeenCalledWith(TARGET_HREF);
        // Asked before any waiting starts, and again right before navigating.
        expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    // Regression: the script used to navigate on the ?marAuto marker alone, so
    // a page the current round never opened — a bookmark, a copied link, a tab
    // left over from a stopped or finished round — left the results page too.
    // The background refuses those asks, and the refusal must stick: no result
    // wait, no delay timer, no navigation.
    it('stays on the results page when the background refuses', async () => {
        loadSerp('test&marAuto=1');
        const assign = vi.spyOn(location, 'assign');
        sendMessage.mockResolvedValue({ allowed: false });

        await runMain();

        expect(assign).not.toHaveBeenCalled();
        // Refused up front: it never even asked again after the delay.
        expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    // A round that was stopped between the two asks is refused at the second
    // one, after the pause; the navigation still must not happen.
    it('stays on the results page when the refusal lands after the delay', async () => {
        loadSerp('test&marAuto=1');
        const assign = vi.spyOn(location, 'assign');
        sendMessage.mockResolvedValueOnce({ allowed: true }).mockResolvedValue({ allowed: false });

        await runMain();

        expect(assign).not.toHaveBeenCalled();
        expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    it('stays on the results page when the ask itself fails', async () => {
        loadSerp('test&marAuto=1');
        const assign = vi.spyOn(location, 'assign');
        sendMessage.mockRejectedValue(new Error('message port closed'));

        await runMain();

        expect(assign).not.toHaveBeenCalled();
    });

    it('does nothing on a Bing page without the marker', async () => {
        loadSerp('test');
        const assign = vi.spyOn(location, 'assign');

        await runMain();

        expect(sendMessage).not.toHaveBeenCalled();
        expect(assign).not.toHaveBeenCalled();
    });
});
