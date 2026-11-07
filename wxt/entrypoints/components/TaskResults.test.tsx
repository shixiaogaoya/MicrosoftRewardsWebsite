(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import TaskResultsList from '@/entrypoints/components/TaskResults';
import type { CommandReceipt, TaskResults } from '@/entrypoints/utils/runState';

// Same formatter the component uses, so the expected text matches whatever
// timezone the test run is in.
const RESULT_TIME = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

// The retry sends its command and shows the background's answer on the row it
// belongs to. The send is mocked at the browser boundary, so what is exercised
// is the receipt path: a refusal becomes visible text on that row, an accepted
// retry adds nothing.
describe('TaskResults retry', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(results: TaskResults, isRunning = false, settingsNotReady = false): void {
    act(() => {
      root.render(<TaskResultsList results={results} isRunning={isRunning} settingsNotReady={settingsNotReady} />);
    });
  }

  function retryButton(): HTMLButtonElement {
    const el = host.querySelector<HTMLButtonElement>('.task-retry');
    if (!el) throw new Error('retry button missing');
    return el;
  }

  function answeredWith(receipt: CommandReceipt): void {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(receipt as never);
  }

  it('shows the refusal reason on the row instead of ignoring the retry', async () => {
    render({ daily: { status: 'failed', reason: '页面未能打开' } });
    answeredWith({ accepted: false, reason: '该任务已关闭，请在设置中开启' });

    await act(async () => {
      retryButton().click();
    });

    const notes = host.querySelectorAll('.task-reason');
    expect(notes.length).toBe(2);
    expect(host.textContent).toContain('该任务已关闭，请在设置中开启');
  });

  it('adds no note when the retry is accepted', async () => {
    render({ daily: { status: 'failed', reason: '页面未能打开' } });
    answeredWith({ accepted: true });

    await act(async () => {
      retryButton().click();
    });

    expect(host.querySelectorAll('.task-reason').length).toBe(1);
  });

  it('disables the retry button while its receipt is in flight', async () => {
    render({ daily: { status: 'failed', reason: '页面未能打开' } });
    let answer!: (receipt: CommandReceipt) => void;
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockReturnValue(
      new Promise<CommandReceipt>((resolve) => { answer = resolve; }) as never
    );

    await act(async () => {
      retryButton().click();
    });

    expect(retryButton().disabled).toBe(true);
    expect(fakeBrowser.runtime.sendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer({ accepted: true });
    });

    expect(retryButton().disabled).toBe(false);
    expect(fakeBrowser.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  // Regression: the row keeps its state across rounds (it is keyed by task
  // kind), so a refusal the previous round collected used to resurface the
  // moment the new round's running state ended. A fresh result object drops it.
  it('drops a stale refusal once a new round replaces the row result', async () => {
    render({ daily: { status: 'failed', reason: '页面未能打开' } });
    answeredWith({ accepted: false, reason: '该任务已关闭，请在设置中开启' });

    await act(async () => {
      retryButton().click();
    });
    expect(host.textContent).toContain('该任务已关闭，请在设置中开启');

    render({ daily: { status: 'running' } }, true);
    render({ daily: { status: 'completed' } }, false);

    expect(host.textContent).not.toContain('该任务已关闭，请在设置中开启');
  });

  // A retry runs on the stored settings, so the settings' read/save state gates
  // it the way it gates the main start button. dispatchEvent reaches the
  // handler where the disabled attribute would stop a real click, so the
  // handler's own guard is what stops the send.
  it('holds the retry while the settings are not ready and releases it when they are', async () => {
    answeredWith({ accepted: true });
    render({ daily: { status: 'failed', reason: '页面未能打开' } }, false, true);

    expect(retryButton().disabled).toBe(true);
    await act(async () => {
      retryButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(fakeBrowser.runtime.sendMessage).not.toHaveBeenCalled();

    render({ daily: { status: 'failed', reason: '页面未能打开' } }, false, false);
    expect(retryButton().disabled).toBe(false);
    await act(async () => {
      retryButton().click();
    });
    expect(fakeBrowser.runtime.sendMessage).toHaveBeenCalledWith({ action: 'popup', only: ['daily'] });
  });
});

// A single-task retry keeps the other tasks' rows from the rounds that last
// ran them. Those rows must say which round they came from and when, so kept
// results are never read as this round's own work — and this round's rows are
// never mistaken for older ones.
describe('TaskResults 轮次标注', () => {
  let host: HTMLDivElement;
  let root: Root;

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

  function render(results: TaskResults, isRunning = false, runId?: number | null): void {
    act(() => {
      root.render(<TaskResultsList results={results} isRunning={isRunning} runId={runId} />);
    });
  }

  function metas(): HTMLElement[] {
    return Array.from(host.querySelectorAll<HTMLElement>('.task-meta'));
  }

  function itemOf(label: string): HTMLElement | null {
    return Array.from(host.querySelectorAll<HTMLElement>('.task-item')).find((el) => el.textContent?.includes(label)) ?? null;
  }

  const at = (hours: number, minutes: number): number => new Date(2026, 10, 7, hours, minutes).getTime();

  it('marks the kept rows of a running retry round, not its own running row', () => {
    render({
      search: { status: 'running', runId: 2 },
      daily: { status: 'completed', runId: 1, at: at(14, 32) },
      claim: { status: 'failed', reason: '页面未能打开', runId: 1, at: at(14, 32) },
    }, true, 2);

    expect(metas().length).toBe(2);
    const expected = `来自上一轮 · ${RESULT_TIME.format(at(14, 32))}`;
    expect(itemOf('每日活动')?.textContent).toContain(expected);
    expect(itemOf('领取积分')?.textContent).toContain(expected);
    // This round's own task shows its live status, with no round annotation.
    expect(itemOf('搜索')?.textContent).toContain('进行中');
    expect(itemOf('搜索')?.querySelector('.task-meta')).toBeNull();
  });

  it('leaves the newest round’s rows unmarked once idle and marks the older ones', () => {
    render({
      search: { status: 'completed', runId: 2, at: at(15, 10) },
      daily: { status: 'completed', runId: 1, at: at(14, 32) },
    }, false, null);

    expect(itemOf('搜索')?.querySelector('.task-meta')).toBeNull();
    expect(itemOf('每日活动')?.textContent).toContain(`来自上一轮 · ${RESULT_TIME.format(at(14, 32))}`);
  });

  // Results stored before the round and time were recorded have neither field.
  // Alone they are the latest results and stay unannotated — no time is
  // invented for them; next to a marked row they are the older ones and say
  // which round they came from, still without a made-up time.
  it('shows legacy rows without a time, conservatively', () => {
    render({ search: { status: 'completed' }, daily: { status: 'completed' } }, false, null);
    expect(metas().length).toBe(0);

    render({ search: { status: 'completed' }, daily: { status: 'completed', runId: 3, at: at(16, 0) } }, false, null);
    expect(itemOf('搜索')?.textContent).toContain('来自上一轮');
    expect(itemOf('搜索')?.textContent).not.toContain('·');
    expect(itemOf('每日活动')?.querySelector('.task-meta')).toBeNull();
  });

  it('keeps the retry offer on a kept failed row from an earlier round', () => {
    render({
      search: { status: 'completed', runId: 2, at: at(15, 10) },
      daily: { status: 'failed', reason: '页面未能打开', runId: 1, at: at(14, 32) },
    }, false, null);

    const daily = itemOf('每日活动');
    expect(daily?.textContent).toContain('来自上一轮');
    expect(daily?.querySelector('.task-retry')).not.toBeNull();
  });
});

// 手动入口（A08）：每日活动与领取的结果无法自动确认时（未知类型的卡片、
// 需要实际作答的活动、或页面结构不可判读），行内提供“打开页面”的入口，
// 由用户在页面上自己处理；搜索不提供——它的执行结果不依赖页面识别。
describe('TaskResults 手动入口', () => {
  let host: HTMLDivElement;
  let root: Root;

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

  function render(results: TaskResults, isRunning = false): void {
    act(() => {
      root.render(<TaskResultsList results={results} isRunning={isRunning} />);
    });
  }

  function itemOf(label: string): HTMLElement | null {
    return Array.from(host.querySelectorAll<HTMLElement>('.task-item')).find((el) => el.textContent?.includes(label)) ?? null;
  }

  function manualLink(label: string): HTMLAnchorElement | null {
    return itemOf(label)?.querySelector<HTMLAnchorElement>(`a[aria-label="打开页面处理${label}"]`) ?? null;
  }

  it('offers the page entry on an unconfirmed daily row', () => {
    render({ daily: { status: 'unconfirmed', reason: '已点击 3 张卡片，页面没有完成标记（识别器 v1）' } });

    const link = manualLink('每日活动');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://rewards.bing.com/dashboard');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('offers the page entry on a failed claim row (for instance signed out)', () => {
    render({ claim: { status: 'failed', reason: '未登录' } });

    expect(manualLink('领取积分')).not.toBeNull();
  });

  it('offers no page entry on rows that need no handling', () => {
    render({
      search: { status: 'unconfirmed', reason: 'x' },
      daily: { status: 'completed' },
      claim: { status: 'not-needed' },
    });

    expect(manualLink('搜索')).toBeNull();
    expect(manualLink('每日活动')).toBeNull();
    expect(manualLink('领取积分')).toBeNull();
  });

  it('hides the page entry while the round is still running', () => {
    render({ daily: { status: 'unconfirmed', reason: 'x' } }, true);

    expect(manualLink('每日活动')).toBeNull();
  });
});
