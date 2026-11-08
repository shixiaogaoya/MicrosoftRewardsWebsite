(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import App from '@/entrypoints/popup/App';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { setStorageItem } from '@/entrypoints/hooks/useStorage';
import { ATTEMPTS_KEY, RESULTS_KEY, RUN_KEY, type TaskResults, type TaskRunState } from '@/entrypoints/utils/runState';
import { localDateId } from '@/entrypoints/utils/localDate';

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

// A single-task retry is its own round: it runs one task while the stored
// results keep the other tasks' last outcomes from the rounds that ran them.
// The popup has to keep the two apart — this round's summary names only this
// round's tasks, the kept rows say which round they came from — and a reopened
// popup rebuilds that view from storage alone.
describe('App 单项重试后的最近结果', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        fakeBrowser.reset();
        host = document.createElement('div');
        document.body.appendChild(host);
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

    async function mount(): Promise<void> {
        root = createRoot(host);
        await act(async () => {
            root.render(<App />);
        });
        await waitFor(() => host.querySelector('.task-results') != null);
    }

    function itemOf(label: string): HTMLElement | null {
        return Array.from(host.querySelectorAll<HTMLElement>('.task-item')).find((el) => el.textContent?.includes(label)) ?? null;
    }

    // What the background leaves after a full round (search failed, the
    // dashboard tasks done) and an accepted retry of the search.
    const afterRetry: TaskResults = {
        search: { status: 'completed', runId: 2, at: new Date(2026, 10, 7, 15, 10).getTime() },
        daily: { status: 'completed', runId: 1, at: new Date(2026, 10, 7, 14, 32).getTime() },
        claim: { status: 'completed', runId: 1, at: new Date(2026, 10, 7, 14, 32).getTime() },
    };

    it('重试轮结束后，其他任务的最近结果仍可查并标注上一轮', async () => {
        await setStorageItem(RESULTS_KEY, afterRetry, StorageValues.LOCAL);
        await mount();

        // All three rows stay readable; the kept ones name the round they came
        // from, the retry round's own row does not.
        expect(host.querySelectorAll('.task-item').length).toBe(3);
        expect(itemOf('每日活动')?.querySelector('.task-meta')).not.toBeNull();
        expect(itemOf('领取积分')?.querySelector('.task-meta')).not.toBeNull();
        expect(itemOf('搜索')?.querySelector('.task-meta')).toBeNull();

        // The pill speaks for the retry round alone, not for the stitched rows.
        expect(host.querySelector('.status-pill')?.textContent).toBe('本轮已完成');
    });

    it('重试轮运行中只概括本轮任务，保留行标注上一轮', async () => {
        await setStorageItem(RESULTS_KEY, {
            search: { status: 'running', runId: 3 },
            daily: afterRetry.daily,
            claim: afterRetry.claim,
        }, StorageValues.LOCAL);
        await setStorageItem(RUN_KEY, {
            id: 3,
            phase: 'running',
            search: true,
            daily: false,
            claim: false,
            startedAt: Date.now(),
        } satisfies TaskRunState, StorageValues.LOCAL);
        await mount();

        expect(host.querySelector('.status-pill')?.textContent).toBe('正在执行');
        // The round note lists only what this round runs: the search, not the
        // kept daily row that an older round completed.
        const note = host.querySelector('.round-note')?.textContent ?? '';
        expect(note).toContain('搜索');
        expect(note).not.toContain('每日活动');
        expect(itemOf('搜索')?.textContent).toContain('进行中');
        expect(itemOf('每日活动')?.querySelector('.task-meta')).not.toBeNull();
    });

    it('弹窗关闭重开后，从存储重建同样的轮次视图', async () => {
        await setStorageItem(RESULTS_KEY, afterRetry, StorageValues.LOCAL);
        await mount();
        const before = Array.from(host.querySelectorAll('.task-item')).map((el) => el.textContent);
        expect(before.length).toBe(3);
        act(() => root.unmount());

        // A reopened popup is a fresh mount reading the same local storage.
        host.remove();
        host = document.createElement('div');
        document.body.appendChild(host);
        await mount();
        const after = Array.from(host.querySelectorAll('.task-item')).map((el) => el.textContent);
        expect(after).toEqual(before);
        expect(host.querySelector('.status-pill')?.textContent).toBe('本轮已完成');
    });
});

// The auto-run note is copy, same as the settings-copy tests at the top: it is
// the only place that says a "tried today" mark is not a completion, that an
// attempt — whatever its outcome — is not retried automatically again that day,
// and that the dashboard visit runs in a foreground tab whose focus handling
// follows the user's own switching. What regresses is the phrasing, and the
// attempt/dedup claims must stay tied to what the background actually does
// (runRewards skips any task with an attempt for the local day).
describe('App 首页自动执行说明的文案', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(async () => {
        fakeBrowser.reset();
        // An attempt recorded for today is what turns the "tried today" line on;
        // auto-run itself is on by default.
        await setStorageItem(ATTEMPTS_KEY, { search: localDateId() }, StorageValues.LOCAL);
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => {
            root.render(<App />);
        });
        for (let i = 0; i < 20; i++) {
            if (host.querySelector('.auto-note')) return;
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        }
    });

    afterEach(() => {
        act(() => root.unmount());
        host.remove();
    });

    function noteWith(text: string): string {
        return Array.from(host.querySelectorAll('.field-note'))
            .find((el) => (el.textContent ?? '').includes(text))?.textContent ?? '';
    }

    it('区分今日已尝试与已完成，写明当日不再自动重试与手动入口', () => {
        const line = noteWith('今日已尝试');
        expect(line).toContain('搜索');
        expect(line).toContain('已尝试不等于已完成');
        expect(line).toContain('当日自动检查不会再试');
        expect(line).toContain('开始任务');
        expect(line).toContain('重试按钮');
    });

    it('写明前台执行的影响与结束后不抢回用户当前的页面', () => {
        const line = noteWith('前台打开 Rewards');
        expect(line).toContain('运行期间会临时切换标签页');
        expect(line).toContain('回到原来的标签页');
        expect(line).toContain('保持当前页面不动');
    });
});

// A11：诊断入口藏在高级设置里，普通界面不出现技术字段。进入后先看到要
// 导出的 JSON 预览，导出按钮下载的就是这份预览文本。
describe('App 诊断信息视图', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(async () => {
        fakeBrowser.reset();
        vi.restoreAllMocks();
        // fakeBrowser 未实现 runtime.getManifest；真实弹窗里它总是可用。
        vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ version: '3.1.5' } as never);
        await setStorageItem(RESULTS_KEY, {
            search: { status: 'failed', runId: 9, at: new Date(2026, 10, 7, 15, 4).getTime(), reason: 'user@example.com' },
            daily: { status: 'unconfirmed', cause: 'unknown-structure', recognizerVersion: 1, runId: 9 },
        } as TaskResults, StorageValues.LOCAL);
        await setStorageItem(RUN_KEY, {
            id: 9,
            phase: 'running',
            search: true,
            daily: true,
            claim: false,
            startedAt: new Date(2026, 10, 7, 15, 3).getTime(),
        } satisfies TaskRunState, StorageValues.LOCAL);
        await fakeBrowser.alarms.create('dailyCheck', { when: new Date(2026, 10, 7, 18, 0).getTime() });
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

    async function openDiagnostics(): Promise<void> {
        act(() => {
            host.querySelector<HTMLButtonElement>('.advanced-row')?.click();
        });
        await waitFor(() => host.querySelector('#diagnosticsEntry') != null);
        act(() => {
            host.querySelector<HTMLButtonElement>('#diagnosticsEntry')?.click();
        });
        // 等到预览里出现结果行的轮次号：面板快照与 hook 的实时 results
        // 汇合之后，预览才算是这份存储的完整视图。
        await waitFor(() => host.querySelector('.diag-preview')?.textContent?.includes('"runId": 9') === true);
    }

    it('主界面与设置页不直接展示技术字段，诊断入口在高级设置内', async () => {
        expect(host.querySelector('.diag-preview')).toBeNull();
        expect(host.textContent).not.toContain('extensionVersion');

        act(() => {
            host.querySelector<HTMLButtonElement>('.advanced-row')?.click();
        });
        await tick();
        expect(host.querySelector('#diagnosticsEntry')).not.toBeNull();
        expect(host.textContent).not.toContain('extensionVersion');
    });

    it('预览即导出内容：含定位字段，不含敏感字段', async () => {
        await openDiagnostics();
        const text = host.querySelector('.diag-preview')?.textContent ?? '';
        expect(text).toContain('"extensionVersion": "3.1.5"');
        expect(text).toContain('"recognizerVersion": 1');
        expect(text).toContain('"unknown-structure"');
        expect(text).toContain(new Date(new Date(2026, 10, 7, 15, 3).getTime()).toISOString());
        expect(text).toContain(new Date(new Date(2026, 10, 7, 18, 0).getTime()).toISOString());
        // 结果行里塞的邮箱不在预览里；runId 只出现为数字。
        expect(text).not.toContain('user@example.com');
        expect(text).toContain('"runId": 9');
    });

    it('导出按钮把预览文本下载为本地 JSON 文件', async () => {
        await openDiagnostics();
        const clicked: { href: string; download: string }[] = [];
        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            clicked.push({ href: this.href, download: this.download });
        });
        const urlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:diagnostics');
        act(() => {
            host.querySelector<HTMLButtonElement>('#diagnosticExport')?.click();
        });
        expect(urlSpy).toHaveBeenCalledOnce();
        expect(clicked).toHaveLength(1);
        expect(clicked[0].href).toBe('blob:diagnostics');
        expect(clicked[0].download).toMatch(/^rewards-diagnostics-v3\.1\.5-\d{4}-\d{2}-\d{2}\.json$/);
        // 下载的就是预览文本。
        const blob = urlSpy.mock.calls[0][0] as Blob;
        await expect(blob.text()).resolves.toContain('"extensionVersion": "3.1.5"');
    });

    it('返回按钮回到设置页', async () => {
        await openDiagnostics();
        expect(host.querySelector('.diag-preview')).not.toBeNull();
        act(() => {
            host.querySelector<HTMLButtonElement>('.back-button')?.click();
        });
        await tick();
        expect(host.querySelector('.settings-heading')?.textContent).toBe('设置');
        expect(host.querySelector('.diag-preview')).toBeNull();
    });
});
