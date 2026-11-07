import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { belongsToRound, roundReference, type CommandReceipt, type TaskKind, type TaskResult, type TaskResults, type TaskStatus } from '@/entrypoints/utils/runState';
import Icon from './Icon';

const LABELS: Record<TaskKind, string> = {
    search: '搜索',
    daily: '每日活动',
    claim: '领取积分',
};

// Same shape as the popup's check-time formatter: date plus clock time, so a
// kept result's moment can be written next to its round.
const RESULT_TIME = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

const STATUS_TEXT: Record<TaskStatus, string> = {
    running: '进行中',
    completed: '已完成流程',
    'not-needed': '无需执行',
    failed: '失败',
    unconfirmed: '结果待确认',
    cancelled: '已取消',
};

const ORDER: TaskKind[] = ['search', 'daily', 'claim'];

// 手动入口（A08）：每日活动与领取在“待确认/失败”时，页面上可能有识别器
// 无法确认的内容——未知类型的卡片、需要实际作答的活动、或根本无法判读的
// 结构。这里只打开页面，由用户自己处理；不扩大扩展的自动点击范围。
const MANUAL_PAGE_URL = 'https://rewards.bing.com/dashboard';

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
    // The live round's id, or null/undefined when nothing runs. Rows that do
    // not belong to it are the previous rounds' kept results and say so.
    runId?: number | null;
    // A retry starts a round on the stored settings, so it shares the main
    // start button's gate: a value still being read, or one whose write has
    // not gone through, is not a value a round may run on.
    settingsNotReady?: boolean;
}

// One row per task with a stored result: this round's own tasks while it runs,
// and after a single-task retry also the other tasks' kept results from the
// rounds that last ran them. A task that was never run is absent, so it is not
// shown as "not needed". The reason and the retry control sit inline: a
// collapsed duplicate of the same list added a click without adding
// information.
function TaskResultsList({ results, isRunning, runId, settingsNotReady }: TaskResultsProps) {
    const rows = ORDER.filter((kind) => results[kind]);
    if (rows.length === 0) return null;
    // While a round runs, its own rows are "this round" and the kept ones are
    // "a previous round". While nothing runs, the newest round the rows can
    // name stands in, so its rows read as the latest results — not as older
    // ones — and only rows from rounds before that are marked.
    const reference = roundReference(results, runId ?? null);

    return (
        <ul className="task-results">
            {rows.map((kind) => (
                <TaskRow key={kind} kind={kind} result={results[kind]!} isRunning={isRunning} isCurrentRound={belongsToRound(results[kind]!, reference)} settingsNotReady={settingsNotReady} />
            ))}
        </ul>
    );
}

function TaskRow({ kind, result, isRunning, isCurrentRound, settingsNotReady }: { kind: TaskKind; result: TaskResult; isRunning: boolean; isCurrentRound: boolean; settingsNotReady?: boolean }) {
    // The retry asks the background and shows its answer on the row it belongs
    // to. A task whose toggle was switched off after it ran is refused — told
    // so, not silently ignored, and never switched back on by the retry itself.
    const [rejection, setRejection] = useState<string | null>(null);
    // The row is keyed by task kind, so a new round reuses this component with a
    // fresh result object; the refusal the previous round's retry collected
    // belongs to that round and must not resurface once running ends again.
    useEffect(() => {
        setRejection(null);
    }, [result]);
    // The row's retry button is held while its receipt is in flight, so a
    // double click sends one command instead of a second one to be refused.
    const [pending, setPending] = useState(false);
    const canRetry = !isRunning && (result.status === 'failed' || result.status === 'unconfirmed' || result.status === 'cancelled');
    // The gate is checked in the handler as well as on the button: a click can
    // be dispatched around the disabled attribute.
    const retryBlocked = pending || settingsNotReady;
    const tone = TONE[result.status];
    // 自动点击只覆盖已知形状；这两类任务的结果一旦需要处理，页面入口交给
    // 用户。搜索不需要：它的执行与结果都在扩展自己打开的页面上。
    const needsManualEntry = !isRunning && kind !== 'search'
        && (result.status === 'unconfirmed' || result.status === 'failed');
    async function retryTask(): Promise<void> {
        if (retryBlocked) return;
        setRejection(null);
        setPending(true);
        try {
            const receipt = await browser.runtime.sendMessage({ action: 'popup', only: [kind] }) as CommandReceipt | undefined;
            if (receipt && !receipt.accepted) setRejection(receipt.reason);
        } catch {
            setRejection('未收到后台响应，请重试');
        } finally {
            setPending(false);
        }
    }
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
                            <button type="button" className="task-retry" onClick={retryTask} disabled={retryBlocked} aria-disabled={retryBlocked} aria-label={`重试${LABELS[kind]}`}>
                                <Icon name="rotate-ccw" />
                            </button>
                        )}
                        {needsManualEntry && (
                            <a className="task-retry" href={MANUAL_PAGE_URL} target="_blank" rel="noopener noreferrer" aria-label={`打开页面处理${LABELS[kind]}`} title="打开页面处理">
                                <Icon name="external-link" />
                            </a>
                        )}
                    </span>
                </div>
                {/* A kept result is the last outcome of a round that is not the
                    one on screen now. The time is the moment it was written —
                    absent on results stored before it was recorded, and then
                    the round alone is named rather than a made-up time. */}
                {!isCurrentRound && (
                    <p className="task-meta">
                        {result.at != null ? `来自上一轮 · ${RESULT_TIME.format(result.at)}` : '来自上一轮'}
                    </p>
                )}
                {result.reason && <p className="task-reason">{result.reason}</p>}
                {rejection && !isRunning && <p className="task-reason" role="status">{rejection}</p>}
            </div>
        </li>
    );
}

export default TaskResultsList;
