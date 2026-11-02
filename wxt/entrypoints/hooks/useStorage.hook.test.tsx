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
    const [value, setValue] = useStorage<boolean>(storageKey, fallback, StorageValues.SYNC);
    return (
      <input
        type="checkbox"
        role="switch"
        aria-label={storageKey}
        checked={value}
        onChange={(event) => setValue(event.target.checked)}
      />
    );
  }

  function NumberField({ storageKey, fallback }: { storageKey: string; fallback: number }) {
    const [value, setValue] = useStorage<number>(storageKey, fallback, StorageValues.SYNC);
    return (
      <input
        type="text"
        aria-label={storageKey}
        value={String(value)}
        onChange={(event) => setValue(Number(event.target.value))}
      />
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
});
