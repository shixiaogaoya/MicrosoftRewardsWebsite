import { useState } from 'react';
import { browser } from 'wxt/browser';
import type { CommandReceipt } from '@/entrypoints/utils/runState';
import Icon from './Icon';

interface ManualClaimButtonProps {
    isRunning: boolean;
    isStopping: boolean;
    canStart: boolean;
    disabled: boolean;
    onStop: () => void;
}

// Starts the selected tasks, or stops the round that is running. The background
// owns that state, so this button only sends the request. Auto-run being off
// does not disable it: that switch only stops the alarm and startup from
// starting a round on their own.
function ManualClaimButton({ isRunning, isStopping, canStart, disabled, onStop }: ManualClaimButtonProps) {
    // The background answers with a receipt. A refusal — a start that found a
    // round already running, a stop with nothing left to stop — is shown next
    // to the button, so the click is explained instead of silently ignored.
    const [rejection, setRejection] = useState<string | null>(null);
    // The button is held while its receipt is in flight: a second click in that
    // gap would only send another command the background has to refuse.
    const [pending, setPending] = useState(false);
    // The disabled prop carries the settings' read/save state, which only
    // matters for starting: starting runs on the values on screen. Stopping
    // sends no values, so a running round keeps the button available unless its
    // stop request is already in flight.
    const blocked = pending || (isRunning ? isStopping : disabled || !canStart);
    async function handleClick() {
        if (blocked) return;
        setRejection(null);
        setPending(true);
        if (isRunning) onStop();
        try {
            const receipt = await browser.runtime.sendMessage({ action: isRunning ? 'stop' : 'popup' }) as CommandReceipt | undefined;
            if (receipt && !receipt.accepted) setRejection(receipt.reason);
        } catch {
            setRejection('未收到后台响应，请重试');
        } finally {
            setPending(false);
        }
    }

    const label = isStopping ? '正在停止' : isRunning ? '停止任务' : '开始任务';
    return (
        <>
            <button
                id="button"
                className="btn action-button"
                onClick={handleClick}
                disabled={blocked}
                aria-disabled={blocked}
            >
                <Icon name={isRunning ? 'square' : 'play'} />
                {label}
            </button>
            {rejection && (
                <p className="field-warning" role="status">{rejection}</p>
            )}
        </>
    );
}

export default ManualClaimButton;
