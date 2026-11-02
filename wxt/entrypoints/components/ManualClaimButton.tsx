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
            className={`btn action-button${isRunning ? ' btn-fail' : ''}`}
            onClick={handleClick}
            disabled={disabled || (!isRunning && !canStart)}
            aria-disabled={disabled || (!isRunning && !canStart)}
        >
            {isRunning ? <StopIcon /> : <PlayIcon />}
            {label}
        </button>
    );
}

function PlayIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7 5l12 7-12 7z" />
        </svg>
    );
}

function StopIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
    );
}

export default ManualClaimButton;
