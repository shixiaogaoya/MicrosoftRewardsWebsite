import { browser } from 'wxt/browser';
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
    // The disabled prop carries the settings' read/save state, which only
    // matters for starting: starting runs on the values on screen. Stopping
    // sends no values, so a running round keeps the button available unless its
    // stop request is already in flight.
    const blocked = isRunning ? isStopping : disabled || !canStart;
    function handleClick() {
        if (blocked) return;
        if (isRunning) onStop();
        browser.runtime.sendMessage({ action: isRunning ? 'stop' : 'popup' });
    }

    const label = isStopping ? '正在停止' : isRunning ? '停止任务' : '开始任务';
    return (
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
    );
}

export default ManualClaimButton;
