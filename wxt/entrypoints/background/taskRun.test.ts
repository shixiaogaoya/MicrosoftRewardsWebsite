// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { getStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { RESULTS_KEY, RUN_KEY, type TaskResults, type TaskRunState } from '@/entrypoints/utils/runState';
import { beginRun, endRun, recordResult } from './taskRun';

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
