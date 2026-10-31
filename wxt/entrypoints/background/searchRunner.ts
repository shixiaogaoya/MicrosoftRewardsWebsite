import { browser } from 'wxt/browser';
import { storage } from '#imports';
import { getRndInteger } from '@/entrypoints/utils/helpers';
import { buildSearchQuery, buildSearchUrl, nextDelayMs, shouldOpenMore } from '@/entrypoints/utils/search';
import { getStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { clearBadge, setSearchCountBadge } from '@/entrypoints/utils/browserAction';
import type { RunConfig } from '@/entrypoints/utils/runState';
import { trackTab, untrackTab } from './tabCleanup';
import { claimStep, currentRun, endRun, readConfig, readProgress, recordResult, writeProgress, writeProgressIfRunning, type TaskRunState } from './taskRun';

const ALARM_NAME = 'openTabAlarm';
// A search tab closes `closeTime` after it finishes loading, so the durable
// cleanup deadline has to allow for the load on top of that — a slow page must
// not be swept away before its search has had a chance to register.
const SEARCH_TAB_LOAD_ALLOWANCE_MS = 60000;

// Chrome silently clamps any alarm shorter than this to 30s, so a gap the user
// configured below it cannot be expressed as an alarm at all.
const ALARM_MIN_DELAY_MS = 30000;

// The alarm is named for the round and the step it was armed for, not just the
// feature. An alarm outlives the round that created it: after a stop and a fresh
// start, the old one still fires, and a name alone would let it advance whatever
// round happens to be current. Carrying both values lets a firing be attributed
// to exactly one step of one round, and stale ones are dropped.
function searchAlarmName(runId: number, step: number): string {
    return `${ALARM_NAME}:${runId}:${step}`;
}

export function isSearchAlarm(name: string): boolean {
    return name === ALARM_NAME || name.startsWith(`${ALARM_NAME}:`);
}

function parseSearchAlarm(name: string): { runId: number; step: number } | null {
    const match = /^openTabAlarm:(\d+):(\d+)$/.exec(name);
    if (!match) return null;
    return { runId: Number(match[1]), step: Number(match[2]) };
}

// Opens tab #1 immediately, then schedules the rest. The count, the gap and the
// close time are the ones frozen into this round, not whatever the settings say
// now — editing them mid-run applies to the next round.
export async function startSearches(runId: number, config: RunConfig): Promise<void> {
    await runSearchStep(runId, 1, config);
}

export async function handleAlarmStep(alarm: { name: string }): Promise<void> {
    if (!isSearchAlarm(alarm.name)) return;
    const target = parseSearchAlarm(alarm.name);
    // A bare alarm name carries no round, so there is no step it could safely
    // advance: the round it belonged to cannot be identified. Ignoring it is
    // right — the next step is armed by name once its own round runs.
    if (!target) return;
    const run = await currentRun();
    // The alarm names the round and step it was armed for. A firing whose round
    // has ended, or whose step is no longer the next one, is a leftover from a
    // stopped or replaced run: it must not touch whatever round is current now.
    if (!run || run.id !== target.runId || run.phase !== 'running' || !run.search) return;
    const config = await readConfig();
    if (!config) {
        await finishSearch(run.id, { status: 'failed', reason: '本轮搜索配置丢失' });
        return;
    }
    const progress = await readProgress();
    const opened = progress?.opened ?? 0;
    // Only the step this alarm was armed for may run. Anything else is a stale
    // firing (an old alarm, or one already consumed by the other trigger).
    if (target.step !== opened + 1) return;
    const searchesStillOn = await getStorageItem<boolean>('active', StorageValues.SYNC);

    // Alarms outlive the setting that created them (they survive a browser
    // restart), so re-check the toggle every step: with "执行搜索" off, a leftover
    // alarm must not keep opening Bing tabs. The frozen count is what decides
    // "are we done", not the live setting.
    if (searchesStillOn === false || !shouldOpenMore(opened, config.searches)) {
        await finishSearch(run.id, searchesStillOn === false
            ? { status: 'cancelled', reason: '已关闭搜索' }
            : { status: 'completed' });
        return;
    }
    await runSearchStep(run.id, target.step, config);
}

// Claims this step before doing anything it cannot undo. The in-worker timer and
// the 30s backstop alarm both arrive here; whichever lands second sees the step
// already taken and returns. A callback whose round was stopped or replaced fails
// the same check, so it cannot open a tab or rewrite the new round's count.
async function runSearchStep(runId: number, step: number, config: RunConfig): Promise<void> {
    if (!(await claimStep(runId, step, 'search'))) return;
    await openSearchTab(runId, config.closeTime * 1000);
    // Stop can land while the tab is being created. The tab itself cannot be
    // uncreated, but it is already registered for cleanup; this step must not
    // put the round back into "running" or arm another one.
    if (!(await stillRunning(runId))) {
        clearBadge();
        return;
    }
    // A failed write means the round ended between the check above and the
    // queued write, so this step is no longer current: no further scheduling.
    if (!(await recordProgress(runId, step, config.searches))) {
        clearBadge();
        return;
    }
    if (shouldOpenMore(step, config.searches)) {
        scheduleNextStep(runId, step + 1, config.timeout);
    } else {
        await finishSearch(runId, { status: 'completed' });
    }
}

async function stillRunning(runId: number): Promise<boolean> {
    const run = await getStorageItem<TaskRunState>('taskRun', StorageValues.LOCAL);
    return run?.id === runId && run.phase === 'running' && run.search;
}

// Waits out the gap before the next search, then runs the step.
//
// A gap of 30s or more is left to the alarm: durable, and the only thing that
// survives the service worker being torn down. A shorter gap also needs an
// in-worker timer, because Chrome rounds a sub-30s alarm up to 30s — which used
// to make every setting under 20s behave as 30s. The timer does not outlive a
// teardown, so the alarm is still armed at that 30s minimum as a backstop: worst
// case the run resumes ~30s late instead of stalling for good.
//
// Whichever path fires first re-schedules under the same alarm name, and
// creating an alarm replaces the pending one, so a step never runs twice.
let shortStepTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleNextStep(runId: number, step: number, searchTimeout: number): void {
    const delayMs = nextDelayMs(searchTimeout);
    const name = searchAlarmName(runId, step);
    browser.alarms.create(name, { delayInMinutes: Math.max(delayMs, ALARM_MIN_DELAY_MS) / 60000 });
    clearShortStepTimer();
    if (delayMs < ALARM_MIN_DELAY_MS) {
        shortStepTimer = setTimeout(() => {
            shortStepTimer = undefined;
            void handleAlarmStep({ name });
        }, delayMs);
    }
}

function clearShortStepTimer(): void {
    if (shortStepTimer !== undefined) {
        clearTimeout(shortStepTimer);
        shortStepTimer = undefined;
    }
}

export async function stopSearches(): Promise<void> {
    const progress = await readProgress();
    if (progress?.isSearching) await writeProgress({ ...progress, isSearching: false });
    clearBadge();
    clearShortStepTimer();
    // Only this feature's alarms: clearAll() also wiped the tab-cleanup sweep,
    // which left every tab the run had opened on screen for good. Every search
    // alarm is ours, including one left by a round that ended without clearing
    // it, so all of them go.
    const all = await browser.alarms.getAll();
    await Promise.all(
        all
            .filter((alarm) => isSearchAlarm(alarm.name))
            .map((alarm) => browser.alarms.clear(alarm.name))
    );
}

async function finishSearch(runId: number, result: { status: 'completed' | 'cancelled' | 'failed'; reason?: string }): Promise<void> {
    await recordResult(runId, 'search', result);
    await stopSearches();
    await endRun(runId, 'search');
}

// Turning "执行搜索" off stops the search half of a round that is already in
// flight — waiting for the next alarm would leave the popup claiming searches
// are still running. It does not stop the dashboard half: daily cards and claim
// keep going. Watching storage also covers the toggle being synced from another
// device.
export function watchSearchesToggle(): void {
    storage.watch<boolean>('sync:active', (isEnabled) => {
        if (isEnabled === false) void stopSearchOnly();
    });
}

async function stopSearchOnly(): Promise<void> {
    const run = await currentRun();
    await stopSearches();
    if (!run?.search) return;
    await recordResult(run.id, 'search', { status: 'cancelled', reason: '已关闭搜索' });
    await endRun(run.id, 'search');
}

// `opened` is how many search tabs this round has started, not how many points
// that earned. The popup and the toolbar badge both read it, so every step must
// persist it — including the last one, or the popup would freeze one short of
// the total. The total is the one frozen at the start of the round.
//
// The round check and the write are one queued operation: checking here and then
// queueing the write would leave a gap a stop or a new round could slip into,
// letting a stale step overwrite the new round's count. Returns false when this
// step's round is gone, and the caller must then not schedule the next step.
async function recordProgress(runId: number, opened: number, total: number): Promise<boolean> {
    const written = await writeProgressIfRunning(runId, { opened, total, isSearching: true });
    if (!written) return false;
    setSearchCountBadge(opened);
    return true;
}

// The marAuto marker tells the bing-result content script this tab was opened
// by the extension, so it may open the first organic result. It's only added
// when the user enabled "Open first result in search tabs"; manual Bing
// searches (and tabs opened with the option off) lack the marker and are left
// untouched.
async function openSearchTab(runId: number, closeTimeMs: number): Promise<number | null> {
    if (!(await stillRunning(runId))) return null;
    const openFirstResult = await getStorageItem<boolean>('openFirstResult', StorageValues.SYNC);
    const query = buildSearchUrl(buildSearchQuery());
    const url = openFirstResult ? `${query}&marAuto=1` : query;
    return await openAndClose(runId, url, closeTimeMs + getRndInteger(0, 1000));
}

async function openAndClose(runId: number, url: string, closeTimeMs: number): Promise<number | null> {
    const tab = await browser.tabs.create({ url, active: false });
    const tabId = tab.id!;
    // Backstop for the close below, whose timer and listener are both lost when
    // the service worker is torn down. A stop that landed while create() was in
    // flight cannot undo the tab, so it still has to be registered for cleanup.
    await trackTab(tabId, closeTimeMs + SEARCH_TAB_LOAD_ALLOWANCE_MS);
    if (!(await stillRunning(runId))) return null;
    function listener(updatedId: number, changeInfo: { status?: string }): void {
        if (updatedId === tabId && changeInfo.status === 'complete') {
            browser.tabs.onUpdated.removeListener(listener);
            waitAndClose(tabId, closeTimeMs);
        }
    }
    browser.tabs.onUpdated.addListener(listener);
    return tabId;
}

function waitAndClose(id: number, closeTimeMs: number): void {
    const timeout = closeTimeMs <= 0 ? 500 : closeTimeMs;
    setTimeout(() => void closeTab(id), Math.max(timeout - 500, 0) + getRndInteger(0, 1000));
}

async function closeTab(id: number): Promise<void> {
    await browser.tabs.get(id).then(() => browser.tabs.remove(id)).catch(() => {});
    await untrackTab(id);
}
