// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { clearTrackedTabs, isCleanupAlarm, sweepStaleTabs, trackTab, untrackTab } from './tabCleanup';
import { getStorageItem, setStorageItem, setStorageItems } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { RESULTS_KEY, RUN_KEY, type TaskResults, type TaskRunState } from '@/entrypoints/utils/runState';

const CLEANUP_ALARM = 'closeStaleTabs';

async function openTab(id: number): Promise<void> {
  await fakeBrowser.tabs.create({ url: `https://example.com/${id}` });
}

async function openTabIds(): Promise<number[]> {
  return (await fakeBrowser.tabs.query({})).map((tab) => tab.id!);
}

describe('tabCleanup', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('arms the sweep alarm as soon as a tab is tracked', async () => {
    await trackTab(1, 5000);

    expect(await fakeBrowser.alarms.get(CLEANUP_ALARM)).toBeDefined();
  });

  // The precise close runs on a setTimeout, which an MV3 service worker does not
  // keep alive. This sweep is what actually closes the tab when that timer is
  // lost, so a run no longer leaves Bing tabs piled up behind it.
  it('closes a tracked tab once its deadline has passed', async () => {
    await openTab(1);
    const [tabId] = await openTabIds();
    await trackTab(tabId, 5000);

    vi.setSystemTime(new Date('2026-08-21T10:00:06Z'));
    await sweepStaleTabs();

    expect(await openTabIds()).not.toContain(tabId);
  });

  it('settles a dashboard run once its tracked tab is past the deadline and gone', async () => {
    await fakeBrowser.tabs.create({ url: 'https://rewards.bing.com/' });
    const [tabId] = await openTabIds();
    await trackTab(tabId, 5000);
    await setStorageItems({
      [RUN_KEY]: { id: 9, phase: 'running', search: false, daily: true, claim: false, startedAt: Date.now(), dashboardTabId: tabId, dashboardDeadline: Date.now() + 5000 },
      [RESULTS_KEY]: { daily: { status: 'running' } },
    }, StorageValues.LOCAL);

    vi.setSystemTime(new Date('2026-08-21T10:01:40Z'));
    await sweepStaleTabs();

    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
    expect((await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL))?.daily?.status).toBe('unconfirmed');
  });

  // Regression: the sweep skipped `stopping`, so a stop whose in-worker cleanup
  // was lost left the record forever and every later start joined a dead round.
  it('settles a stopping round instead of leaving it hanging', async () => {
    await trackTab(4242, 1000);
    await setStorageItems({
      [RUN_KEY]: { id: 12, phase: 'stopping', search: true, daily: true, claim: false, startedAt: Date.now(), dashboardTabId: 4242, dashboardDeadline: Date.now() + 1000 },
      [RESULTS_KEY]: { search: { status: 'cancelled' }, daily: { status: 'running' } },
    }, StorageValues.LOCAL);

    vi.setSystemTime(new Date('2026-08-21T10:01:40Z'));
    await sweepStaleTabs();

    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
    expect((await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL))?.daily?.status).toBe('cancelled');
  });

  // Regression: the old check looked for any open Rewards page, so a dashboard
  // the user had open themselves kept the round from ever settling.
  it("ignores a Rewards page the user opened themselves", async () => {
    await fakeBrowser.tabs.create({ url: 'https://rewards.bing.com/' });
    await setStorageItems({
      [RUN_KEY]: { id: 13, phase: 'running', search: false, daily: true, claim: false, startedAt: Date.now(), dashboardTabId: 9999, dashboardDeadline: Date.now() - 1000 },
      [RESULTS_KEY]: { daily: { status: 'running' } },
    }, StorageValues.LOCAL);

    vi.setSystemTime(new Date('2026-08-21T10:01:40Z'));
    await sweepStaleTabs();

    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
    expect((await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL))?.daily?.status).toBe('unconfirmed');
  });

  // The round's own page is still open, so there is nothing to settle yet.
  it("keeps the round while its own dashboard page is still open", async () => {
    await fakeBrowser.tabs.create({ url: 'https://rewards.bing.com/dashboard' });
    const [tabId] = await openTabIds();
    await setStorageItems({
      [RUN_KEY]: { id: 14, phase: 'running', search: false, daily: true, claim: false, startedAt: Date.now(), dashboardTabId: tabId, dashboardDeadline: Date.now() - 1000 },
      [RESULTS_KEY]: { daily: { status: 'running' } },
    }, StorageValues.LOCAL);

    vi.setSystemTime(new Date('2026-08-21T10:01:40Z'));
    await sweepStaleTabs();

    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).not.toBeNull();
    expect((await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL))?.daily?.status).toBe('running');
  });

  // Regression: a stopping round that only had searches held no dashboard
  // record, so it was skipped entirely and blocked every later start.
  it('settles a stopping round that only had searches', async () => {
    await setStorageItems({
      [RUN_KEY]: { id: 16, phase: 'stopping', search: true, daily: false, claim: false, startedAt: Date.now() },
      [RESULTS_KEY]: { search: { status: 'running' } },
    }, StorageValues.LOCAL);

    vi.setSystemTime(new Date('2026-08-21T10:05:00Z'));
    await sweepStaleTabs();

    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
    expect((await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL))?.search?.status).toBe('cancelled');
  });

  // Regression: a search-only round whose worker died between opening a tab and
  // arming the next step left a `running` record that blocked every later start.
  it('settles a search-only round whose next step never came', async () => {
    await setStorageItems({
      [RUN_KEY]: {
        id: 17, phase: 'running', search: true, daily: false, claim: false,
        startedAt: Date.now(), searchDeadline: Date.now() - 1000,
      },
      [RESULTS_KEY]: { search: { status: 'running' } },
    }, StorageValues.LOCAL);

    vi.setSystemTime(new Date('2026-08-21T10:05:00Z'));
    await sweepStaleTabs();

    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
    expect((await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL))?.search?.status).toBe('unconfirmed');
  });

  // The step is still due, so the round is waiting rather than abandoned.
  it('keeps a search round whose next step is still due', async () => {
    await setStorageItems({
      [RUN_KEY]: {
        id: 18, phase: 'running', search: true, daily: false, claim: false,
        startedAt: Date.now(), searchDeadline: Date.now() + 60000,
      },
      [RESULTS_KEY]: { search: { status: 'running' } },
    }, StorageValues.LOCAL);

    await sweepStaleTabs();

    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).not.toBeNull();
  });

  // A sweep that has nothing left to close must stay armed while a search round
  // still needs it, or the orphaned record could never be settled.
  it('keeps the sweep alarm while a search-only round is in flight', async () => {
    await setStorageItems({
      [RUN_KEY]: {
        id: 19, phase: 'running', search: true, daily: false, claim: false,
        startedAt: Date.now(), searchDeadline: Date.now() + 60000,
      },
    }, StorageValues.LOCAL);

    await sweepStaleTabs();

    expect(await fakeBrowser.alarms.get(CLEANUP_ALARM)).toBeDefined();
  });

  // A round whose dashboard tab was never recorded is judged on its own start
  // time, so a round that just began is never mistaken for an abandoned one.
  it('does not settle a round that started a moment ago', async () => {
    await setStorageItems({
      [RUN_KEY]: { id: 15, phase: 'running', search: false, daily: true, claim: false, startedAt: Date.now() },
      [RESULTS_KEY]: { daily: { status: 'running' } },
    }, StorageValues.LOCAL);

    await sweepStaleTabs();

    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).not.toBeNull();
  });

  it('does not settle a legacy round without startedAt before its fallback deadline', async () => {
    const startedFromId = Date.now();
    await setStorageItems({
      [RUN_KEY]: { id: startedFromId, phase: 'running', search: false, daily: true, claim: false } as unknown as TaskRunState,
      [RESULTS_KEY]: { daily: { status: 'running' } },
    }, StorageValues.LOCAL);

    vi.setSystemTime(new Date(startedFromId + 1000));
    await sweepStaleTabs();

    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).not.toBeNull();
    expect((await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL))?.daily?.status).toBe('running');
  });

  it('leaves a tracked tab alone while its deadline is in the future', async () => {
    await openTab(1);
    const [tabId] = await openTabIds();
    await trackTab(tabId, 60000);

    vi.setSystemTime(new Date('2026-08-21T10:00:06Z'));
    await sweepStaleTabs();

    expect(await openTabIds()).toContain(tabId);
    expect(await fakeBrowser.alarms.get(CLEANUP_ALARM)).toBeDefined();
  });

  it('stops sweeping once nothing is tracked any more', async () => {
    await openTab(1);
    const [tabId] = await openTabIds();
    await trackTab(tabId, 5000);

    vi.setSystemTime(new Date('2026-08-21T10:00:06Z'));
    await sweepStaleTabs();

    expect(await fakeBrowser.alarms.get(CLEANUP_ALARM)).toBeUndefined();
  });

  it('does not close a tab that was untracked after closing itself on time', async () => {
    await openTab(1);
    const [tabId] = await openTabIds();
    await trackTab(tabId, 5000);
    await untrackTab(tabId);

    vi.setSystemTime(new Date('2026-08-21T10:00:06Z'));
    await sweepStaleTabs();

    expect(await openTabIds()).toContain(tabId);
    expect(await fakeBrowser.alarms.get(CLEANUP_ALARM)).toBeUndefined();
  });

  it('survives a tab that is already gone', async () => {
    await trackTab(4242, 5000);

    vi.setSystemTime(new Date('2026-08-21T10:00:06Z'));

    await expect(sweepStaleTabs()).resolves.toBeUndefined();
  });

  // Tab ids do not survive a browser restart, so anything carried over from the
  // previous session points at tabs that no longer exist.
  it('drops the whole registry on request', async () => {
    await openTab(1);
    const [tabId] = await openTabIds();
    await trackTab(tabId, 5000);

    await clearTrackedTabs();
    vi.setSystemTime(new Date('2026-08-21T10:00:06Z'));
    await sweepStaleTabs();

    expect(await openTabIds()).toContain(tabId);
    expect(await fakeBrowser.alarms.get(CLEANUP_ALARM)).toBeUndefined();
  });

  it('recognises only its own alarm', () => {
    expect(isCleanupAlarm(CLEANUP_ALARM)).toBe(true);
    expect(isCleanupAlarm('openTabAlarm')).toBe(false);
  });

  // Regression: track/untrack/sweep each read the registry, await, then write the
  // whole snapshot back. Two overlapping writes used to let the older snapshot
  // replace the newer one, so a tab registered in between was lost and never closed.
  describe('overlapping registry writes', () => {
    let gates: Array<(resume: () => void) => void>;

    beforeEach(() => {
      gates = [];
      const realGet = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local);
      vi.spyOn(fakeBrowser.storage.local, 'get').mockImplementation((keys: any) => {
        const pending = realGet(keys);
        if (gates.length === 0) return pending;
        const release = gates.shift()!;
        return pending.then((value) => new Promise((resolve) => release(() => resolve(value))));
      });
    });

    // The next registry read pauses after it has its snapshot, until the test
    // lets it continue — so two operations can be held on the same old snapshot.
    function holdNextRead(): Promise<() => void> {
      return new Promise((resolve) => {
        gates.push(resolve);
      });
    }

    async function registry(): Promise<Record<string, number>> {
      return (await getStorageItem<Record<string, number>>('trackedTabs', StorageValues.LOCAL)) ?? {};
    }

    it('keeps both tabs when two registrations overlap', async () => {
      const firstHeld = holdNextRead();
      const secondHeld = holdNextRead();
      const first = trackTab(1, 5000);
      const second = trackTab(2, 5000);
      (await firstHeld)();
      (await secondHeld)();

      await Promise.all([first, second]);

      expect(Object.keys(await registry()).sort()).toEqual(['1', '2']);
    });

    it('keeps a tab registered while another is being untracked', async () => {
      await trackTab(1, 5000);
      const untrackHeld = holdNextRead();
      const trackHeld = holdNextRead();
      const dropping = untrackTab(1);
      const adding = trackTab(2, 5000);
      (await untrackHeld)();
      (await trackHeld)();

      await Promise.all([dropping, adding]);

      const ids = Object.keys(await registry());
      expect(ids).not.toContain('1');
      expect(ids).toContain('2');
    });

    it('keeps a tab registered while a sweep writes its snapshot back', async () => {
      await openTab(1);
      const [tabId] = await openTabIds();
      await trackTab(tabId, 5000);
      vi.setSystemTime(new Date('2026-08-21T10:00:06Z'));

      const sweepHeld = holdNextRead();
      const trackHeld = holdNextRead();
      const sweeping = sweepStaleTabs();
      const adding = trackTab(2, 60000);
      (await sweepHeld)();
      (await trackHeld)();

      await Promise.all([sweeping, adding]);

      const ids = Object.keys(await registry());
      expect(ids).not.toContain(String(tabId));
      expect(ids).toContain('2');
      expect(await openTabIds()).not.toContain(tabId);
    });
  });

  // Creating the sweep alarm on every registration resets its schedule. Once it
  // exists, further registrations only need to know it is still there.
  it('does not reschedule the sweep alarm when one is already armed', async () => {
    await trackTab(1, 5000);
    const alarm = await fakeBrowser.alarms.get(CLEANUP_ALARM);

    vi.setSystemTime(new Date('2026-08-21T10:00:30Z'));
    await trackTab(2, 5000);

    expect(await fakeBrowser.alarms.get(CLEANUP_ALARM)).toEqual(alarm);
  });

  it('reports a failed registration and still accepts the next one', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValueOnce(new Error('storage write failed'));

    await expect(trackTab(1, 5000)).rejects.toThrow('storage write failed');
    await trackTab(2, 5000);

    const tracked = await getStorageItem<Record<string, number>>('trackedTabs', StorageValues.LOCAL);
    expect(Object.keys(tracked ?? {})).toEqual(['2']);
  });

  it('leaves a tab the extension never registered open', async () => {
    await openTab(1);
    const [tabId] = await openTabIds();
    await setStorageItem('trackedTabs', { 4242: Date.now() - 1000 }, StorageValues.LOCAL);

    vi.setSystemTime(new Date('2026-08-21T10:00:06Z'));
    await sweepStaleTabs();

    expect(await openTabIds()).toContain(tabId);
  });
});
