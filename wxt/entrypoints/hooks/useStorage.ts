import {useState, useEffect, useRef} from "react";
import {StorageValues} from "@/entrypoints/enums/storageValues.ts"
import { storage } from '#imports';
import {StorageItem} from "@/entrypoints/types/storageItem.ts";

// Matches WXT's branded storage-key type. StorageValues values are exactly
// local/session/sync/managed, so the runtime string always satisfies this shape.
type StorageItemKey = `local:${string}` | `session:${string}` | `sync:${string}` | `managed:${string}`;

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
export type LoadState = 'loading' | 'loaded' | 'error';

export interface StorageBinding<T> {
    value: T;
    setValue: (value: T) => void;
    saveState: SaveState;
    retrySave: () => void;
    loadState: LoadState;
    retryLoad: () => void;
}

// One write at a time per key, in the order the user made the changes. A later
// edit must not be reported saved because an earlier write happened to finish,
// and a failed write must not be hidden by the next one.
const writeTail = new Map<string, Promise<void>>();

function enqueueWrite(storageKey: string, write: () => Promise<void>): Promise<void> {
    const previous = writeTail.get(storageKey) ?? Promise.resolve();
    const next = previous.then(write, write);
    const settled = next.then(() => undefined, () => undefined);
    writeTail.set(storageKey, settled);
    void settled.then(() => {
        if (writeTail.get(storageKey) === settled) writeTail.delete(storageKey);
    });
    return next;
}

export function useStorage<T>(key: string, defaultValue: T, storageType: StorageValues = StorageValues.LOCAL): StorageBinding<T> {
    const storageKey = `${storageType}:${key}` as StorageItemKey;
    const [value, setValue] = useState<T>(defaultValue);
    const [isInitialized, setIsInitialized] = useState(false);
    const [loadState, setLoadState] = useState<LoadState>('loading');
    // Bumping this re-runs the first read; that is what the retry button does.
    const [readAttempt, setReadAttempt] = useState(0);
    const [saveState, setSaveState] = useState<SaveState>('idle');
    // True only while the first read is still being applied to state. A default
    // that was only *read* is not a choice the user made, so it must not be
    // written back: the background may still be deriving the real value (the
    // auto-run migration runs after the popup can open), and echoing the
    // default would overwrite it. Once the user changes the control, later
    // values — including a return to that first reading — are their choice.
    const hydrating = useRef(true);
    // True while the value on screen is a local edit storage has not confirmed
    // saved: its write is still queued, or it failed and awaits the retry. An
    // external change arriving in that window must not replace the draft.
    const draftPending = useRef(false);
    const writeSeq = useRef(0);
    // The value currently on screen. A failed write leaves it there; retry writes
    // that same value again, which a control that sets the identical value cannot.
    const latest = useRef(defaultValue);
    latest.current = value;
    const writeCurrent = useRef<(next: T) => void>(() => undefined);
    writeCurrent.current = (next: T) => {
        const seq = ++writeSeq.current;
        draftPending.current = true;
        setSaveState('saving');
        void enqueueWrite(storageKey, () => storage.setItem(storageKey, next)).then(
            () => {
                if (seq === writeSeq.current) {
                    draftPending.current = false;
                    setSaveState('saved');
                }
            },
            () => {
                if (seq === writeSeq.current) setSaveState('error');
            },
        );
    };

    useEffect(() => {
        let cancelled = false;
        hydrating.current = true;
        storage.getItem(storageKey).then(
            (stored: any) => {
                if (cancelled) return;
                setValue((stored ?? defaultValue) as T);
                setIsInitialized(true);
                setLoadState('loaded');
            },
            () => {
                // A rejected read must not leave the popup silently showing the
                // default: this error state is what makes the failure and its
                // retry visible, and what blocks starting on values never read.
                if (cancelled) return;
                setLoadState('error');
            },
        );
        return () => {
            cancelled = true;
        };
    }, [storageKey, readAttempt]);

    // Subscribe to changes this hook did not write: the background migration,
    // or another device through sync storage. Conflict policy: while a local
    // edit has not been confirmed saved (its write still queued, or failed and
    // awaiting retry), that draft wins — adopting the external value would drop
    // the user's choice, and the pending write would put it right back. With no
    // draft, the external value is the newest committed one and is adopted;
    // hydrating marks it as read-from-storage so the effect below does not
    // echo it into another write.
    useEffect(() => {
        return storage.watch<T>(storageKey, (stored) => {
            if (draftPending.current) return;
            // A change that is already on screen — most often the echo of this
            // hook's own write — is not an adoption. Setting the hydrating flag
            // for it would leave the flag set: the unchanged value re-renders
            // nothing, no effect run clears the flag, and the user's next edit
            // would then be silently skipped instead of written.
            if (Object.is(stored ?? defaultValue, latest.current)) return;
            hydrating.current = true;
            setValue((stored ?? defaultValue) as T);
        });
    }, [storageKey]);

    useEffect(() => {
        if (!isInitialized) return;
        if (hydrating.current) {
            hydrating.current = false;
            return;
        }
        writeCurrent.current(value);
    }, [storageKey, value, isInitialized]);

    function retrySave(): void {
        writeCurrent.current(latest.current);
    }

    function retryLoad(): void {
        setLoadState('loading');
        setReadAttempt((attempt) => attempt + 1);
    }

    return { value, setValue, saveState, retrySave, loadState, retryLoad };
}

export async function getStorageItem<T = any>(key: string, storageType: StorageValues = StorageValues.LOCAL): Promise<T | null> {
    const storageKey = `${storageType}:${key}` as StorageItemKey;
    return await storage.getItem<T>(storageKey);
}

export async function setStorageItem(key: string, value: any, storageType: StorageValues = StorageValues.LOCAL) {
    const storageKey = `${storageType}:${key}` as StorageItemKey;
    await storage.setItem(storageKey, value);
}

export async function setStorageItems(items: Record<string, any>, storageType: StorageValues = StorageValues.LOCAL) {
    const storageItems = Object.entries(items).map(([key, value]) => ({
        key: `${storageType}:${key}` as StorageItemKey,
        value
    }));
    await storage.setItems(storageItems);
}

export async function getStorageItems(keys: string[], storageType: StorageValues = StorageValues.LOCAL) {
    const storageKeys: StorageItemKey[] = keys.map((key: string) => `${storageType}:${key}` as StorageItemKey);
    const items = await storage.getItems(storageKeys);
    return items.reduce((acc: { [x: string]: any; }, item: StorageItem) => {
        const shortKey = item.key.split(":")[1];
        acc[shortKey] = item.value;
        return acc;
    }, {});
}

function asAppendItems<T>(v: T | T[]): T[] {
    return Array.isArray(v) ? v : [v];
}

export async function mergeIntoStorageItem<T>(
    key: string,
    newValue: T | T[],
    storageType: StorageValues = StorageValues.LOCAL
) {
    const storageKey = `${storageType}:${key}` as StorageItemKey;
    const existingValue = await storage.getItem(storageKey);

    let updatedValue: unknown;

    if (existingValue == null) {
        updatedValue = asAppendItems(newValue);
    } else if (Array.isArray(existingValue)) {
        updatedValue = existingValue.concat(asAppendItems(newValue));
    } else if (typeof existingValue === 'string') {
        updatedValue = existingValue + String(newValue);
    } else if (typeof existingValue === 'number') {
        updatedValue = (existingValue as number) + (newValue as any);
    } else {
        throw new Error('mergeIntoStorageItem: Unsupported data type for appending.');
    }

    await storage.setItem(storageKey, updatedValue);
}
