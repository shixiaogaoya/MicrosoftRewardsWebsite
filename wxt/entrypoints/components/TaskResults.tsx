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

interface TaskResultsProps {
    results: TaskResults;
    isRunning: boolean;
    // The main list is one line per task. Reason text and the retry control
    // stay in the expanded detail, so the main screen keeps a single button.
    detailed?: boolean;
}

// One line per task that this round actually ran. A task that was not selected
// is absent, so it is not shown as "not needed".
function TaskResultsList({ results, isRunning, detailed = false }: TaskResultsProps) {
    const rows = ORDER.filter((kind) => results[kind] && (!detailed || needsDetail(results[kind])));
    if (rows.length === 0) return null;

    return (
        <ul className="task-results">
            {rows.map((kind) => (
                <TaskRow key={kind} kind={kind} result={results[kind]!} isRunning={isRunning} detailed={detailed} />
            ))}
        </ul>
    );
}

function needsDetail(result: TaskResult | undefined): boolean {
    return result != null && result.status !== 'completed' && result.status !== 'not-needed' && result.status !== 'running';
}

function TaskRow({ kind, result, isRunning, detailed }: { kind: TaskKind; result: TaskResult; isRunning: boolean; detailed: boolean }) {
    const canRetry = detailed && !isRunning && (result.status === 'failed' || result.status === 'unconfirmed' || result.status === 'cancelled');
    return (
        <li className={`task-result task-result--${result.status}`}>
            <span className="task-result-name">{LABELS[kind]}</span>
            <span className="task-result-status">{STATUS_TEXT[result.status]}</span>
            {detailed && result.reason && <span className="task-result-reason">{result.reason}</span>}
            {canRetry && (
                <button type="button" className="task-retry" onClick={() => retry(kind)}>
                    重试此任务
                </button>
            )}
        </li>
    );
}

function retry(kind: TaskKind): void {
    browser.runtime.sendMessage({ action: 'popup', only: [kind] });
}

export default TaskResultsList;
