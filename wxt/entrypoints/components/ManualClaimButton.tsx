import { browser } from 'wxt/browser';

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
    function handleClick() {
        if (disabled || (!isRunning && !canStart)) return;
        if (isRunning) onStop();
        browser.runtime.sendMessage({ action: isRunning ? 'stop' : 'popup' });
    }

    const label = isStopping ? '正在停止' : isRunning ? '停止任务' : '开始任务';
    return (
        <button
            id="button"
            className={`btn action-button my-1 ${isRunning ? 'btn-fail' : 'btn-success'}`}
            onClick={handleClick}
            disabled={disabled || (!isRunning && !canStart)}
            aria-disabled={disabled || (!isRunning && !canStart)}
        >
            {label}
        </button>
    );
}

export default ManualClaimButton;
