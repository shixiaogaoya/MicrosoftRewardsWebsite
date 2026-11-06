(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import App from '@/entrypoints/popup/App';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { setStorageItem } from '@/entrypoints/hooks/useStorage';
import { RESULTS_KEY } from '@/entrypoints/utils/runState';

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

// A single-task retry starts a round on the stored settings, just like the main
// start button. The repro: a failed search leaves a retry on its row, an edit's
// write to sync storage fails, and back on the home view the start button is
// already blocked — the retry used to fire anyway, running the round on the old
// stored values while the screen showed the unsaved ones.
describe('App 设置未就绪时的单项重试', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(async () => {
        fakeBrowser.reset();
        // A failed search from an earlier round is what puts a retry button on a row.
        await setStorageItem(RESULTS_KEY, { search: { status: 'failed', reason: '页面未能打开' } }, StorageValues.LOCAL);
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => {
            root.render(<App />);
        });
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

    async function waitFor(cond: () => boolean, limit = 20): Promise<void> {
        for (let i = 0; i < limit && !cond(); i++) await tick();
    }

    async function openSettings(): Promise<void> {
        await waitFor(() => host.querySelector('.advanced-row') != null);
        act(() => {
            host.querySelector<HTMLButtonElement>('.advanced-row')!.click();
        });
        await waitFor(() => host.querySelector('#searches') != null);
        // The hook holds every write back until its read has landed, so an edit
        // made in that window would be dropped — let the reads finish first.
        await tick();
        await tick();
    }

    function typeInto(id: string, text: string): void {
        act(() => {
            const el = host.querySelector<HTMLInputElement>(`#${id}`)!;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(el, text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    function startButton(): HTMLButtonElement | null {
        return host.querySelector<HTMLButtonElement>('#button');
    }

    function retryButton(): HTMLButtonElement | null {
        return host.querySelector<HTMLButtonElement>('.task-retry');
    }

    it('保存失败后重试与主按钮同样受限，处理函数自身也不发送', async () => {
        const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ accepted: true } as never);
        // The edit's write to sync storage is what fails and strands the screen
        // on values storage never took.
        vi.spyOn(fakeBrowser.storage.sync, 'set').mockRejectedValue(new Error('write failed'));

        await openSettings();
        typeInto('searches', '10');
        await waitFor(() => (host.textContent ?? '').includes('保存失败'));
        act(() => {
            host.querySelector<HTMLButtonElement>('.back-button')!.click();
        });

        // The repro's own ground: the failure is on screen and the main start
        // button is already blocked on it.
        expect(host.textContent).toContain('保存失败');
        expect(startButton()?.disabled).toBe(true);

        const retry = retryButton();
        expect(retry).not.toBeNull();
        // dispatchEvent reaches the handler where the disabled attribute would
        // stop a real click, so this exercises the handler's own guard.
        await act(async () => {
            retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(send).not.toHaveBeenCalled();
        expect(retry?.disabled).toBe(true);
    });

    it('保存中的重试同样受限，保存成功后恢复', async () => {
        const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ accepted: true } as never);
        const writers: Array<() => void> = [];
        vi.spyOn(fakeBrowser.storage.sync, 'set').mockImplementation(() => new Promise<void>((resolve) => {
            writers.push(resolve);
        }));

        await openSettings();
        typeInto('searches', '10');
        await waitFor(() => (host.textContent ?? '').includes('正在保存'));
        act(() => {
            host.querySelector<HTMLButtonElement>('.back-button')!.click();
        });

        // While the write is in flight the retry is held like the start button.
        expect(startButton()?.disabled).toBe(true);
        const held = retryButton();
        expect(held).not.toBeNull();
        expect(held?.disabled).toBe(true);
        await act(async () => {
            held!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(send).not.toHaveBeenCalled();

        // The write lands, so the stored settings match the screen again and
        // the row's retry comes back.
        act(() => {
            writers.forEach((resolve) => resolve());
        });
        await waitFor(() => retryButton()?.disabled === false);
        await act(async () => {
            retryButton()!.click();
        });
        expect(send).toHaveBeenCalledWith({ action: 'popup', only: ['search'] });
    });
});
