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
    const { value, setValue, saveState, retrySave, loadState, retryLoad } = useStorage<number>(storageKey, fallback, StorageValues.SYNC);
    return (
      <div>
        <input
          type="text"
          aria-label={storageKey}
          data-save={saveState}
          data-load={loadState}
          value={String(value)}
          onChange={(event) => setValue(Number(event.target.value))}
        />
        <button type="button" onClick={retrySave}>重试保存</button>
        <button type="button" onClick={retryLoad}>重新读取</button>
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

  it('reports a failed first read and recovers through the retry button', async () => {
    await setStorageItem('searches', 30, StorageValues.SYNC);
    const getItem = fakeBrowser.storage.sync.get.bind(fakeBrowser.storage.sync);
    fakeBrowser.storage.sync.get = () => Promise.reject(new Error('read failed'));
    try {
      await act(async () => {
        root.render(<NumberField storageKey="searches" fallback={5} />);
      });
      await flush();
      expect(control().dataset.load).toBe('error');
      // The default stays on screen; it was never read, so it is not a value a
      // round may run on.
      expect(control().value).toBe('5');
    } finally {
      fakeBrowser.storage.sync.get = getItem;
    }
    expect(await getStorageItem<number>('searches', StorageValues.SYNC)).toBe(30);

    await act(async () => {
      host.querySelectorAll('button')[1]?.click();
    });
    await flush();
    expect(control().dataset.load).toBe('loaded');
    expect(control().value).toBe('30');
  });

  it('adopts an external change once no local edit is pending, without echoing a write', async () => {
    let writes = 0;
    const setItem = fakeBrowser.storage.sync.set.bind(fakeBrowser.storage.sync);
    fakeBrowser.storage.sync.set = (items) => {
      writes += 1;
      return setItem(items);
    };
    try {
      await act(async () => {
        root.render(<NumberField storageKey="timeout" fallback={60} />);
      });
      await flush();
      expect(control().value).toBe('60');

      await act(async () => {
        await fakeBrowser.storage.sync.set({ timeout: 90 });
      });
      await flush();
      expect(control().value).toBe('90');
      // Only the external write itself: adopting must not write the value back.
      expect(writes).toBe(1);
    } finally {
      fakeBrowser.storage.sync.set = setItem;
    }
  });

  it('keeps writing after the echo of its own saved value arrives', async () => {
    await setStorageItem('searches', 30, StorageValues.SYNC);
    await act(async () => {
      root.render(<NumberField storageKey="searches" fallback={5} />);
    });
    await flush();
    expect(control().value).toBe('30');

    await act(async () => setText('35'));
    await flush();
    expect(control().dataset.save).toBe('saved');

    // A real browser delivers the onChanged broadcast after the write's
    // promise resolves; the fake fires it before. Trigger the event again to
    // replay that order — an echo whose value is the one already on screen.
    await act(async () => {
      await fakeBrowser.storage.sync.onChanged.trigger({
        searches: { oldValue: 30, newValue: 35 },
      });
    });
    await flush();

    await act(async () => setText('40'));
    await flush();
    expect(control().dataset.save).toBe('saved');
    expect(await getStorageItem<number>('searches', StorageValues.SYNC)).toBe(40);
  });

  it('keeps a local draft over an external change while its write failed', async () => {
    await setStorageItem('searches', 5, StorageValues.SYNC);
    await act(async () => {
      root.render(<NumberField storageKey="searches" fallback={5} />);
    });
    await flush();

    const setItem = fakeBrowser.storage.sync.set.bind(fakeBrowser.storage.sync);
    fakeBrowser.storage.sync.set = () => Promise.reject(new Error('quota'));
    try {
      await act(async () => setText('10'));
      await flush();
      expect(control().dataset.save).toBe('error');

      fakeBrowser.storage.sync.set = setItem;
      await act(async () => {
        await setItem({ searches: 40 });
      });
      await flush();
      // The failed draft stays on screen; the external value does not replace it.
      expect(control().value).toBe('10');
      expect(control().dataset.save).toBe('error');
    } finally {
      fakeBrowser.storage.sync.set = setItem;
    }
  });
});
