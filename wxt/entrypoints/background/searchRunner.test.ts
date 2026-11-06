// @vitest-environment node
// Background search runner needs no DOM; node avoids the esbuild/jsdom clash
// that WXT's `#imports` transform triggers (same reason as useStorage.test.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { finishSearch, handleAlarmStep, mayOpenFirstResult, startSearches, stopSearches } from './searchRunner';
import { stopRewards } from './dailySchedule';
import { beginRun, endRun, noteSearchTab, readSearchGrants, requestStop } from './taskRun';
import { FIRST_RESULT_NAV_WINDOW_MS } from '@/entrypoints/utils/firstResult';
import { getStorageItem, setStorageItem, setStorageItems } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { PROGRESS_KEY, RESULTS_KEY, RUN_KEY, type RunProgress, type TaskResults, type TaskRunState } from '@/entrypoints/utils/runState';

// The alarm names the round and the step it was armed for, so a firing can be
// attributed to exactly one step of one round. `startRound` returns the id the
// alarm has to carry.
function stepAlarm(runId: number, step: number): { name: string } {
  return { name: `openTabAlarm:${runId}:${step}` };
}

async function seed(values: Record<string, unknown>): Promise<void> {
  await setStorageItems(
    { active: true, searches: 5, timeout: 60, closeTime: 5, openFirstResult: false, ...values },
    StorageValues.SYNC
  );
}

// A search step only runs inside a round, and it reads the count, gap and close
// time from the snapshot that round froze — not from the live settings.
async function startRound(opened = 0): Promise<number> {
  const run = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
  if (opened > 0) {
    await setStorageItem(PROGRESS_KEY, { opened, total: 5, isSearching: true }, StorageValues.LOCAL);
  }
  return run.id;
}

describe('searchRunner', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  describe('startSearches', () => {
    it('opens the first tab and records progress as 1', async () => {
      const create = vi.spyOn(fakeBrowser.tabs, 'create');
      await seed({});

      const run = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
      await startSearches(run.id, { searches: 5, timeout: 60, closeTime: 5 });

      expect(create).toHaveBeenCalledTimes(1);
      expect(await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL)).toMatchObject({
        opened: 1,
        isSearching: true,
      });
    });
  });

  describe('handleAlarmStep', () => {
    it('ignores alarms it does not own', async () => {
      const create = vi.spyOn(fakeBrowser.tabs, 'create');
      await seed({ currentSearch: 1 });

      await handleAlarmStep({ name: 'someOtherAlarm' });

      expect(create).not.toHaveBeenCalled();
    });

    it('opens the next tab and advances the recorded progress', async () => {
      const create = vi.spyOn(fakeBrowser.tabs, 'create');
      await seed({});
      const runId = await startRound(1);

      await handleAlarmStep(stepAlarm(runId, 2));

      expect(create).toHaveBeenCalledTimes(1);
      expect(await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL)).toMatchObject({
        opened: 2,
        isSearching: true,
      });
    });

    it('records the final search before ending the run', async () => {
      // Regression: the last step used to end the run without storing the count,
      // so the popup froze at 4/5 even though 5 searches had run.
      await seed({});
      const runId = await startRound(4);

      await handleAlarmStep(stepAlarm(runId, 5));

      const progress = await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL);
      expect(progress?.opened).toBe(5);
      expect(progress?.isSearching).toBe(false);
    });

    it('opens no more tabs once every search has run', async () => {
      const create = vi.spyOn(fakeBrowser.tabs, 'create');
      await seed({});
      const runId = await startRound(5);

      await handleAlarmStep(stepAlarm(runId, 6));

      expect(create).not.toHaveBeenCalled();
      expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.isSearching).toBe(false);
    });

    // Regression: a later step whose tab open threw used to reject straight out
    // of the alarm handler, leaving the result `running`, the flag up, the badge
    // and the round's armed alarm behind. Every ending now settles through one
    // end step, and the failure names the round it belongs to.
    it('settles the round as failed when a later step throws', async () => {
      vi.spyOn(fakeBrowser.tabs, 'create').mockRejectedValueOnce(new Error('tab creation failed'));
      await seed({});
      const runId = await startRound(1);
      await fakeBrowser.action.setBadgeText({ text: '1' });
      fakeBrowser.alarms.create(`openTabAlarm:${runId}:2`, { delayInMinutes: 1 });

      await handleAlarmStep(stepAlarm(runId, 2));

      expect(await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL)).toEqual({
        search: { status: 'failed', reason: 'tab creation failed' },
      });
      expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.isSearching).toBe(false);
      expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
      expect(await fakeBrowser.action.getBadgeText({})).toBe('');
      expect(await fakeBrowser.alarms.getAll()).toEqual([]);
    });

    it('stops instead of searching when "Daily searches" is turned off', async () => {
      // Regression: an alarm scheduled while the toggle was on kept opening Bing
      // tabs after the user unchecked it (alarms survive a browser restart), so
      // a daily-set-only setup still made searches.
      const create = vi.spyOn(fakeBrowser.tabs, 'create');
      await seed({ active: false });
      const runId = await startRound(1);

      await handleAlarmStep(stepAlarm(runId, 2));

      expect(create).not.toHaveBeenCalled();
      expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.isSearching).toBe(false);
      expect(await fakeBrowser.alarms.getAll()).toEqual([]);
    });

    it('keeps using the count frozen at the start when the setting changes mid-run', async () => {
      const create = vi.spyOn(fakeBrowser.tabs, 'create');
      await seed({});
      const run = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
      await setStorageItem(PROGRESS_KEY, { opened: 1, total: 5, isSearching: true }, StorageValues.LOCAL);
      await setStorageItem('searches', 1, StorageValues.SYNC);

      await handleAlarmStep(stepAlarm(run.id, 2));

      expect(create).toHaveBeenCalledTimes(1);
      expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.opened).toBe(2);
      expect(run.started).toBe(true);
    });

    // Regression: the alarm used to carry no round, so an alarm armed by an
    // earlier round fired into whatever round was current and advanced its count.
    it("does not let an old round's alarm advance the new round", async () => {
      const create = vi.spyOn(fakeBrowser.tabs, 'create');
      await seed({});
      const first = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
      await requestStop();
      await endRun(first.id, 'search');
      const second = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
      await setStorageItem(PROGRESS_KEY, { opened: 1, total: 5, isSearching: true }, StorageValues.LOCAL);

      // The alarm the first round armed for its own step 2.
      await handleAlarmStep(stepAlarm(first.id, 2));

      expect(create).not.toHaveBeenCalled();
      expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.opened).toBe(1);
      expect((await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL))?.id).toBe(second.id);
    });

    // A firing that names a round which is not the current one is dropped.
    it('drops a firing whose round is no longer the current one', async () => {
      const create = vi.spyOn(fakeBrowser.tabs, 'create');
      await seed({});
      const run = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
      await setStorageItem(PROGRESS_KEY, { opened: 1, total: 5, isSearching: true }, StorageValues.LOCAL);

      await handleAlarmStep(stepAlarm(run.id + 1, 2));

      expect(create).not.toHaveBeenCalled();
      expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.opened).toBe(1);
    });

    // A firing for a step that is not the next one is stale: the other trigger
    // already consumed it, or it belongs to an older schedule.
    it('ignores a firing for a step that is not the next one', async () => {
      const create = vi.spyOn(fakeBrowser.tabs, 'create');
      await seed({});
      const run = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
      await setStorageItem(PROGRESS_KEY, { opened: 1, total: 5, isSearching: true }, StorageValues.LOCAL);

      await handleAlarmStep(stepAlarm(run.id, 3));

      expect(create).not.toHaveBeenCalled();
      expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.opened).toBe(1);
    });

    // A bare alarm name names no round, so it cannot be attributed to a step.
    it('ignores an alarm that carries no round', async () => {
      const create = vi.spyOn(fakeBrowser.tabs, 'create');
      await seed({});
      await startRound(1);

      await handleAlarmStep({ name: 'openTabAlarm' });

      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('finishSearch', () => {
    // Regression: the result write used to be awaited ahead of the cleanup
    // steps with nothing in between, so a transient failure of that one write
    // escaped before any of them — leaving the flag up, the badge on, the
    // alarms armed and the run record blocking every later start. The record
    // itself is now the one thing kept (see the re-entry test below): a result
    // that never landed must not leave a record saying nothing is running.
    it('still clears the flag, badge and alarms when the result write fails, but keeps the record', async () => {
      await seed({});
      const runId = await startRound(1);
      await fakeBrowser.action.setBadgeText({ text: '1' });
      fakeBrowser.alarms.create(`openTabAlarm:${runId}:2`, { delayInMinutes: 1 });
      const set = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local);
      vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementation(async (items) => {
        if (Object.keys(items ?? {}).some((key) => key.includes('taskResults'))) {
          throw new Error('results write failed');
        }
        await set(items);
      });

      await expect(finishSearch(runId, { status: 'completed' })).rejects.toThrow('results write failed');

      expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.isSearching).toBe(false);
      expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).not.toBeNull();
      expect(await fakeBrowser.alarms.getAll()).toEqual([]);
      expect(await fakeBrowser.action.getBadgeText({})).toBe('');
    });

    // Regression: endRun used to run whatever happened to the result write, so
    // a transient failure deleted the record while the result still said
    // 'running' — and the finishSearch that re-enters through runRewards'
    // catch then found no record and recorded nothing, so the search stayed
    // "running" (reported as not running, not retryable) until the next round
    // overwrote it. The record now survives the failed write, so the re-entry
    // settles both the result and the record.
    it('keeps the record when the result write fails, so the re-entering end settles it', async () => {
      await seed({});
      const runId = await startRound(1);
      let failedOnce = false;
      const set = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local);
      vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementation(async (items) => {
        if (!failedOnce && Object.keys(items ?? {}).some((key) => key.includes('taskResults'))) {
          failedOnce = true;
          throw new Error('results write failed');
        }
        await set(items);
      });

      // The first finishSearch loses its result write; the record it leaves
      // behind is what tells the popup a round is (un)settled and what lets
      // the re-entry below record on it.
      await expect(finishSearch(runId, { status: 'failed', reason: 'tab creation failed' })).rejects.toThrow('results write failed');
      expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).not.toBeNull();

      // What runRewards' catch does next: call the end step again.
      await finishSearch(runId, { status: 'failed', reason: 'tab creation failed' });

      expect(await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL)).toEqual({
        search: { status: 'failed', reason: 'tab creation failed' },
      });
      expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
    });

    // Regression: the cleanup inside the end step is global — the badge, the
    // short-step timer and every search alarm — while a late callback from a
    // stopped or replaced round is turned away by the runId guards in
    // recordResult and endRun. It used to run the global cleanup anyway, which
    // dropped the new round's armed alarm and stalled it.
    it("leaves the new round's flag, badge and alarm alone when a late callback ends an old round", async () => {
      await seed({});
      // A round is stopped and replaced while one of its steps is between the
      // claim and the end — the awaits in between are where the swap lands.
      const first = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
      await requestStop();
      await endRun(first.id, 'search');
      const second = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
      await setStorageItem(PROGRESS_KEY, { opened: 1, total: 5, isSearching: true }, StorageValues.LOCAL);
      await fakeBrowser.action.setBadgeText({ text: '1' });
      fakeBrowser.alarms.create(`openTabAlarm:${second.id}:2`, { delayInMinutes: 1 });

      await finishSearch(first.id, { status: 'completed' });

      expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.isSearching).toBe(true);
      expect(await fakeBrowser.action.getBadgeText({})).toBe('1');
      expect(await fakeBrowser.alarms.get(`openTabAlarm:${second.id}:2`)).toBeDefined();
    });
  });

  describe('stopSearches', () => {
    it('clears the running flag and any pending alarm', async () => {
      await seed({});
      await setStorageItem(PROGRESS_KEY, { opened: 1, total: 5, isSearching: true }, StorageValues.LOCAL);
      fakeBrowser.alarms.create('openTabAlarm', { delayInMinutes: 1 });

      await stopSearches();

      expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.isSearching).toBe(false);
      expect(await fakeBrowser.alarms.get('openTabAlarm')).toBeUndefined();
    });

    // Regression: this used to clearAll(), which also wiped the tab-cleanup
    // sweep and left every tab the run had opened on screen for good.
    it('leaves the tab-cleanup alarm running', async () => {
      await seed({ isSearching: true });
      fakeBrowser.alarms.create('closeStaleTabs', { periodInMinutes: 1 });

      await stopSearches();

      expect(await fakeBrowser.alarms.get('closeStaleTabs')).toBeDefined();
    });
  });

  describe('scheduling the next step', () => {
    // Regression: every gap was scheduled as an alarm, and Chrome rounds any
    // alarm under 30s up to 30s — so a user asking for 5s waited 30s.
    it('runs a sub-30s gap from an in-worker timer', async () => {
      vi.useFakeTimers();
      try {
        const create = vi.spyOn(fakeBrowser.tabs, 'create');
        await seed({});
        const run = await beginRun(['search'], { searches: 5, timeout: 5, closeTime: 5 });
        await setStorageItem(PROGRESS_KEY, { opened: 1, total: 5, isSearching: true }, StorageValues.LOCAL);
        expect(run.started).toBe(true);

        await handleAlarmStep(stepAlarm(run.id, 2));
        expect(create).toHaveBeenCalledTimes(1);

        // base 5s ±20% → the next search is due within 6s.
        await vi.advanceTimersByTimeAsync(6_000);

        expect(create).toHaveBeenCalledTimes(2);
        expect((await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL))?.opened).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    // The timer above dies with the service worker, so an alarm is armed at the
    // 30s platform minimum to resume the run rather than let it stall.
    it('still arms a backstop alarm for a sub-30s gap', async () => {
      await seed({});
      const run = await beginRun(['search'], { searches: 5, timeout: 5, closeTime: 5 });
      await setStorageItem(PROGRESS_KEY, { opened: 1, total: 5, isSearching: true }, StorageValues.LOCAL);

      const before = Date.now();
      await handleAlarmStep(stepAlarm(run.id, 2));

      const alarm = await fakeBrowser.alarms.get(`openTabAlarm:${run.id}:3`);
      // Armed at the 30s platform minimum, not at the 5s the timer handles.
      expect(alarm?.scheduledTime ?? 0).toBeGreaterThanOrEqual(before + 30_000);
    });

    it('leaves a 30s-or-longer gap to the alarm alone', async () => {
      vi.useFakeTimers();
      try {
        const create = vi.spyOn(fakeBrowser.tabs, 'create');
        await seed({});
        const run = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
        await setStorageItem(PROGRESS_KEY, { opened: 1, total: 5, isSearching: true }, StorageValues.LOCAL);

        await handleAlarmStep(stepAlarm(run.id, 2));
        await vi.advanceTimersByTimeAsync(120_000);

        expect(create).toHaveBeenCalledTimes(1);
        expect(await fakeBrowser.alarms.get(`openTabAlarm:${run.id}:3`)).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('search tab cleanup', () => {
    // A search tab's own close timer does not survive the service worker being
    // torn down, so every one is registered for the durable sweep as well.
    it('registers each search tab for the durable sweep', async () => {
      await seed({});

      const run = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
      await startSearches(run.id, { searches: 5, timeout: 60, closeTime: 5 });

      const tracked = await getStorageItem<Record<string, number>>('trackedTabs', StorageValues.LOCAL);
      expect(Object.keys(tracked ?? {})).toHaveLength(1);
      expect(await fakeBrowser.alarms.get('closeStaleTabs')).toBeDefined();
    });
  });

  describe('closing a marked tab', () => {
    // Regression: the close timer started at the results page's own load, so a
    // zero close time closed a marked tab 0–1s in — always before the
    // randomized 1.5–5.5s pause that precedes the first-result navigation,
    // which therefore never happened. A marked tab now gets its whole
    // navigation window ahead of the close timer.
    it('keeps a marked tab open through the navigation window at a zero close time', async () => {
      vi.useFakeTimers();
      try {
        await seed({ openFirstResult: true });
        const run = await beginRun(['search'], { searches: 1, timeout: 60, closeTime: 0 });
        let createdTabId: number | undefined;
        const create = fakeBrowser.tabs.create.bind(fakeBrowser.tabs);
        vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async (info: any) => {
          const tab = await create(info);
          createdTabId = tab.id;
          return tab;
        });
        const remove = vi.spyOn(fakeBrowser.tabs, 'remove').mockResolvedValue(undefined);

        await startSearches(run.id, { searches: 1, timeout: 60, closeTime: 0 });
        await fakeBrowser.tabs.onUpdated.trigger(createdTabId!, { status: 'complete' }, {} as any);

        // The sweep deadline carries the navigation window too (60s is the
        // runner's load allowance), so the durable sweep cannot close the tab
        // mid-navigate on a slow-loading page.
        const tracked = await getStorageItem<Record<string, number>>('trackedTabs', StorageValues.LOCAL);
        expect(tracked?.[String(createdTabId)] ?? 0).toBeGreaterThanOrEqual(
          Date.now() + FIRST_RESULT_NAV_WINDOW_MS + 60_000
        );

        // One second in — where the old zero close time had already closed it,
        // while the navigation cannot even have started (1.5s minimum).
        await vi.advanceTimersByTimeAsync(1_000);
        expect(remove).not.toHaveBeenCalled();

        // Past the whole navigation window the tab does close.
        await vi.advanceTimersByTimeAsync(FIRST_RESULT_NAV_WINDOW_MS + 1_500);
        expect(remove).toHaveBeenCalledWith(createdTabId);
      } finally {
        vi.useRealTimers();
      }
    });

    // The navigation window only delays a tab the marker was added to. With
    // the setting off nothing will navigate, so a zero close time still means
    // "close once loaded".
    it('closes an unmarked tab at the configured close time', async () => {
      vi.useFakeTimers();
      try {
        await seed({ openFirstResult: false });
        const run = await beginRun(['search'], { searches: 1, timeout: 60, closeTime: 0 });
        let createdTabId: number | undefined;
        const create = fakeBrowser.tabs.create.bind(fakeBrowser.tabs);
        vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async (info: any) => {
          const tab = await create(info);
          createdTabId = tab.id;
          return tab;
        });
        const remove = vi.spyOn(fakeBrowser.tabs, 'remove').mockResolvedValue(undefined);

        await startSearches(run.id, { searches: 1, timeout: 60, closeTime: 0 });
        await fakeBrowser.tabs.onUpdated.trigger(createdTabId!, { status: 'complete' }, {} as any);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(remove).toHaveBeenCalledWith(createdTabId);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('mayOpenFirstResult', () => {
    // The bing-result content script asks this before leaving the results page;
    // the opened tab is named in the run record when "Open first result" adds
    // the marker, so the check below has something to match against.
    it('names the marked tab in the run record when opening it', async () => {
      await seed({ openFirstResult: true });

      const runId = await startRound();
      await startSearches(runId, { searches: 5, timeout: 60, closeTime: 5 });

      const state = await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL);
      expect(state?.searchTabIds).toHaveLength(1);
    });

    // Regression: a failed registration left the created tab neither named in
    // the run record nor tracked for the sweep, so nothing would ever close it.
    // The tab is now removed as best effort before the error settles the round.
    it('closes the created tab when naming it in the run record fails', async () => {
      await seed({ openFirstResult: true });
      const runId = await startRound();
      let createdTabId: number | undefined;
      const create = fakeBrowser.tabs.create.bind(fakeBrowser.tabs);
      vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async (info: any) => {
        const tab = await create(info);
        createdTabId = tab.id;
        return tab;
      });
      const remove = vi.spyOn(fakeBrowser.tabs, 'remove').mockResolvedValue(undefined);
      let registryBroken = true;
      const set = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local);
      vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementation(async (items) => {
        const keys = Object.keys(items ?? {});
        // noteSearchTab writes the run record on its own; break exactly that
        // write once, so the round can still be settled afterwards.
        if (registryBroken && keys.length === 1 && keys[0] === 'taskRun') {
          registryBroken = false;
          throw new Error('run record write failed');
        }
        await set(items);
      });

      await startSearches(runId, { searches: 5, timeout: 60, closeTime: 5 });

      expect(remove).toHaveBeenCalledWith(createdTabId);
      expect(await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL)).toEqual({
        search: { status: 'failed', reason: 'run record write failed' },
      });
      expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
    });

    // Regression: the tab used to be named only after the slower bookkeeping
    // that follows the create, so a results page that loaded through that
    // window asked before the round had named its tab — and the ask is
    // one-shot, so the navigation was skipped for good.
    it('names the tab before the bookkeeping that follows the create', async () => {
      await seed({ openFirstResult: true });
      const runId = await startRound();
      let createdTabId: number | undefined;
      const create = fakeBrowser.tabs.create.bind(fakeBrowser.tabs);
      vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async (info: any) => {
        const tab = await create(info);
        createdTabId = tab.id;
        return tab;
      });
      let asked: boolean | undefined;
      const set = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local);
      vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementation(async (items) => {
        await set(items);
        // The durable tab registration is the first of the slower writes that
        // follow the create; by the time it settles, the results page may
        // already be asking.
        if (Object.keys(items ?? {}).some((key) => key.includes('trackedTabs'))) {
          asked = await mayOpenFirstResult(createdTabId);
        }
      });

      await startSearches(runId, { searches: 5, timeout: 60, closeTime: 5 });

      expect(asked).toBe(true);
      expect((await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL))?.searchTabIds).toContain(createdTabId);
    });

    it('allows a tab this round opened while the setting is on', async () => {
      await seed({ openFirstResult: true });
      const runId = await startRound();
      await noteSearchTab(runId, 7);

      await expect(mayOpenFirstResult(7)).resolves.toBe(true);
    });

    // Regression: the last step finished the round the moment its tab opened,
    // and the finished round then refused the tab's second ask — so with the
    // setting on, the last tab of every round never navigated. The grant is
    // recorded outside the run record and outlives the schedule; only a stop
    // or a turned-off toggle revokes it.
    it('still allows the last tab once the round has finished', async () => {
      await seed({ openFirstResult: true });
      const runId = await startRound(4);
      let createdTabId: number | undefined;
      const create = fakeBrowser.tabs.create.bind(fakeBrowser.tabs);
      vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async (info: any) => {
        const tab = await create(info);
        createdTabId = tab.id;
        return tab;
      });

      await handleAlarmStep(stepAlarm(runId, 5));

      // The round is over — the record is gone with it — yet the tab it opened
      // may still be waiting to leave the results page.
      expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
      await expect(mayOpenFirstResult(createdTabId)).resolves.toBe(true);
    });

    // The one-search round is the extreme case: its first step is also its
    // last, so the old round check refused the round's only tab every time and
    // the option never worked at all.
    it('still allows the only tab of a one-search round', async () => {
      await seed({ openFirstResult: true });
      const run = await beginRun(['search'], { searches: 1, timeout: 60, closeTime: 5 });
      let createdTabId: number | undefined;
      const create = fakeBrowser.tabs.create.bind(fakeBrowser.tabs);
      vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async (info: any) => {
        const tab = await create(info);
        createdTabId = tab.id;
        return tab;
      });

      await startSearches(run.id, { searches: 1, timeout: 60, closeTime: 5 });

      expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
      await expect(mayOpenFirstResult(createdTabId)).resolves.toBe(true);
    });

    // Regression: the content script navigated on the ?marAuto marker alone, so
    // any Bing page carrying it — a bookmark, a copied link, a tab left over
    // from an earlier round — left the results page. Only a tab this round
    // opened may ask, and only the tab's own page can ask.
    it('refuses a tab this round did not open', async () => {
      await seed({ openFirstResult: true });
      const runId = await startRound();
      await noteSearchTab(runId, 7);

      await expect(mayOpenFirstResult(99)).resolves.toBe(false);
      await expect(mayOpenFirstResult(undefined)).resolves.toBe(false);
    });

    it('refuses once the round is stopping', async () => {
      await seed({ openFirstResult: true });
      const runId = await startRound();
      await noteSearchTab(runId, 7);
      await requestStop();

      await expect(mayOpenFirstResult(7)).resolves.toBe(false);
    });

    // Regression: a tab created while the round ran could be named only after a
    // stop landed — and past the stop's own revocation, which still had nothing
    // to clear. The grant that late naming wrote then outlived the dropped
    // record, and the ask was honoured long after the stop. A stopping round
    // now refuses the naming, the same guard claimStep and
    // writeProgressIfRunning use.
    it('leaves no grant for a tab named after the round was stopped', async () => {
      await seed({ openFirstResult: true });
      const runId = await startRound();
      await requestStop();
      // The naming arrives after the stop, like a tab whose create outlived
      // the stop click; the round's own revocation has already run.
      await noteSearchTab(runId, 7);
      await endRun(runId, 'search');

      expect(await readSearchGrants()).toEqual({});
      // The record is gone, so only the (absent) grant could have allowed it.
      await expect(mayOpenFirstResult(7)).resolves.toBe(false);
    });

    // A turned-off search toggle ends the round as cancelled through
    // finishSearch, and so does a sweep settling a stopped round: both revoke
    // the grants, so a tab still sitting on its results page stays there.
    it('refuses once the round was cancelled', async () => {
      await seed({ openFirstResult: true });
      const runId = await startRound();
      let createdTabId: number | undefined;
      const create = fakeBrowser.tabs.create.bind(fakeBrowser.tabs);
      vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async (info: any) => {
        const tab = await create(info);
        createdTabId = tab.id;
        return tab;
      });
      await startSearches(runId, { searches: 5, timeout: 60, closeTime: 5 });
      await expect(mayOpenFirstResult(createdTabId)).resolves.toBe(true);

      await finishSearch(runId, { status: 'cancelled', reason: '已关闭搜索' });

      await expect(mayOpenFirstResult(createdTabId)).resolves.toBe(false);
    });

    // A manual stop ends the round without finishSearch, so it revokes the
    // grants on its own.
    it('refuses once the user stopped the round', async () => {
      await seed({ openFirstResult: true });
      const run = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
      let createdTabId: number | undefined;
      const create = fakeBrowser.tabs.create.bind(fakeBrowser.tabs);
      vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async (info: any) => {
        const tab = await create(info);
        createdTabId = tab.id;
        return tab;
      });
      await startSearches(run.id, { searches: 5, timeout: 60, closeTime: 5 });

      await expect(stopRewards()).resolves.toEqual({ accepted: true });

      await expect(mayOpenFirstResult(createdTabId)).resolves.toBe(false);
    });

    it('refuses when no round is running', async () => {
      await seed({ openFirstResult: true });

      await expect(mayOpenFirstResult(7)).resolves.toBe(false);
    });

    // The setting is re-read at the moment of the ask, so turning it off while
    // a marked tab sits on the results page stops the navigation too.
    it('refuses after the setting was turned off', async () => {
      await seed({ openFirstResult: true });
      const runId = await startRound();
      await noteSearchTab(runId, 7);
      await setStorageItem('openFirstResult', false, StorageValues.SYNC);

      await expect(mayOpenFirstResult(7)).resolves.toBe(false);
    });
  });
});
