import { browser } from 'wxt/browser';
import { getStorageItem, setStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { RUN_KEY, type TaskRunState } from '@/entrypoints/utils/runState';
import { endRun, recordResult } from './taskRun';

// Tab ids the extension opened, each mapped to the wall-clock time by which it
// must be gone.
type TrackedTabs = Record<string, number>;

const REGISTRY_KEY = 'trackedTabs';
const CLEANUP_ALARM = 'closeStaleTabs';
// Chrome's floor for a repeating alarm. A tab whose in-memory timer was lost
// therefore closes within about a minute of its deadline instead of never.
const SWEEP_PERIOD_MINUTES = 1;

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
        // dashboard whose deadline has passed would otherwise stay `running`.
        // Closing the tab is not enough: the result has to be written too.
        if (due.length > 0) await settleDashboardIfGone();
    });
}

async function settleDashboardIfGone(): Promise<void> {
    const run = await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL);
    if (!run || run.phase === 'stopping') return;
    const kinds = (['daily', 'claim'] as const).filter((kind) => run[kind]);
    if (kinds.length === 0) return;
    const open = await browser.tabs.query({ url: 'https://rewards.bing.com/*' });
    if (open.length > 0) return;
    for (const kind of kinds) {
        await recordResult(run.id, kind, { status: 'unconfirmed', reason: '页面未在时限内返回结果' });
        await endRun(run.id, kind);
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
// waking the worker every minute for the rest of the session.
async function saveRemaining(tracked: TrackedTabs): Promise<void> {
    await writeRegistry(tracked);
    if (Object.keys(tracked).length === 0) await browser.alarms.clear(CLEANUP_ALARM);
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
