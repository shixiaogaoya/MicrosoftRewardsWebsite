// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { getStorageItem, setStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { RESULTS_KEY, RUN_KEY, type TaskResults, type TaskRunState } from '@/entrypoints/utils/runState';
import { abandonRun, beginRun, endRun, recordResult, requestStop, settleUnresolved, writeProgressIfRunning } from './taskRun';
import { PROGRESS_KEY, type RunProgress } from '@/entrypoints/utils/runState';

describe('recordResult', () => {
  beforeEach(() => fakeBrowser.reset());

  it('keeps the first settled result and ignores a repeat', async () => {
    const run = await beginRun(['claim'], { searches: 5, timeout: 60, closeTime: 5 });

    expect(await recordResult(run.id, 'claim', { status: 'unconfirmed', reason: '已点击，未出现完成状态' })).toBe(true);
    expect(await recordResult(run.id, 'claim', { status: 'completed' })).toBe(false);

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.claim).toMatchObject({ status: 'unconfirmed', reason: '已点击，未出现完成状态' });
    // The settled row names the round and the moment it was written, so the
    // popup can show which round a kept result came from and when.
    expect(results?.claim?.runId).toBe(run.id);
    expect(typeof results?.claim?.at).toBe('number');
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

describe('settleUnresolved', () => {
  beforeEach(() => fakeBrowser.reset());

  // Regression: a missing result was treated as unresolved, so stopping a
  // search-only round wrote `cancelled` for daily and claim. The popup then
  // listed tasks that never ran and offered to retry them.
  it('does not invent a result for a task this round never started', async () => {
    const run = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });

    await settleUnresolved(run.id, ['search', 'daily', 'claim'], { status: 'cancelled', reason: '已停止' });

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.search).toMatchObject({ status: 'cancelled', reason: '已停止' });
    expect(results?.search?.runId).toBe(run.id);
    expect(typeof results?.search?.at).toBe('number');
    expect(results?.daily).toBeUndefined();
    expect(results?.claim).toBeUndefined();
  });

  it('leaves a result that already settled', async () => {
    const run = await beginRun(['search', 'daily'], { searches: 5, timeout: 60, closeTime: 5 });
    await recordResult(run.id, 'daily', { status: 'completed' });

    await settleUnresolved(run.id, ['search', 'daily', 'claim'], { status: 'cancelled', reason: '已停止' });

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.daily).toMatchObject({ status: 'completed' });
    expect(results?.search).toMatchObject({ status: 'cancelled', reason: '已停止' });
    expect(results?.claim).toBeUndefined();
  });
});

// The stored results are each task's most recent outcome. A single-task retry
// is a round of its own that runs one task, and it must not wipe the other
// tasks' last results: after retrying the search, the daily and claim rows
// from the round that ran them stay readable, still naming that round.
describe('beginRun keeps the other tasks’ last results', () => {
  beforeEach(() => fakeBrowser.reset());

  it('keeps the previous round’s settled rows through a single-task round', async () => {
    const first = await beginRun(['search', 'daily', 'claim'], { searches: 5, timeout: 60, closeTime: 5 });
    await recordResult(first.id, 'daily', { status: 'completed' });
    await recordResult(first.id, 'claim', { status: 'not-needed' });
    await endRun(first.id, 'search');
    await endRun(first.id, 'daily');
    await endRun(first.id, 'claim');

    const second = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    // The retried task belongs to the new round; the kept rows still name the
    // round and time they were written in.
    expect(results?.search).toEqual({ status: 'running', runId: second.id });
    expect(results?.daily).toMatchObject({ status: 'completed', runId: first.id });
    expect(results?.claim).toMatchObject({ status: 'not-needed', runId: first.id });
    expect(typeof results?.daily?.at).toBe('number');
    expect(typeof results?.claim?.at).toBe('number');
  });

  // A row still `running` while no round exists belongs to nothing: its round
  // is gone and no result ever settled it. Keeping it would show "in flight"
  // for a round that no longer exists.
  it('drops a stale running row instead of carrying it over', async () => {
    await setStorageItem(RESULTS_KEY, {
      search: { status: 'completed', runId: 1, at: 1 },
      daily: { status: 'running' },
    }, StorageValues.LOCAL);

    const run = await beginRun(['search'], { searches: 5, timeout: 60, closeTime: 5 });

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.daily).toBeUndefined();
    expect(results?.search).toEqual({ status: 'running', runId: run.id });
  });

  it('stamps the restart-abandoned results with the round they belong to', async () => {
    const run = await beginRun(['search', 'daily'], { searches: 5, timeout: 60, closeTime: 5 });

    await abandonRun('浏览器已重启，未能确认结果');

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    expect(results?.search).toMatchObject({ status: 'unconfirmed', reason: '浏览器已重启，未能确认结果', runId: run.id });
    expect(results?.daily).toMatchObject({ status: 'unconfirmed', runId: run.id });
    expect(typeof results?.search?.at).toBe('number');
    expect(await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL)).toBeNull();
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
