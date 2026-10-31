import {useState, useEffect} from "react";
import {StorageValues} from "@/entrypoints/enums/storageValues.ts"
import { storage } from '#imports';
import {StorageItem} from "@/entrypoints/types/storageItem.ts";

// Matches WXT's branded storage-key type. StorageValues values are exactly
// local/session/sync/managed, so the runtime string always satisfies this shape.
type StorageItemKey = `local:${string}` | `session:${string}` | `sync:${string}` | `managed:${string}`;

export function useStorage<T>(key: string, defaultValue: T, storageType: StorageValues = StorageValues.LOCAL) {
    const storageKey = `${storageType}:${key}` as StorageItemKey;
    const [value, setValue] = useState<T>(defaultValue);
    const [isInitialized, setIsInitialized] = useState(false);
    // The value the first read produced. A default that was only *read* is not
    // a choice the user made, so it must not be written back: the background
    // may still be deriving the real value (the auto-run migration runs after
    // the popup can open), and echoing the default would overwrite it.
    const [loadedValue, setLoadedValue] = useState<T | undefined>(undefined);

    useEffect(() => {
        storage.getItem(storageKey).then((stored: any) => {
            const initial = (stored ?? defaultValue) as T;
            setValue(initial);
            setLoadedValue(initial);
            setIsInitialized(true);
        });
    }, [storageKey]);

    useEffect(() => {
        if (isInitialized && loadedValue !== undefined && value !== loadedValue) {
            void storage.setItem(storageKey, value);
        }
    }, [storageKey, value, loadedValue, isInitialized]);

    return [value, setValue] as const;
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
