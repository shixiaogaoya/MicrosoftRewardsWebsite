// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { getStorageItem, setStorageItem, setStorageItems } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { ATTEMPTS_KEY, MIGRATION_KEY, RESULTS_KEY, type TaskAttempts, type TaskResults } from '@/entrypoints/utils/runState';
import { migrateRunState } from './stateMigration';

describe('migrateRunState', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('derives auto-run from the tasks an existing install had enabled', async () => {
    await setStorageItems({ active: false, autoDaily: true, claimPoints: false, searches: 12 }, StorageValues.SYNC);

    await migrateRunState();

    expect(await getStorageItem<boolean>('autoRunEnabled', StorageValues.SYNC)).toBe(true);
    expect(await getStorageItem<number>('searches', StorageValues.SYNC)).toBe(12);
    expect(await getStorageItem<number>(MIGRATION_KEY, StorageValues.LOCAL)).toBe(1);
  });

  it('turns auto-run off when an existing install had every task off', async () => {
    await setStorageItems({ active: false, autoDaily: false, claimPoints: false }, StorageValues.SYNC);

    await migrateRunState();

    expect(await getStorageItem<boolean>('autoRunEnabled', StorageValues.SYNC)).toBe(false);
  });

  it('does not overwrite an auto-run value that is already stored', async () => {
    await setStorageItems({ active: true, autoDaily: true, autoRunEnabled: false }, StorageValues.SYNC);

    await migrateRunState();

    expect(await getStorageItem<boolean>('autoRunEnabled', StorageValues.SYNC)).toBe(false);
  });

  it('records today as attempted, not completed, when the old date is today', async () => {
    await setStorageItems({ lastOpened: new Date().toLocaleDateString(), isSearching: true, currentSearch: 4 }, StorageValues.SYNC);

    await migrateRunState();

    const attempts = await getStorageItem<TaskAttempts>(ATTEMPTS_KEY, StorageValues.LOCAL);
    expect(attempts?.search).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL)).toBeNull();
    // Left in place for a device that is still on the previous version.
    expect(await getStorageItem<boolean>('isSearching', StorageValues.SYNC)).toBe(true);
    expect(await getStorageItem<string>('lastOpened', StorageValues.SYNC)).toBe(new Date().toLocaleDateString());
  });

  // Regression: the legacy gate only ran the tasks whose toggles were on, so a
  // task that was off cannot have run. Marking it attempted would make its first
  // real run today be skipped by the automatic gate.
  it('marks only the tasks the legacy round actually had enabled', async () => {
    await setStorageItems({
      lastOpened: new Date().toLocaleDateString(),
      active: true,
      autoDaily: false,
      claimPoints: false,
    }, StorageValues.SYNC);

    await migrateRunState();

    const attempts = await getStorageItem<TaskAttempts>(ATTEMPTS_KEY, StorageValues.LOCAL);
    expect(attempts?.search).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(attempts?.daily).toBeUndefined();
    expect(attempts?.claim).toBeUndefined();
  });

  it('does not record an attempt when the old date is not today', async () => {
    await setStorageItem('lastOpened', 'not a date this browser would write today', StorageValues.SYNC);

    await migrateRunState();

    expect(await getStorageItem(ATTEMPTS_KEY, StorageValues.LOCAL)).toBeNull();
  });

  it('does nothing the second time', async () => {
    await setStorageItems({ active: false, autoDaily: false, claimPoints: false }, StorageValues.SYNC);
    await migrateRunState();
    await setStorageItem('autoRunEnabled', true, StorageValues.SYNC);

    await migrateRunState();

    expect(await getStorageItem<boolean>('autoRunEnabled', StorageValues.SYNC)).toBe(true);
  });
});
