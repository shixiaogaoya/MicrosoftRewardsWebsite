// @vitest-environment node
// Background scheduling needs no DOM; node avoids the esbuild/jsdom clash that
// WXT's `#imports` transform triggers (same reason as searchRunner.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  handleDailyCheckAlarm,
  handleInstallOrUpdate,
  handleStartup,
  runRewards,
  scheduleDailyCheckAlarm,
  stopRewards,
} from './dailySchedule';
import { openDailyRewards } from './dailyRewards';
import { beginRun, requestStop } from './taskRun';
import { getStorageItem, setStorageItem, setStorageItems } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { localDateId } from '@/entrypoints/utils/localDate';
import { ATTEMPTS_KEY, MIGRATION_KEY, PROGRESS_KEY, RESULTS_KEY, RUN_KEY, type RunProgress, type TaskAttempts, type TaskResults, type TaskRunState } from '@/entrypoints/utils/runState';

const DASHBOARD_URL = 'https://rewards.bing.com/dashboard';

// Several browser events the production code listens on are unimplemented stubs
// in fake-browser: calling addListener throws. This replaces one of them with a
// list the test can fire, and restores it afterwards is unnecessary because
// fakeBrowser.reset() runs before every test.
function captureListeners(target: object, method: string): Array<(...args: unknown[]) => void> {
  const listeners: Array<(...args: unknown[]) => void> = [];
  vi.spyOn(target as Record<string, (...args: unknown[]) => unknown>, method).mockImplementation((listener: unknown) => {
    listeners.push(listener as (...args: unknown[]) => void);
  });
  return listeners;
}

function trackCreatedTabs(): string[] {
  const urls: string[] = [];
  vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async (info: any) => {
    urls.push(String(info.url));
    return { id: urls.length } as any;
  });
  return urls;
}

// The daily-set run is deliberately fire-and-forget, so it is still mid-flight
// when runRewards resolves; let its pending work settle before asserting on tabs.
// One timer turn is not enough: finish() closes the tab and only then writes the
// result, and each of those is its own microtask.
async function flushPendingWork(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

async function seed(values: Record<string, unknown>): Promise<void> {
  await setStorageItems(
    { active: true, autoDaily: true, autoRunEnabled: true, searches: 5, timeout: 60, closeTime: 5, ...values },
    StorageValues.SYNC
  );
}

describe('runRewards', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // The daily-set flow arms long safety timers that nothing in these tests
    // waits on; fake timers keep them from holding the run open.
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  // Regression: runRewards used to `await openDailyRewards()`, whose load promise
  // only resolved on the dashboard tab reporting "complete". A dashboard closed by
  // the user, removed by our own safety timer, or lost to a torn-down MV3 service
  // worker left that promise pending forever, so startSearches was never reached
  // and not a single search ran all day.
  it('starts the searches even when the dashboard never reports "complete"', async () => {
    const urls = trackCreatedTabs();
    await seed({});

    await runRewards();
    await flushPendingWork();

    expect(urls).toContain(DASHBOARD_URL);
    expect(urls.some((url) => url.startsWith('https://www.bing.com/search?q='))).toBe(true);
    expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.isSearching).toBe(true);
  });

  // Regression: startSearches was awaited with no catch, so a failing tab open
  // left the search result `running` and the run record blocking every later
  // start. The dashboard half must survive it.
  it('settles the search task as failed when starting searches throws', async () => {
    vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async (info: any) => {
      if (String(info.url).startsWith('https://www.bing.com/search?q=')) throw new Error('tab creation failed');
      return { id: 1 } as any;
    });
    await seed({ autoDaily: false });

    await expect(runRewards()).resolves.toBeUndefined();
    await flushPendingWork();

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.search?.status).toBe('failed');
    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
  });

  it('opens no dashboard when "Daily set" is off, but still searches', async () => {
    const urls = trackCreatedTabs();
    await seed({ autoDaily: false });

    await runRewards();
    await flushPendingWork();

    expect(urls).not.toContain(DASHBOARD_URL);
    expect(urls.some((url) => url.startsWith('https://www.bing.com/search?q='))).toBe(true);
  });

  it('runs no searches when "Daily searches" is off, but still opens the dashboard', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: false });

    await runRewards();
    await flushPendingWork();

    expect(urls).toEqual([DASHBOARD_URL]);
    expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.isSearching).not.toBe(true);
  });

  // "Claim points" is the second job on the same dashboard tab, so it has to be
  // able to open that tab on its own — a user who only wants their points
  // claimed should not have to enable the daily set to get it.
  it('opens the dashboard for "Claim points" alone', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: false, autoDaily: false, claimPoints: true });

    await runRewards();
    await flushPendingWork();

    expect(urls).toEqual([DASHBOARD_URL]);
  });

  // One tab covers both jobs: two would fight over the foreground, and the SPA
  // only renders while visible.
  it('opens a single dashboard when both dashboard jobs are on', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: false, autoDaily: true, claimPoints: true });

    await runRewards();
    await flushPendingWork();

    expect(urls).toEqual([DASHBOARD_URL]);
  });

  it('still runs the selected tasks when auto-run is off', async () => {
    const urls = trackCreatedTabs();
    await seed({ autoRunEnabled: false });

    await runRewards({ manual: true });
    await flushPendingWork();

    expect(urls).toContain(DASHBOARD_URL);
    expect(urls.some((url) => url.startsWith('https://www.bing.com/search?q='))).toBe(true);
  });

  it('keeps a finished search when the dashboard fails on its own', async () => {
    vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async (info: any) => {
      if (String(info.url) === DASHBOARD_URL) throw new Error('dashboard unavailable');
      return { id: 1 } as any;
    });
    await seed({ autoDaily: true, claimPoints: false });

    await runRewards({ manual: true });
    await flushPendingWork();

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.search?.status).toBe('running');
    expect(results?.daily?.status).toBe('failed');
    expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.isSearching).toBe(true);
  });

  it('opens nothing when every toggle is off', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: false, autoDaily: false, claimPoints: false });

    await runRewards();
    await flushPendingWork();

    expect(urls).toEqual([]);
  });
});

describe('handleStartup', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  // The automatic daily run is the path users actually hit, so the "Daily set"
  // toggle has to be honoured there too, not just on the popup's button.
  it('opens no dashboard on the automatic daily run when "Daily set" is off', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: true, autoDaily: false });

    await handleStartup();
    await flushPendingWork();

    expect(urls).not.toContain(DASHBOARD_URL);
    expect(urls.some((url) => url.startsWith('https://www.bing.com/search?q='))).toBe(true);
  });

  it('opens the dashboard on the automatic daily run when "Daily set" is on', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: false, autoDaily: true });

    await handleStartup();
    await flushPendingWork();

    expect(urls).toEqual([DASHBOARD_URL]);
  });

  it('drops a tab registry left over from the previous session', async () => {
    // Both toggles off, so no run starts and re-registers tabs of its own.
    await seed({ active: false, autoDaily: false });
    await setStorageItems({ trackedTabs: { 7: 1 } }, StorageValues.LOCAL);

    await handleStartup();

    expect(await getStorageItem('trackedTabs', StorageValues.LOCAL)).toEqual({});
  });

  // The once-per-day gate used to only get re-checked on the next browser
  // restart; arming this alarm on startup is what lets it fire again on its own.
  it('arms the daily-check alarm when a daily feature is enabled', async () => {
    trackCreatedTabs();
    await seed({});

    await handleStartup();

    expect(await fakeBrowser.alarms.get('dailyCheck')).toBeDefined();
  });

  it('does not arm the daily-check alarm when auto-run is on but no task is selected', async () => {
    trackCreatedTabs();
    await seed({ active: false, autoDaily: false, claimPoints: false, autoRunEnabled: true });

    await handleStartup();

    expect(await fakeBrowser.alarms.get('dailyCheck')).toBeUndefined();
  });

  it('closes a run left over from before the restart, then starts a new one', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: true, autoDaily: false, claimPoints: false });
    await setStorageItems({
      taskRun: { id: 5, phase: 'running', search: true, daily: false, claim: false },
      taskResults: { search: { status: 'running' } },
      taskProgress: { opened: 2, total: 5, isSearching: true },
    }, StorageValues.LOCAL);

    await handleStartup();
    await flushPendingWork();

    expect(urls.some((url) => url.startsWith('https://www.bing.com/search?q='))).toBe(true);
    const run = await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL);
    expect(run?.id).not.toBe(5);
    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.search?.status).toBe('running');
  });

  it('does not start a round on startup when auto-run is off', async () => {
    const urls = trackCreatedTabs();
    await seed({ autoRunEnabled: false });

    await handleStartup();
    await flushPendingWork();

    expect(urls).toEqual([]);
  });
});

describe('handleInstallOrUpdate', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  // "Open first result" navigates the search tab off the Bing results page, which
  // risks the search not being credited, so a fresh install must start with it off.
  it('seeds a new install with "open first result" disabled', async () => {
    const urls = trackCreatedTabs();

    await handleInstallOrUpdate({ reason: 'install' });
    await vi.runAllTimersAsync();

    expect(urls).toEqual([]);

    expect(await getStorageItem<boolean>('openFirstResult', StorageValues.SYNC)).toBe(false);
  });

  // Claiming clicks through a real transaction on the account, so it is opt-in:
  // a fresh install must not start out pressing it.
  it('seeds a new install with "claim points" disabled', async () => {
    await handleInstallOrUpdate({ reason: 'install' });

    expect(await getStorageItem<boolean>('claimPoints', StorageValues.SYNC)).toBe(false);
  });

  it('seeds a new install with auto-run on, and does not write the old sync run keys', async () => {
    await handleInstallOrUpdate({ reason: 'install' });

    expect(await getStorageItem<boolean>('autoRunEnabled', StorageValues.SYNC)).toBe(true);
    expect(await getStorageItem('isSearching', StorageValues.SYNC)).toBeNull();
    expect(await getStorageItem('currentSearch', StorageValues.SYNC)).toBeNull();
    expect(await getStorageItem<number>(MIGRATION_KEY, StorageValues.LOCAL)).toBe(1);
  });
});

describe('scheduleDailyCheckAlarm', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('arms the alarm while a daily feature is enabled', async () => {
    await seed({});

    await scheduleDailyCheckAlarm();

    expect(await fakeBrowser.alarms.get('dailyCheck')).toBeDefined();
  });

  // Regression: every worker wake-up called alarms.create, which replaces the
  // pending alarm and restarts its six-hour period. A wake an hour later must
  // leave the schedule that was already armed exactly where it was.
  it('leaves an existing alarm on its original schedule', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-21T10:00:00Z'));
      await seed({});
      await scheduleDailyCheckAlarm();
      const armed = await fakeBrowser.alarms.get('dailyCheck');

      vi.setSystemTime(new Date('2026-08-21T11:00:00Z'));
      await scheduleDailyCheckAlarm();

      expect(await fakeBrowser.alarms.get('dailyCheck')).toEqual(armed);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recreates the alarm when it has gone missing', async () => {
    await seed({});
    await fakeBrowser.alarms.clear('dailyCheck');

    await scheduleDailyCheckAlarm();

    expect(await fakeBrowser.alarms.get('dailyCheck')).toBeDefined();
  });

  // "Claim points" alone (no daily set, no daily searches) still needs the
  // once-per-day gate to run, so it has to arm the alarm on its own too.
  it('arms the alarm when only "Claim points" is enabled', async () => {
    await seed({ active: false, autoDaily: false, claimPoints: true });

    await scheduleDailyCheckAlarm();

    expect(await fakeBrowser.alarms.get('dailyCheck')).toBeDefined();
  });

  // Regression: an alarm left armed from before the user disabled every daily
  // feature would keep waking the worker every few hours for nothing.
  it('clears an existing alarm once every daily feature is off', async () => {
    await seed({ active: false, autoDaily: false, claimPoints: false });
    fakeBrowser.alarms.create('dailyCheck', { periodInMinutes: 360 });

    await scheduleDailyCheckAlarm();

    expect(await fakeBrowser.alarms.get('dailyCheck')).toBeUndefined();
  });

  it('clears an existing alarm when auto-run is turned off', async () => {
    await seed({ autoRunEnabled: false });
    fakeBrowser.alarms.create('dailyCheck', { periodInMinutes: 360 });

    await scheduleDailyCheckAlarm();

    expect(await fakeBrowser.alarms.get('dailyCheck')).toBeUndefined();
  });
});

describe('handleDailyCheckAlarm', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('ignores alarms it does not own', async () => {
    const urls = trackCreatedTabs();
    await seed({ lastOpened: 'not a real date' });

    await handleDailyCheckAlarm({ name: 'someOtherAlarm' });
    await flushPendingWork();

    expect(urls).toEqual([]);
  });

  // This is the case a browser session that spans midnight without a restart
  // used to miss entirely: nothing but a restart ever re-ran checkLastOpened.
  it('runs the daily tasks when nothing has been attempted on this local day', async () => {
    const urls = trackCreatedTabs();
    await seed({});

    await handleDailyCheckAlarm({ name: 'dailyCheck' });
    await flushPendingWork();

    expect(urls).toContain(DASHBOARD_URL);
    const attempts = await getStorageItem<TaskAttempts>(ATTEMPTS_KEY, StorageValues.LOCAL);
    expect(attempts?.search).toBe(localDateId());
    expect(attempts?.daily).toBe(localDateId());
  });

  it('does not run a task again the same local day, whatever its result was', async () => {
    const urls = trackCreatedTabs();
    await seed({});
    const today = localDateId();
    await setStorageItem(ATTEMPTS_KEY, { search: today, daily: today }, StorageValues.LOCAL);

    await handleDailyCheckAlarm({ name: 'dailyCheck' });
    await flushPendingWork();

    expect(urls).toEqual([]);
  });

  it('lets a manual start run a task that was already attempted today', async () => {
    const urls = trackCreatedTabs();
    await seed({ autoDaily: false, claimPoints: false });
    await setStorageItem(ATTEMPTS_KEY, { search: localDateId() }, StorageValues.LOCAL);

    await runRewards({ manual: true });
    await flushPendingWork();

    expect(urls.some((url) => url.startsWith('https://www.bing.com/search?q='))).toBe(true);
  });

  it('retries only the task that was asked for', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: true, autoDaily: true, claimPoints: false });

    await runRewards({ manual: true, only: ['daily'] });
    await flushPendingWork();

    expect(urls).toEqual([DASHBOARD_URL]);
    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.daily?.status).toBe('running');
    expect(results?.search).toBeUndefined();
  });

  it('ends a dashboard that never reports, and keeps the reason', async () => {
    vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({ id: 7 } as any);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([]);
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const run = await beginRun(['daily'], { searches: 5, timeout: 60, closeTime: 5 });

    const pending = openDailyRewards(run.id, { doDailySet: true, doClaim: false });
    await vi.advanceTimersByTimeAsync(90000);
    await pending;
    await flushPendingWork();

    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.daily?.status).toBe('unconfirmed');
    expect(results?.daily?.reason).toBeTruthy();
  });

  it('ends the round when the dashboard is closed before it loads', async () => {
    // fake-browser's tabs.onRemoved.addListener throws, so it is replaced before
    // the run registers. The replacement is what the production code calls.
    const removed = captureListeners(fakeBrowser.tabs.onRemoved, 'addListener');
    vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({ id: 7 } as any);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([]);
    vi.spyOn(fakeBrowser.tabs.onRemoved, 'removeListener').mockImplementation(() => {});
    const run = await beginRun(['daily'], { searches: 5, timeout: 60, closeTime: 5 });

    const pending = openDailyRewards(run.id, { doDailySet: true, doClaim: false });
    await vi.advanceTimersByTimeAsync(0);
    removed.forEach((listener) => listener(7));
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    await flushPendingWork();

    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
    expect((await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL))?.daily?.status).toBe('unconfirmed');
  });

  it('ends the round when the dashboard never finishes loading', async () => {
    vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({ id: 7 } as any);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([]);
    const run = await beginRun(['claim'], { searches: 5, timeout: 60, closeTime: 5 });

    const pending = openDailyRewards(run.id, { doDailySet: false, doClaim: true });
    await vi.advanceTimersByTimeAsync(30000);
    await pending;
    await flushPendingWork();

    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
    expect((await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL))?.claim?.status).toBe('unconfirmed');
  });

  it('ignores a dashboard result that names a different round', async () => {
    // fake-browser's runtime.onMessage.addListener throws. The spy collects the
    // listener the run registers and delivers messages with a sender, which is
    // what the run-id and tab-id check reads.
    const messages = captureListeners(fakeBrowser.runtime.onMessage, 'addListener');
    vi.spyOn(fakeBrowser.runtime.onMessage, 'removeListener').mockImplementation(() => {});
    vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({ id: 7 } as any);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([]);
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const run = await beginRun(['claim'], { searches: 5, timeout: 60, closeTime: 5 });

    const pending = openDailyRewards(run.id, { doDailySet: false, doClaim: true });
    await vi.advanceTimersByTimeAsync(300);
    messages.forEach((listener) => listener(
      { action: 'dashboardDone', runId: run.id + 1, claim: { status: 'completed' } },
      { tab: { id: 7 } }
    ));
    await vi.advanceTimersByTimeAsync(0);

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.claim?.status).toBe('running');

    messages.forEach((listener) => listener(
      { action: 'dashboardDone', runId: run.id, claim: { status: 'unconfirmed', reason: '已点击，未出现完成状态' } },
      { tab: { id: 7 } }
    ));
    messages.forEach((listener) => listener(
      { action: 'dashboardDone', runId: run.id, claim: { status: 'completed' } },
      { tab: { id: 7 } }
    ));
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    await flushPendingWork();

    const settled = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(settled?.claim).toEqual({ status: 'unconfirmed', reason: '已点击，未出现完成状态' });
  });

  // Regression: stop settled every task kind, and a missing result counted as
  // unresolved. A search-only stop therefore wrote `cancelled` for daily and
  // claim, and the popup offered to retry tasks that had not run.
  it('cancels only the tasks this round actually started', async () => {
    const run = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });

    await stopRewards();

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.search).toEqual({ status: 'cancelled', reason: '已停止' });
    expect(results?.daily).toBeUndefined();
    expect(results?.claim).toBeUndefined();
    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
    expect(run.id).toBeGreaterThan(0);
  });

  it('cancels an in-flight dashboard task without inventing the one that was off', async () => {
    await beginRun(['search', 'daily'], { searches: 5, timeout: 60, closeTime: 5 });

    await stopRewards();

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.search).toEqual({ status: 'cancelled', reason: '已停止' });
    expect(results?.daily).toEqual({ status: 'cancelled', reason: '已停止' });
    expect(results?.claim).toBeUndefined();
    const state = await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL);
    expect(state?.daily).toBe(true);
    expect(state?.search).toBe(false);
  });

  // Regression: the dashboard tab is untracked before its flags are cleared.
  // With search still running and its own tabs already gone, that used to drop
  // the sweep alarm, so a later worker death left the round blocking every start.
  it('keeps the tab sweep armed when the dashboard finishes during a search', async () => {
    vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({ id: 7 } as any);
    vi.spyOn(fakeBrowser.tabs, 'get').mockResolvedValue({ id: 7 } as any);
    vi.spyOn(fakeBrowser.tabs, 'remove').mockResolvedValue(undefined);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([]);
    const messages = captureListeners(fakeBrowser.runtime.onMessage, 'addListener');
    vi.spyOn(fakeBrowser.runtime.onMessage, 'removeListener').mockImplementation(() => {});
    const run = await beginRun(['search', 'daily'], { searches: 5, timeout: 60, closeTime: 5 });

    const pending = openDailyRewards(run.id, { doDailySet: true, doClaim: false });
    for (let i = 0; i < 20 && messages.length === 0; i++) await vi.advanceTimersByTimeAsync(0);
    expect(messages.length).toBeGreaterThan(0);
    messages.forEach((listener) => listener(
      { action: 'dashboardDone', runId: run.id, daily: { status: 'completed' } },
      { tab: { id: 7 } }
    ));
    await vi.advanceTimersByTimeAsync(0);
    await flushPendingWork();
    await pending;

    const state = await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL);
    expect(state?.search).toBe(true);
    expect(state?.daily).toBe(false);
    expect((await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL))?.daily?.status).toBe('completed');
    expect(await fakeBrowser.alarms.get('closeStaleTabs')).toBeDefined();
  });

  it('records a stop as cancelled even when the dashboard then reports completed', async () => {
    vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({ id: 7 } as any);
    vi.spyOn(fakeBrowser.tabs, 'get').mockResolvedValue({ id: 7 } as any);
    vi.spyOn(fakeBrowser.tabs, 'remove').mockResolvedValue(undefined);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([]);
    const messages = captureListeners(fakeBrowser.runtime.onMessage, 'addListener');
    vi.spyOn(fakeBrowser.runtime.onMessage, 'removeListener').mockImplementation(() => {});
    const run = await beginRun(['daily', 'claim'], { searches: 5, timeout: 60, closeTime: 5 });

    const pending = openDailyRewards(run.id, { doDailySet: true, doClaim: true });
    await requestStop();
    // The page answers after the stop, and claims both jobs completed. A script
    // on that page must not be able to turn the cancelled round into a success.
    messages.forEach((listener) => listener(
      { action: 'dashboardDone', runId: run.id, daily: { status: 'completed' }, claim: { status: 'completed' } },
      { tab: { id: 7 } }
    ));
    await vi.advanceTimersByTimeAsync(250);
    await flushPendingWork();
    await pending;

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.daily).toEqual({ status: 'cancelled', reason: '已停止' });
    expect(results?.claim).toEqual({ status: 'cancelled', reason: '已停止' });
    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
  });

  it('runs again once the attempt date is no longer today', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: false, autoDaily: true, claimPoints: false });
    await setStorageItem(ATTEMPTS_KEY, { daily: '2000-01-01' }, StorageValues.LOCAL);

    await handleDailyCheckAlarm({ name: 'dailyCheck' });
    await flushPendingWork();

    expect(urls).toEqual([DASHBOARD_URL]);
    expect((await getStorageItem<TaskAttempts>(ATTEMPTS_KEY, StorageValues.LOCAL))?.daily).toBe(localDateId());
  });

  it('does not resume a round from the old sync run keys', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: false, autoDaily: false, isSearching: true, currentSearch: 3 });

    await handleStartup();
    await flushPendingWork();

    expect(urls).toEqual([]);
    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
  });
});
