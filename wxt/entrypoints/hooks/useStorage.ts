import {useState, useEffect, useRef} from "react";
import {StorageValues} from "@/entrypoints/enums/storageValues.ts"
import { storage } from '#imports';
import {StorageItem} from "@/entrypoints/types/storageItem.ts";

// Matches WXT's branded storage-key type. StorageValues values are exactly
// local/session/sync/managed, so the runtime string always satisfies this shape.
type StorageItemKey = `local:${string}` | `session:${string}` | `sync:${string}` | `managed:${string}`;

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface StorageBinding<T> {
    value: T;
    setValue: (value: T) => void;
    saveState: SaveState;
    retrySave: () => void;
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
    const [saveState, setSaveState] = useState<SaveState>('idle');
    // True only while the first read is still being applied to state. A default
    // that was only *read* is not a choice the user made, so it must not be
    // written back: the background may still be deriving the real value (the
    // auto-run migration runs after the popup can open), and echoing the
    // default would overwrite it. Once the user changes the control, later
    // values — including a return to that first reading — are their choice.
    const hydrating = useRef(true);
    const writeSeq = useRef(0);
    // The value currently on screen. A failed write leaves it there; retry writes
    // that same value again, which a control that sets the identical value cannot.
    const latest = useRef(defaultValue);
    latest.current = value;
    const writeCurrent = useRef<(next: T) => void>(() => undefined);
    writeCurrent.current = (next: T) => {
        const seq = ++writeSeq.current;
        setSaveState('saving');
        void enqueueWrite(storageKey, () => storage.setItem(storageKey, next)).then(
            () => {
                if (seq === writeSeq.current) setSaveState('saved');
            },
            () => {
                if (seq === writeSeq.current) setSaveState('error');
            },
        );
    };

    useEffect(() => {
        let cancelled = false;
        hydrating.current = true;
        storage.getItem(storageKey).then((stored: any) => {
            if (cancelled) return;
            setValue((stored ?? defaultValue) as T);
            setIsInitialized(true);
        });
        return () => {
            cancelled = true;
        };
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

    return { value, setValue, saveState, retrySave };
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
