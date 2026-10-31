import { browser } from 'wxt/browser';
import { getRndInteger } from '@/entrypoints/utils/helpers';
import { trackTab, untrackTab } from './tabCleanup';
import { currentRun, endRun, isRunStopping, recordResult, settleUnresolved } from './taskRun';
import type { TaskKind, TaskResult, TaskStatus } from '@/entrypoints/utils/runState';

// Safety cap: close the dashboard tab even if the content script never reports
// done (page failed to render the daily sets, message dropped, etc.).
const DAILY_TAB_MAX_LIFETIME_MS = 90000;
// A daily-set search tab is closed a random few seconds after it finishes
// loading (so the search registers before we close it).
const DAILY_LINK_MIN_LINGER_MS = 2000;
const DAILY_LINK_MAX_LINGER_MS = 5000;
// Fallback: close a daily-set tab this long after it opened even if it never
// reports "complete".
const DAILY_LINK_HARD_CLOSE_MS = 20000;
// Give up waiting on the dashboard to load rather than leaving the promise
// pending forever when the tab is closed (by the user or by `finish`) or the
// load event never arrives.
const DASHBOARD_LOAD_TIMEOUT_MS = 30000;

export interface DashboardJobs {
    doDailySet: boolean;
    doClaim: boolean;
}

// Opens the rewards dashboard and tells the content script which of its jobs to
// run: clicking the daily-set cards (that click is what credits the points) and
// pressing "Ready to claim". The dashboard is opened ACTIVE: browsers pause
// rendering/timers in hidden tabs, so the SPA won't render its daily-set grid or
// its claim flyout — nor keep the click loop running — unless the tab is
// visible. We restore the user's previous tab when done. Each daily-set click
// opens a search in its own tab (auto-closed shortly after it loads); if such a
// tab grabs focus we snap it back to the dashboard so it stays rendered.
export async function openDailyRewards(runId: number, jobs: DashboardJobs): Promise<void> {
    const previousActiveTabId = await getActiveTabId();
    if (await isRunStopping(runId)) {
        await closeOut(runId, startedKinds(jobs), undefined);
        return;
    }

    const tab = await browser.tabs.create({ url: 'https://rewards.bing.com/dashboard', active: true });
    const dashboardId = tab.id!;
    // A stop that arrived while the tab was being created cannot undo it. The tab
    // is still registered, and finish() — which stays armed — closes it.
    if (await isRunStopping(runId)) {
        await trackTab(dashboardId, DAILY_TAB_MAX_LIFETIME_MS);
        await closeOwnedTab(runId, dashboardId);
        await closeOut(runId, startedKinds(jobs), undefined);
        return;
    }
    // The `finish` timer below is the precise close; this is the backstop for
    // when the service worker is torn down before it ever fires.
    await trackTab(dashboardId, DAILY_TAB_MAX_LIFETIME_MS);

    function onCreated(created: { id?: number; openerTabId?: number }): void {
        if (created.openerTabId !== dashboardId || created.id == null) return;
        // Keep the dashboard foregrounded so it stays rendered and keeps
        // clicking; the search tab still loads in the background and credits.
        browser.tabs.update(dashboardId, { active: true }).catch(() => {});
        closeDailyTabAfterLoad(created.id);
    }
    browser.tabs.onCreated.addListener(onCreated);

    let done = false;
    const dashboardKinds = startedKinds(jobs);
    let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;

    function finish(reported?: DashboardReport): void {
        if (done) return;
        done = true;
        browser.runtime.onMessage.removeListener(doneListener);
        browser.tabs.onCreated.removeListener(onCreated);
        browser.tabs.onRemoved.removeListener(onRemoved);
        clearInterval(stopWatch);
        clearTimeout(lifetimeTimer);
        // The id was captured when this round opened the tab, and this function
        // still runs up to 90s after a stop. The remove happens before closeOut
        // drops the daily and claim records, which is what keeps a new round
        // from starting and taking the same id.
        void (async () => {
            await closeOwnedTab(runId, dashboardId);
            await closeOut(runId, dashboardKinds, reported);
        })();
        if (previousActiveTabId != null) {
            browser.tabs.update(previousActiveTabId, { active: true }).catch(() => {});
        }
    }

    // A message only counts when it names this round and comes from this round's
    // dashboard tab. A page left open from the previous round, or the same page
    // reporting twice, cannot write into the round that is running now.
    function doneListener(message: DashboardReport, sender: { tab?: { id?: number } }): void {
        if (message.action !== 'dashboardDone') return;
        if (message.runId !== runId || sender.tab?.id !== dashboardId) return;
        finish(message);
    }
    // The content script re-reads the run record before each click and stops
    // clicking once the phase is `stopping`. This watch is what closes the
    // dashboard after that, including when the script is already gone and will
    // never send dashboardDone.
    const stopWatch = setInterval(() => {
        void isRunStopping(runId).then((stopping) => {
            if (stopping) finish();
        });
    }, 250);
    browser.runtime.onMessage.addListener(doneListener);
    // Registered before the load wait on purpose. A tab the user closes while it
    // is still loading never reaches `complete`, so a listener added after that
    // wait would miss the close and the round would stay `running`.
    function onRemoved(closedId: number): void {
        if (closedId === dashboardId) finish();
    }
    browser.tabs.onRemoved.addListener(onRemoved);
    // If the worker was asleep and this listener is gone, the tracked-tab sweep
    // still closes the page. This timer is the in-worker copy of that deadline:
    // a visit that never reports is recorded as unconfirmed, not left running.
    lifetimeTimer = setTimeout(finish, DAILY_TAB_MAX_LIFETIME_MS);

    // Not awaited. The close listener and the lifetime timer above are already
    // armed, so a tab closed while this wait is pending still ends the round.
    void waitForDashboardLoad(dashboardId, () => {
        browser.tabs
            .sendMessage(dashboardId, { action: 'runDashboard', runId, ...jobs })
            .catch(() => finish());
    }, finish);
}

function waitForDashboardLoad(dashboardId: number, onLoaded: () => void, onTimeout: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
        let isSettled = false;
        function settle(): void {
            if (isSettled) return;
            isSettled = true;
            browser.tabs.onUpdated.removeListener(loadListener);
            clearTimeout(giveUpTimer);
            resolve();
        }
        function loadListener(updatedId: number, changeInfo: { status?: string }): void {
            if (updatedId !== dashboardId || changeInfo.status !== 'complete') return;
            browser.tabs.onUpdated.removeListener(loadListener);
            setTimeout(() => {
                onLoaded();
                settle();
            }, 300);
        }
        browser.tabs.onUpdated.addListener(loadListener);
        // Loading never finished. Waiting longer only keeps the round `running`;
        // the timeout records the tasks as unconfirmed and closes the tab.
        const giveUpTimer = setTimeout(() => {
            settle();
            onTimeout();
        }, DASHBOARD_LOAD_TIMEOUT_MS);
    });
}

function startedKinds(jobs: DashboardJobs): TaskKind[] {
    const kinds: TaskKind[] = [];
    if (jobs.doDailySet) kinds.push('daily');
    if (jobs.doClaim) kinds.push('claim');
    return kinds;
}

interface DashboardReport {
    action?: string;
    runId?: number;
    daily?: TaskResult;
    claim?: TaskResult;
}

// A report names the tasks it actually ran. A task it leaves out — because the
// page was closed, the script never answered, or the wait expired — is
// unconfirmed. A result that was already written (stop, for instance) is kept.
// Once the round is stopping, a late report cannot replace that cancelled result
// with completed: the page has not been asked to finish, and a script on that
// page must not be able to write a success the round did not confirm.
async function closeOut(runId: number, kinds: TaskKind[], reported?: DashboardReport): Promise<void> {
    const stopping = await isRunStopping(runId);
    for (const kind of kinds) {
        const given = stopping ? undefined : (kind === 'daily' ? reported?.daily : reported?.claim);
        const result = given ?? (stopping
            ? { status: 'cancelled' as TaskStatus, reason: '已停止' }
            : { status: 'unconfirmed' as TaskStatus, reason: reported ? '页面未返回该项结果' : '页面未在时限内返回结果' });
        await recordResult(runId, kind, result);
        await endRun(runId, kind);
    }
    await settleUnresolved(runId, kinds, { status: 'unconfirmed', reason: '页面未在时限内返回结果' });
}

// tabs.remove takes an id, and Chrome reuses an id once its tab is gone. The
// daily and claim records are what keep a new round out until this close. If
// they are already gone, the id may belong to something else and is left open.
async function closeOwnedTab(runId: number, tabId: number): Promise<void> {
    const run = await currentRun();
    const stillThisRound = run?.id === runId && Boolean(run.daily || run.claim);
    if (stillThisRound) {
        // No await between the check and remove(). beginRun cannot start another
        // round while this record exists, so the id cannot have been reused yet.
        // remove() rejects when the tab is already gone; that rejection is the
        // "already closed" case and is ignored.
        void browser.tabs.remove(tabId).catch(() => {});
    }
    await untrackTab(tabId);
}

async function getActiveTabId(): Promise<number | undefined> {
    try {
        const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
        return tabs[0]?.id;
    } catch {
        return undefined;
    }
}

// Close a daily-set search tab a random few seconds after it finishes loading,
// with a hard cap in case it never reports "complete".
function closeDailyTabAfterLoad(tabId: number): void {
    void trackTab(tabId, DAILY_LINK_HARD_CLOSE_MS);
    let closed = false;
    function close(): void {
        if (closed) return;
        closed = true;
        browser.tabs.onUpdated.removeListener(loadListener);
        browser.tabs.get(tabId).then(() => browser.tabs.remove(tabId)).catch(() => {});
        void untrackTab(tabId);
    }
    function loadListener(updatedId: number, changeInfo: { status?: string }): void {
        if (updatedId === tabId && changeInfo.status === 'complete') {
            browser.tabs.onUpdated.removeListener(loadListener);
            setTimeout(close, getRndInteger(DAILY_LINK_MIN_LINGER_MS, DAILY_LINK_MAX_LINGER_MS));
        }
    }
    browser.tabs.onUpdated.addListener(loadListener);
    setTimeout(close, DAILY_LINK_HARD_CLOSE_MS);
}
