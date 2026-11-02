import { browser } from 'wxt/browser';
import type { TaskKind, TaskResult, TaskResults, TaskStatus } from '@/entrypoints/utils/runState';

const LABELS: Record<TaskKind, string> = {
    search: '搜索',
    daily: '每日活动',
    claim: '领取积分',
};

const STATUS_TEXT: Record<TaskStatus, string> = {
    running: '进行中',
    completed: '已完成流程',
    'not-needed': '无需执行',
    failed: '失败',
    unconfirmed: '结果待确认',
    cancelled: '已取消',
};

const ORDER: TaskKind[] = ['search', 'daily', 'claim'];

type Tone = 'done' | 'attention' | 'busy' | 'idle';

const TONE: Record<TaskStatus, Tone> = {
    running: 'busy',
    completed: 'done',
    'not-needed': 'done',
    failed: 'attention',
    unconfirmed: 'attention',
    cancelled: 'attention',
};

interface TaskResultsProps {
    results: TaskResults;
    isRunning: boolean;
}

// One row per task that this round actually ran. A task that was not selected
// is absent, so it is not shown as "not needed". The reason and the retry
// control sit inline: a collapsed duplicate of the same list added a click
// without adding information.
function TaskResultsList({ results, isRunning }: TaskResultsProps) {
    const rows = ORDER.filter((kind) => results[kind]);
    if (rows.length === 0) return null;

    return (
        <ul className="task-results">
            {rows.map((kind) => (
                <TaskRow key={kind} kind={kind} result={results[kind]!} isRunning={isRunning} />
            ))}
        </ul>
    );
}

function TaskRow({ kind, result, isRunning }: { kind: TaskKind; result: TaskResult; isRunning: boolean }) {
    const canRetry = !isRunning && (result.status === 'failed' || result.status === 'unconfirmed' || result.status === 'cancelled');
    const tone = TONE[result.status];
    return (
        <li className="task-item">
            <div className="task-rail" aria-hidden="true">
                <span className={`task-dot task-dot--${tone}`}>
                    <DotIcon tone={tone} />
                </span>
                <span className="task-line" />
            </div>
            <div className="task-body">
                <div className="task-row">
                    <span className="task-name">{LABELS[kind]}</span>
                    <span className="task-actions">
                        <span className={`task-status task-status--${tone}`}>{STATUS_TEXT[result.status]}</span>
                        {canRetry && (
                            <button type="button" className="task-retry" onClick={() => retry(kind)} aria-label={`重试${LABELS[kind]}`}>
                                <RetryIcon />
                            </button>
                        )}
                    </span>
                </div>
                {result.reason && <p className="task-reason">{result.reason}</p>}
            </div>
        </li>
    );
}

function DotIcon({ tone }: { tone: Tone }) {
    if (tone === 'done') {
        return (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
        );
    }
    if (tone === 'attention') {
        return (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <path d="M12 6.5v7M12 17.5h.01" />
            </svg>
        );
    }
    if (tone === 'busy') {
        return (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <path d="M12 3a9 9 0 0 1 9 9" />
            </svg>
        );
    }
    return <span style={{ width: '0.5rem', height: '0.5rem', borderRadius: '999px', background: '#94a3b0' }} />;
}

function RetryIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 5.7" />
            <path d="M20 4.5V11h-6.5" />
        </svg>
    );
}

function retry(kind: TaskKind): void {
    browser.runtime.sendMessage({ action: 'popup', only: [kind] });
}

export default TaskResultsList;
