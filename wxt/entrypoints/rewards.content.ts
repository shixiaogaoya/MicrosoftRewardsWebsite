import { defineContentScript } from '#imports';
import { browser } from 'wxt/browser';
import { getRndInteger, wait } from '@/entrypoints/utils/helpers';
import { claimPoints, type ClaimOutcome } from '@/entrypoints/utils/claimFlow';
import {
    claimTaskResult,
    dailySignedOutResult,
    dailyWaitExpiredCause,
    pendingResult,
    readDailyPage,
    recognizeSignedOut,
    type DailyPageReading,
} from '@/entrypoints/utils/rewardsRecognition';
import { waitForMatch } from '@/entrypoints/utils/waitForMatch';
import { oncePerPageRun } from '@/entrypoints/utils/oncePerPageRun';
import { RUN_KEY, type TaskResult, type TaskRunState } from '@/entrypoints/utils/runState';
import { storage } from '#imports';

// The daily-set grid renders async. Bounded, like every wait here: a day with no
// set is an ordinary outcome, and an observer that is never disconnected keeps
// firing for the life of the page.
const DAILY_ANCHORS_TIMEOUT_MS = 20000;

interface DashboardRequest {
    action?: string;
    runId?: number;
    doDailySet?: boolean;
    doClaim?: boolean;
}

export default defineContentScript({
    matches: ['https://rewards.bing.com/*'],
    main() {
        if (!oncePerPageRun('_marContentScriptInjected')) return;
        browser.runtime.onMessage.addListener((request: DashboardRequest) => {
            if (request.action === 'runDashboard') void runDashboard(request);
        });
    },
});

// Daily sets first: completing them can turn fresh points into claimable ones,
// so claiming afterwards picks those up in the same visit. Either job may be off.
// This script only orchestrates: what the page says is read by the recognition
// layer (rewardsRecognition), the clicks happen here, and neither a click nor a
// closed page is reported as a confirmed card or claim.
async function runDashboard(request: DashboardRequest): Promise<void> {
    const stopped = () => wasCancelled(request.runId);
    const daily = request.doDailySet ? await openDailySets(stopped) : undefined;
    if (await stopped()) {
        report(request.runId, daily ?? { status: 'cancelled', reason: '已停止' }, undefined);
        return;
    }
    const claim = request.doClaim ? claimResult(await claimPoints(document, stopped)) : undefined;
    report(request.runId, daily, claim);
}

function report(runId: number | undefined, daily: TaskResult | undefined, claim: TaskResult | undefined): void {
    browser.runtime.sendMessage({ action: 'dashboardDone', runId, daily, claim }).catch(() => {});
}

// The background keeps the round record and flips its phase to `stopping`.
// Storage is readable from the content script, so each click can see the stop
// without a second message. A missing record means the round already ended.
async function wasCancelled(runId: number | undefined): Promise<boolean> {
    if (runId == null) return false;
    const run = await storage.getItem<TaskRunState>(`local:${RUN_KEY}`);
    return !run || run.id !== runId || run.phase === 'stopping';
}

function claimResult(outcome: ClaimOutcome): TaskResult {
    return claimTaskResult(outcome);
}

// Clicks the cards the recognition layer could identify. Every card is of an
// unknown type to it — quiz and other cards that need real answers cannot be
// told from search cards without page samples — so the click count is never
// reported as completion, and the popup offers a manual entry to the page for
// what could not be verified.
async function openDailySets(stopped: () => Promise<boolean>): Promise<TaskResult> {
    const reading = await waitForMatch((): DailyPageReading | null => {
        const found = readDailyPage(document);
        // `unknown` keeps the wait going: an empty grid can be a slow render,
        // not a finished day. Signed-out resolves immediately instead.
        return found.state === 'unknown' ? null : found;
    }, DAILY_ANCHORS_TIMEOUT_MS);
    if (await stopped()) return { status: 'cancelled', reason: '已停止' };
    if (!reading) {
        // The wait expired still unreadable. Signed-out normally resolves during
        // the wait; this is the belt-and-braces read for a page that rendered it
        // late. Otherwise distinguish "a grid rendered but nothing in it is a
        // card we know" from "the dashboard never rendered".
        if (recognizeSignedOut(document)) return dailySignedOutResult();
        return pendingResult(dailyWaitExpiredCause(document));
    }
    if (reading.state === 'signed-out') return dailySignedOutResult();
    // The probe maps `unknown` to null, so the wait never resolves with it; this
    // branch only exists for the type. It reports what it is — unreadable — and
    // never claims the page is signed out without the sign-in signal.
    if (reading.state !== 'cards') return pendingResult('unknown-structure');
    let clicked = 0;
    for (const anchor of reading.anchors) {
        if (await stopped()) break;
        anchor.click();
        clicked += 1;
        await wait(1000 + getRndInteger(0, 1000));
    }
    if (await stopped()) {
        return { status: 'cancelled', reason: clicked > 0 ? `已停止，已点击 ${clicked} 张卡片` : '已停止' };
    }
    return pendingResult('no-completion-marker', `已点击 ${clicked} 张卡片，页面没有完成标记`);
}
