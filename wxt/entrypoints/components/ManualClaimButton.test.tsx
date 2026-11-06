(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import ManualClaimButton from '@/entrypoints/components/ManualClaimButton';
import type { CommandReceipt } from '@/entrypoints/utils/runState';

// The button holds itself while its receipt is in flight, so a double click
// sends one command instead of a second one the background can only refuse.
// The send is mocked at the browser boundary; what is exercised is the gap
// between the click and the answer, and that a refusal stays visible after it.
describe('ManualClaimButton pending', () => {
  let host: HTMLDivElement;
  let root: Root;
  let stopped: number;
  let stopUnrolled: number;

  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    stopped = 0;
    stopUnrolled = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(props: {
    isRunning: boolean;
    isStopping: boolean;
    canStart: boolean;
    disabled: boolean;
  }): void {
    act(() => {
      root.render(
        <ManualClaimButton
          {...props}
          onStop={() => { stopped += 1; }}
          onStopFailed={() => { stopUnrolled += 1; }}
        />
      );
    });
  }

  function button(): HTMLButtonElement {
    const el = host.querySelector<HTMLButtonElement>('#button');
    if (!el) throw new Error('button missing');
    return el;
  }

  it('disables the button while its receipt is in flight and sends one command', async () => {
    render({ isRunning: false, isStopping: false, canStart: true, disabled: false });
    let answer!: (receipt: CommandReceipt) => void;
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockReturnValue(
      new Promise<CommandReceipt>((resolve) => { answer = resolve; }) as never
    );

    await act(async () => {
      button().click();
    });

    expect(button().disabled).toBe(true);
    expect(fakeBrowser.runtime.sendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer({ accepted: true });
    });

    expect(button().disabled).toBe(false);
    expect(fakeBrowser.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('frees the button after a refusal while keeping the reason shown', async () => {
    render({ isRunning: false, isStopping: false, canStart: true, disabled: false });
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ accepted: false, reason: '已有任务运行中' } as never);

    await act(async () => {
      button().click();
    });

    expect(button().disabled).toBe(false);
    expect(host.textContent).toContain('已有任务运行中');
  });

  // Regression: the start receipt only arrives once the first search step has
  // finished, but the run record exists before it — so the popup can already be
  // showing a running round while the start's receipt is still pending. Holding
  // the stop through that gap left no way to stop a stuck first round.
  it('keeps the stop button available while a start receipt is still in flight', async () => {
    render({ isRunning: false, isStopping: false, canStart: true, disabled: false });
    let answer!: (receipt: CommandReceipt) => void;
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockReturnValue(
      new Promise<CommandReceipt>((resolve) => { answer = resolve; }) as never
    );

    await act(async () => {
      button().click();
    });
    expect(button().disabled).toBe(true);

    // The background has recorded the run; the popup re-renders with it running.
    render({ isRunning: true, isStopping: false, canStart: true, disabled: false });

    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain('停止任务');

    await act(async () => {
      answer({ accepted: true });
    });
  });

  // Regression: onStop marks the round as stop-requested, and that mark was
  // only cleared when the round ended. A stop that was refused or never
  // answered while the round kept running left the button stuck on "正在停止"
  // — the unroll callback lets the caller take the mark back and try again.
  it('unrolls the stop request when the answer never arrives', async () => {
    render({ isRunning: true, isStopping: false, canStart: true, disabled: false });
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(new Error('no listener') as never);

    await act(async () => {
      button().click();
    });

    expect(stopped).toBe(1);
    expect(stopUnrolled).toBe(1);
    expect(host.textContent).toContain('未收到后台响应，请重试');
  });

  it('unrolls the stop request when the stop is refused', async () => {
    render({ isRunning: true, isStopping: false, canStart: true, disabled: false });
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ accepted: false, reason: '当前没有运行中的任务' } as never);

    await act(async () => {
      button().click();
    });

    expect(stopped).toBe(1);
    expect(stopUnrolled).toBe(1);
  });

  it('does not unroll a stop that was accepted', async () => {
    render({ isRunning: true, isStopping: false, canStart: true, disabled: false });
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ accepted: true } as never);

    await act(async () => {
      button().click();
    });

    expect(stopped).toBe(1);
    expect(stopUnrolled).toBe(0);
  });
});
