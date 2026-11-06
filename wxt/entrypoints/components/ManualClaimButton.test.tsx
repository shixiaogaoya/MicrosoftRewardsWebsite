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

  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    stopped = 0;
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
});
