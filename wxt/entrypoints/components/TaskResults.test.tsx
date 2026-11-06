(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import TaskResultsList from '@/entrypoints/components/TaskResults';
import type { CommandReceipt, TaskResults } from '@/entrypoints/utils/runState';

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
