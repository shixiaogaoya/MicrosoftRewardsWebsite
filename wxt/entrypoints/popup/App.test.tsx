(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import App from '@/entrypoints/popup/App';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { setStorageItem } from '@/entrypoints/hooks/useStorage';

// The short-gap warning and the first-result note are copy, so what regresses
// is the phrasing: the 30s threshold must stay a recommendation whose crediting
// effect the extension says it cannot confirm — not a claim about what
// Microsoft does — and opting into the first result must say where the tab
// actually goes.
describe('App 设置视图的文案', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(async () => {
        fakeBrowser.reset();
        // A stored gap below the recommended minimum is what shows the warning.
        await setStorageItem('timeout', 5, StorageValues.SYNC);
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => {
            root.render(<App />);
        });
        await openSettings();
    });

    afterEach(() => {
        act(() => root.unmount());
        host.remove();
    });

    async function openSettings(): Promise<void> {
        act(() => {
            const advanced = host.querySelector<HTMLButtonElement>('.advanced-row');
            if (advanced) advanced.click();
        });
        // The settings view renders once the switch happens; the stored timeout
        // arrives a few ticks later and is what turns the warning on.
        for (let i = 0; i < 20; i++) {
            const timeout = host.querySelector<HTMLInputElement>('#timeout');
            if (timeout && timeout.value === '5') return;
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        }
    }

    it('短间隔警告说明计分无法确认，不断言 30 秒不计分', () => {
        const warning = host.querySelector('.field-warning');
        expect(warning).not.toBeNull();
        const text = warning?.textContent ?? '';
        expect(text).toContain('30');
        expect(text).toContain('无法确认');
        expect(text).not.toContain('不计积分');
    });

    it('打开首个结果的提示写明会跳转到结果网站', () => {
        const notes = Array.from(host.querySelectorAll('.field-note'));
        const note = notes.find((el) => (el.textContent ?? '').includes('首个结果'));
        expect(note?.textContent ?? '').toContain('跳转到首个结果所在的网站');
    });
});

// A failed first read leaves the defaults on screen while the hook holds every
// write back until its read lands, so an edit made in that window would only
// change the screen and be silently replaced by the retry. The settings
// controls are therefore disabled until the re-read brings the real values in.
describe('App 设置读取失败时禁用编辑控件', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(async () => {
        fakeBrowser.reset();
        // A stored value the retry should surface once reads work again.
        await setStorageItem('timeout', 5, StorageValues.SYNC);
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        vi.restoreAllMocks();
    });

    async function tick(): Promise<void> {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }

    async function openSettings(): Promise<void> {
        await tick();
        act(() => {
            const advanced = host.querySelector<HTMLButtonElement>('.advanced-row');
            if (advanced) advanced.click();
        });
        for (let i = 0; i < 20; i++) {
            if (host.querySelector('#searches')) return;
            await tick();
        }
    }

    it('读取失败期间开关、任务块、预设与数字输入全部禁用，且重读成功后恢复', async () => {
        // Every settings read fails, so all bindings sit in loadState 'error'.
        const get = fakeBrowser.storage.sync.get.bind(fakeBrowser.storage.sync);
        const failing = vi.spyOn(fakeBrowser.storage.sync, 'get').mockRejectedValue(new Error('read failed'));

        await act(async () => {
            root.render(<App />);
        });
        await openSettings();

        const switchInput = host.querySelector<HTMLInputElement>('#autoRunEnabled');
        expect(switchInput?.disabled).toBe(true);
        for (const id of ['autoCheckbox', 'autoDaily', 'claimPoints', 'openFirstResult']) {
            expect(host.querySelector<HTMLInputElement>(`#${id}`)?.disabled).toBe(true);
        }
        for (const id of ['searches', 'timeout', 'closeTime']) {
            expect(host.querySelector<HTMLInputElement>(`#${id}`)?.disabled).toBe(true);
        }
        const presets = Array.from(host.querySelectorAll<HTMLButtonElement>('.preset-button'));
        expect(presets).toHaveLength(3);
        expect(presets.every((button) => button.disabled)).toBe(true);
        // The way out stays available: the failed read carries its own retry.
        const retry = Array.from(host.querySelectorAll<HTMLButtonElement>('.save-retry'))
            .find((button) => button.textContent === '重新读取');
        expect(retry).toBeDefined();

        // Reads work again: the retry re-enables the controls with the stored
        // values, not the defaults that were showing during the failure.
        failing.mockImplementation(async (keys) => get(keys as Parameters<typeof get>[0]));
        act(() => retry!.click());
        for (let i = 0; i < 20; i++) {
            const timeout = host.querySelector<HTMLInputElement>('#timeout');
            if (timeout && !timeout.disabled && timeout.value === '5') break;
            await tick();
        }
        const recovered = host.querySelector<HTMLInputElement>('#timeout');
        expect(recovered?.disabled).toBe(false);
        expect(recovered?.value).toBe('5');
        expect(host.querySelector<HTMLInputElement>('#autoRunEnabled')?.disabled).toBe(false);
    });
});
