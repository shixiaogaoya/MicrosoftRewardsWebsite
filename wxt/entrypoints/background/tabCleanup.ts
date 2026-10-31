import { browser } from 'wxt/browser';
import { getStorageItem, setStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { DASHBOARD_MAX_LIFETIME_MS, RUN_KEY, type TaskRunState } from '@/entrypoints/utils/runState';
import { endRun, recordResult } from './taskRun';

// Tab ids the extension opened, each mapped to the wall-clock time by which it
// must be gone.
type TrackedTabs = Record<string, number>;

const REGISTRY_KEY = 'trackedTabs';
const CLEANUP_ALARM = 'closeStaleTabs';
// Chrome's floor for a repeating alarm. A tab whose in-memory timer was lost
// therefore closes within about a minute of its deadline instead of never.
const SWEEP_PERIOD_MINUTES = 1;

// How long a search round may go without recording a next-step deadline before
// a sweep treats it as abandoned. Generous on purpose: the longest legitimate
// wait is one gap plus the platform's alarm floor, and this must not cut a slow
// but healthy round short.
const SEARCH_ROUND_FALLBACK_MS = 30 * 60 * 1000;

export function isCleanupAlarm(name: string): boolean {
    return name === CLEANUP_ALARM;
}

// Records a tab the extension opened so that it still gets closed when the
// setTimeout meant to close it never runs. That is the normal case in an MV3
// service worker: it is torn down after ~30s idle, taking pending timers and
// runtime-registered tab listeners with it, which is why search and daily-set
// tabs used to pile up. Alarms survive that teardown, so the sweep does not.
export function trackTab(tabId: number, closeAfterMs: number): Promise<void> {
    return enqueue(async () => {
        const tracked = await readRegistry();
        await writeRegistry({ ...tracked, [tabId]: Date.now() + closeAfterMs });
        await ensureSweepAlarm();
    });
}

// Called once a tab has closed on time, so the sweep has nothing left to do.
export function untrackTab(tabId: number): Promise<void> {
    return enqueue(async () => {
        const tracked = await readRegistry();
        if (!(String(tabId) in tracked)) return;
        await saveRemaining(without(tracked, tabId));
    });
}

export function sweepStaleTabs(): Promise<void> {
    return enqueue(async () => {
        const entries = Object.entries(await readRegistry());
        const now = Date.now();
        const due = entries.filter(([, deadline]) => deadline <= now);
        const remaining = Object.fromEntries(entries.filter(([, deadline]) => deadline > now));

        await Promise.all(due.map(([tabId]) => closeTab(Number(tabId))));
        await saveRemaining(remaining);
        // The in-worker lifetime timer is gone after a worker restart, so a
        // dashboard whose deadline has passed would otherwise stay `running`
        // (or `stopping`) for good, and every later start would join a round
        // that no longer exists. Closing the tab is not enough: the result has
        // to be written and the record has to end.
        await settleDashboardIfGone();
    });
}

// Settles a round whose own dashboard page is past its deadline.
//
// It has to be this round's tab, not "any Rewards page": the user may have the
// dashboard open themselves, and counting that as ours would leave the round
// hanging. It also has to run for a `stopping` round — a stop whose in-worker
// cleanup was lost is exactly the state that would otherwise never end.
async function settleDashboardIfGone(): Promise<void> {
    const run = await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL);
    if (!run) return;
    const stopping = run.phase === 'stopping';
    const dashboardKinds = (['daily', 'claim'] as const).filter((kind) => run[kind]);
    // A stopped round has no live page left to report, so whatever it still
    // held is over too.
    const stoppingSearch = stopping && run.search;
    // A search-only round is judged on the deadline its next step was due by:
    // its worker can die between opening a tab and arming that step, and nothing
    // else would ever end the record. A round that died before recording that
    // deadline falls back to its start time plus one full step allowance.
    const searchDeadline = run.searchDeadline ?? roundStart(run) + SEARCH_ROUND_FALLBACK_MS;
    const abandonedSearch = run.search && !stopping && searchDeadline <= Date.now();
    if (dashboardKinds.length === 0 && !stoppingSearch && !abandonedSearch) return;

    // The dashboard half still owns its page: if its own tab is alive and its
    // deadline has not passed, only the search half may be settled here.
    const dashboardDone =
        dashboardKinds.length === 0 ||
        (dashboardDeadlinePassed(run) && !(await tabIsStillOpen(run)));

    const cancelled = { status: 'cancelled' as const, reason: '已停止' };
    if (dashboardDone) {
        const result = stopping ? cancelled : { status: 'unconfirmed' as const, reason: '页面未在时限内返回结果' };
        for (const kind of dashboardKinds) {
            await recordResult(run.id, kind, result);
            await endRun(run.id, kind);
        }
    }
    if (stoppingSearch) {
        await recordResult(run.id, 'search', cancelled);
        await endRun(run.id, 'search');
    } else if (abandonedSearch) {
        await recordResult(run.id, 'search', { status: 'unconfirmed', reason: '后台中断，未能确认本轮搜索' });
        await endRun(run.id, 'search');
    }
}

// A round that never recorded its tab (the create() failed, or the worker died
// in the gap between starting the round and opening the page) is judged on its
// own start time instead, so a round that just began is never mistaken for an
// abandoned one.
function dashboardDeadlinePassed(run: TaskRunState): boolean {
    const deadline = run.dashboardDeadline ?? roundStart(run) + DASHBOARD_MAX_LIFETIME_MS;
    return deadline <= Date.now();
}

// `startedAt` was added after the first release of this state model, so a record
// written by an older build has none. Its id is a millisecond timestamp, which is
// the same moment — using it keeps such a record from being settled instantly on
// a NaN comparison. A record with neither is left alone rather than guessed at.
function roundStart(run: TaskRunState): number {
    if (Number.isFinite(run.startedAt)) return run.startedAt;
    if (Number.isFinite(run.id)) return run.id;
    return Number.POSITIVE_INFINITY;
}

async function tabIsStillOpen(run: TaskRunState, tabId = run.dashboardTabId): Promise<boolean> {
    if (tabId == null) return false;
    try {
        const tab = await browser.tabs.get(tabId);
        return tab != null;
    } catch {
        return false;
    }
}

// Tab ids do not survive a browser restart, so a registry carried over from the
// previous session points at tabs that no longer exist.
export function clearTrackedTabs(): Promise<void> {
    return enqueue(() => saveRemaining({}));
}

// One chain for every read-modify-write of the registry. A second call that
// arrives while the first is still awaiting its snapshot has to wait, or the
// older snapshot is written back over the newer registration. A failure is
// reported to that caller and then dropped here, so the next operation still runs.
let registryChain: Promise<void> = Promise.resolve();

function enqueue(operation: () => Promise<void>): Promise<void> {
    const run = registryChain.then(operation, operation);
    registryChain = run.then(() => {}, () => {});
    return run;
}

// Creating the alarm again replaces it and restarts its period, so a tab that is
// registered while a sweep is already armed must leave the existing schedule alone.
async function ensureSweepAlarm(): Promise<void> {
    if (await browser.alarms.get(CLEANUP_ALARM)) return;
    browser.alarms.create(CLEANUP_ALARM, { periodInMinutes: SWEEP_PERIOD_MINUTES });
}

async function readRegistry(): Promise<TrackedTabs> {
    return (await getStorageItem<TrackedTabs>(REGISTRY_KEY, StorageValues.LOCAL)) ?? {};
}

async function writeRegistry(tracked: TrackedTabs): Promise<void> {
    await setStorageItem(REGISTRY_KEY, tracked, StorageValues.LOCAL);
}

// Nothing tracked means nothing to sweep, so the alarm is dropped rather than
// waking the worker every minute for the rest of the session — unless a round
// still holds work that only a sweep can settle: a search-only round judged by
// its step deadline, or a stop whose cleanup was lost. Dropping the alarm then
// would leave that record blocking every later start for good.
async function saveRemaining(tracked: TrackedTabs): Promise<void> {
    await writeRegistry(tracked);
    if (Object.keys(tracked).length === 0 && !(await runNeedsSweep())) {
        await browser.alarms.clear(CLEANUP_ALARM);
        return;
    }
    await ensureSweepAlarm();
}

async function runNeedsSweep(): Promise<boolean> {
    const run = await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL);
    if (!run) return false;
    if (run.phase === 'stopping') return true;
    // Only a search round is settled by the sweep without a tab to watch; a
    // dashboard round keeps its own tab registered until its deadline.
    return run.search && run.daily === false && run.claim === false;
}

function without(tracked: TrackedTabs, tabId: number): TrackedTabs {
    return Object.fromEntries(Object.entries(tracked).filter(([id]) => id !== String(tabId)));
}

async function closeTab(tabId: number): Promise<void> {
    try {
        await browser.tabs.get(tabId);
        await browser.tabs.remove(tabId);
    } catch {
        // Already gone — closed by its own timer, or by the user.
    }
}
