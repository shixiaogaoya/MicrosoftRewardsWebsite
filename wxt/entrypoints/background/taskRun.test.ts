// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { getStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { RESULTS_KEY, RUN_KEY, type TaskResults, type TaskRunState } from '@/entrypoints/utils/runState';
import { beginRun, endRun, recordResult, requestStop, writeProgressIfRunning } from './taskRun';
import { PROGRESS_KEY, type RunProgress } from '@/entrypoints/utils/runState';

describe('recordResult', () => {
  beforeEach(() => fakeBrowser.reset());

  it('keeps the first settled result and ignores a repeat', async () => {
    const run = await beginRun(['claim'], { searches: 5, timeout: 60, closeTime: 5 });

    expect(await recordResult(run.id, 'claim', { status: 'unconfirmed', reason: '已点击，未出现完成状态' })).toBe(true);
    expect(await recordResult(run.id, 'claim', { status: 'completed' })).toBe(false);

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.claim).toEqual({ status: 'unconfirmed', reason: '已点击，未出现完成状态' });
  });

  it('rejects a result for a round that is no longer current', async () => {
    const first = await beginRun(['daily'], { searches: 5, timeout: 60, closeTime: 5 });
    await endRun(first.id, 'daily');
    const second = await beginRun(['daily'], { searches: 5, timeout: 60, closeTime: 5 });

    expect(await recordResult(first.id, 'daily', { status: 'completed' })).toBe(false);

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.daily?.status).toBe('running');
    expect((await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL))?.id).toBe(second.id);
  });
});

describe('writeProgressIfRunning', () => {
  beforeEach(() => fakeBrowser.reset());

  // Regression: the round was checked and the write queued separately, so a stop
  // or a new round could land in the gap and the stale step then overwrote the
  // new round's count.
  it('refuses to write once the round has been replaced', async () => {
    const first = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
    await requestStop();
    await endRun(first.id, 'search');
    const second = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
    await writeProgressIfRunning(second.id, { opened: 1, total: 5, isSearching: true });

    const written = await writeProgressIfRunning(first.id, { opened: 4, total: 5, isSearching: true });

    expect(written).toBe(false);
    expect(await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL)).toMatchObject({ opened: 1 });
  });

  it('refuses to write for a round that has been stopped', async () => {
    const run = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });
    await requestStop();

    const written = await writeProgressIfRunning(run.id, { opened: 3, total: 5, isSearching: true });

    expect(written).toBe(false);
  });

  it('writes for the live round', async () => {
    const run = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });

    const written = await writeProgressIfRunning(run.id, { opened: 2, total: 5, isSearching: true });

    expect(written).toBe(true);
    expect(await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL)).toMatchObject({ opened: 2 });
  });
});
