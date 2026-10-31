import { getStorageItem, getStorageItems, setStorageItem, setStorageItems } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { DEFAULTS } from '@/entrypoints/utils/settings';
import { isLegacyToday, localDateId } from '@/entrypoints/utils/localDate';
import { ATTEMPTS_KEY, MIGRATION_KEY, STATE_MIGRATION_VERSION, type TaskAttempts } from '@/entrypoints/utils/runState';

// Runs once per install, marked by a local version so a second wake-up is a
// no-op. It never opens a page. User settings stay where they are. The old
// sync run keys (isSearching, currentSearch, lastOpened) are left in place —
// another device may still be on the previous version and still read them —
// but this version does not treat them as a run to resume, and does not write
// them again.
export async function migrateRunState(): Promise<void> {
    const version = await getStorageItem<number>(MIGRATION_KEY, StorageValues.LOCAL);
    if (version != null && version >= STATE_MIGRATION_VERSION) return;

    await seedAutoRun();
    await migrateLastOpened();
    await setStorageItem(MIGRATION_KEY, STATE_MIGRATION_VERSION, StorageValues.LOCAL);
}

// An install that predates the auto-run switch has no value for it. Its old
// behaviour was "run automatically when any task is on", so the new switch
// starts as the OR of the three task toggles. A value that is already stored
// — including one synced in from a device that has already migrated — is kept.
async function seedAutoRun(): Promise<void> {
    const stored = await getStorageItem<boolean | null>('autoRunEnabled', StorageValues.SYNC);
    if (stored != null) return;
    const s = await getStorageItems(['active', 'autoDaily', 'claimPoints'], StorageValues.SYNC);
    const anyTask =
        (s.active ?? DEFAULTS.active) ||
        (s.autoDaily ?? DEFAULTS.autoDaily) ||
        (s.claimPoints ?? DEFAULTS.claimPoints);
    await setStorageItem('autoRunEnabled', anyTask, StorageValues.SYNC);
}

// lastOpened was a locale-formatted date and meant "we started something
// today", not "it succeeded". When it really is today, record an attempt of
// unknown result so the alarm does not immediately start another round.
// It is never written as a completed result.
async function migrateLastOpened(): Promise<void> {
    const existing = await getStorageItem<TaskAttempts>(ATTEMPTS_KEY, StorageValues.LOCAL);
    if (existing) return;
    const s = await getStorageItems(['lastOpened'], StorageValues.SYNC);
    if (!isLegacyToday(s.lastOpened)) return;
    const today = localDateId();
    const attempts: TaskAttempts = { search: today, daily: today, claim: today };
    await setStorageItems({ [ATTEMPTS_KEY]: attempts }, StorageValues.LOCAL);
}
