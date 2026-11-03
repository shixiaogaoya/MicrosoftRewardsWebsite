(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { getStorageItem, setStorageItem, useStorage } from './useStorage';

// happy-dom supplies document. The hook tests mount a real control so a
// user change, including a return to the value first read, is what gets stored.
describe('useStorage hook', () => {
  let host: HTMLDivElement;
  let root: Root;

  function Switch({ storageKey, fallback }: { storageKey: string; fallback: boolean }) {
    const { value, setValue, saveState } = useStorage<boolean>(storageKey, fallback, StorageValues.SYNC);
    return (
      <input
        type="checkbox"
        role="switch"
        aria-label={storageKey}
        data-save={saveState}
        checked={value}
        onChange={(event) => setValue(event.target.checked)}
      />
    );
  }

  function NumberField({ storageKey, fallback }: { storageKey: string; fallback: number }) {
    const { value, setValue, saveState, retrySave } = useStorage<number>(storageKey, fallback, StorageValues.SYNC);
    return (
      <div>
        <input
          type="text"
          aria-label={storageKey}
          data-save={saveState}
          value={String(value)}
          onChange={(event) => setValue(Number(event.target.value))}
        />
        <button type="button" onClick={retrySave}>重试保存</button>
      </div>
    );
  }

  beforeEach(() => {
    fakeBrowser.reset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function control(): HTMLInputElement {
    const input = host.querySelector('input');
    if (!input) throw new Error('control missing');
    return input;
  }

  function clickSwitch(): void {
    control().click();
  }

  function setText(value: string): void {
    const input = control();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('does not write a default that was only read', async () => {
    await act(async () => {
      root.render(<Switch storageKey="autoRunEnabled" fallback={false} />);
    });
    await flush();

    expect(control().checked).toBe(false);
    expect(await getStorageItem('autoRunEnabled', StorageValues.SYNC)).toBeNull();
  });

  it('persists a boolean toggled away from and back to the stored value', async () => {
    await setStorageItem('autoRunEnabled', false, StorageValues.SYNC);
    await act(async () => {
      root.render(<Switch storageKey="autoRunEnabled" fallback={true} />);
    });
    await flush();
    expect(control().checked).toBe(false);

    await act(async () => clickSwitch());
    await flush();
    expect(control().checked).toBe(true);
    expect(await getStorageItem<boolean>('autoRunEnabled', StorageValues.SYNC)).toBe(true);

    await act(async () => clickSwitch());
    await flush();
    expect(control().checked).toBe(false);
    expect(await getStorageItem<boolean>('autoRunEnabled', StorageValues.SYNC)).toBe(false);
  });

  it('persists a number edited away from and back to the stored value', async () => {
    await setStorageItem('timeout', 60, StorageValues.SYNC);
    await act(async () => {
      root.render(<NumberField storageKey="timeout" fallback={0} />);
    });
    await flush();
    expect(control().value).toBe('60');

    await act(async () => setText('30'));
    await flush();
    expect(await getStorageItem<number>('timeout', StorageValues.SYNC)).toBe(30);

    await act(async () => setText('60'));
    await flush();
    expect(control().value).toBe('60');
    expect(await getStorageItem<number>('timeout', StorageValues.SYNC)).toBe(60);
  });

  it('reports saved only after the write resolves, and error when it rejects', async () => {
    await setStorageItem('searches', 30, StorageValues.SYNC);
    await act(async () => {
      root.render(<NumberField storageKey="searches" fallback={5} />);
    });
    await flush();
    expect(control().dataset.save).toBe('idle');

    await act(async () => setText('10'));
    await flush();
    expect(control().dataset.save).toBe('saved');
    expect(await getStorageItem<number>('searches', StorageValues.SYNC)).toBe(10);

    const setItem = fakeBrowser.storage.sync.set;
    fakeBrowser.storage.sync.set = () => Promise.reject(new Error('quota'));
    try {
      await act(async () => setText('30'));
      await flush();
      expect(control().value).toBe('30');
      expect(control().dataset.save).toBe('error');
      expect(await getStorageItem<number>('searches', StorageValues.SYNC)).toBe(10);

      fakeBrowser.storage.sync.set = setItem;
      await act(async () => {
        host.querySelector('button')?.click();
      });
      await flush();
      expect(control().dataset.save).toBe('saved');
      expect(await getStorageItem<number>('searches', StorageValues.SYNC)).toBe(30);
    } finally {
      fakeBrowser.storage.sync.set = setItem;
    }
  });

  it('stays saving while a second edit is still writing', async () => {
    await setStorageItem('searches', 5, StorageValues.SYNC);
    let releaseFirst: () => void = () => undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let writes = 0;
    const setItem = fakeBrowser.storage.sync.set.bind(fakeBrowser.storage.sync);
    fakeBrowser.storage.sync.set = (items) => {
      writes += 1;
      if (writes === 1) return firstWrite.then(() => setItem(items));
      return setItem(items);
    };
    try {
      await act(async () => {
        root.render(<NumberField storageKey="searches" fallback={5} />);
      });
      await flush();

      await act(async () => setText('10'));
      expect(control().dataset.save).toBe('saving');

      await act(async () => setText('30'));
      expect(control().dataset.save).toBe('saving');

      await act(async () => {
        releaseFirst();
        await firstWrite;
      });
      await flush();
      expect(control().dataset.save).toBe('saved');
      expect(await getStorageItem<number>('searches', StorageValues.SYNC)).toBe(30);
    } finally {
      fakeBrowser.storage.sync.set = setItem;
    }
  });
});
