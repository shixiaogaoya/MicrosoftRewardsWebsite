import { defineContentScript } from '#imports';
import { browser } from 'wxt/browser';
import { getRndInteger, wait } from '@/entrypoints/utils/helpers';
import { matchDailyAnchors } from '@/entrypoints/utils/dailyAnchors';
import { claimPoints, hasSignInLink, type ClaimOutcome } from '@/entrypoints/utils/claimFlow';
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
// The reply names this round, and says what each job ended as — a click is not
// reported as a confirmed claim or a confirmed daily card.
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

const CLAIM_RESULTS: Record<ClaimOutcome, TaskResult> = {
    claimed: { status: 'completed' },
    // The flyout opened and its own control said there was nothing to press.
    nothingToClaim: { status: 'not-needed' },
    // No card, or a flyout that never opened: the page does not match what we
    // look for. That is not the same as "nothing to claim".
    noCard: { status: 'unconfirmed', reason: '未找到领取入口' },
    noDialog: { status: 'unconfirmed', reason: '领取窗口未打开' },
    unconfirmed: { status: 'unconfirmed', reason: '已点击，未出现完成状态' },
    signedOut: { status: 'failed', reason: '未登录' },
    cancelled: { status: 'cancelled', reason: '已停止' },
};

function claimResult(outcome: ClaimOutcome): TaskResult {
    return CLAIM_RESULTS[outcome];
}

// Clicks the cards the dashboard rendered. The page has no marker this script
// can read back to tell a credited card from one that only opened, so a click
// is reported as unconfirmed rather than as points earned. Finding no cards is
// also unconfirmed: an empty grid can be a slow render, not a finished day.
async function openDailySets(stopped: () => Promise<boolean>): Promise<TaskResult> {
    const anchors = await waitForMatch(() => {
        const found = matchDailyAnchors(document);
        return found.length > 0 ? found : null;
    }, DAILY_ANCHORS_TIMEOUT_MS);
    if (await stopped()) return { status: 'cancelled', reason: '已停止' };
    if (!anchors) {
        return hasSignInLink(document)
            ? { status: 'failed', reason: '未登录' }
            : { status: 'unconfirmed', reason: '未找到每日活动卡片' };
    }
    let clicked = 0;
    for (const anchor of anchors) {
        if (await stopped()) break;
        anchor.click();
        clicked += 1;
        await wait(1000 + getRndInteger(0, 1000));
    }
    if (await stopped()) {
        return { status: 'cancelled', reason: clicked > 0 ? `已停止，已点击 ${clicked} 张卡片` : '已停止' };
    }
    return { status: 'unconfirmed', reason: `已点击 ${clicked} 张卡片，页面没有完成标记` };
}
