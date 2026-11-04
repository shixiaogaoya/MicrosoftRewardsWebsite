import { browser } from 'wxt/browser';
import type { TaskKind, TaskResult, TaskResults, TaskStatus } from '@/entrypoints/utils/runState';
import Icon from './Icon';

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
            <span className={`task-indicator task-indicator--${result.status === 'failed' ? 'error' : tone}`} aria-hidden="true">
                <Icon name={tone === 'done' ? 'check' : tone === 'attention' ? 'circle-help' : tone === 'busy' ? 'clock' : 'circle'} />
            </span>
            <div className="task-body">
                <div className="task-row">
                    <span className="task-name">{LABELS[kind]}</span>
                    <span className="task-actions">
                        <span className={`task-status task-status--${result.status === 'failed' ? 'error' : tone}`}>{STATUS_TEXT[result.status]}</span>
                        {canRetry && (
                            <button type="button" className="task-retry" onClick={() => retry(kind)} aria-label={`重试${LABELS[kind]}`}>
                                <Icon name="rotate-ccw" />
                            </button>
                        )}
                    </span>
                </div>
                {result.reason && <p className="task-reason">{result.reason}</p>}
            </div>
        </li>
    );
}

function retry(kind: TaskKind): void {
    browser.runtime.sendMessage({ action: 'popup', only: [kind] });
}

export default TaskResultsList;
