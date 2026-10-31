// @vitest-environment node
// Background search runner needs no DOM; node avoids the esbuild/jsdom clash
// that WXT's `#imports` transform triggers (same reason as useStorage.test.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { handleAlarmStep, startSearches, stopSearches } from './searchRunner';
import { beginRun, endRun, requestStop } from './taskRun';
import { getStorageItem, setStorageItem, setStorageItems } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { PROGRESS_KEY, RUN_KEY, type RunProgress, type TaskRunState } from '@/entrypoints/utils/runState';

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
});
