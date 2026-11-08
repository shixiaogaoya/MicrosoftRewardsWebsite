import type { LoadState, SaveState } from '@/entrypoints/hooks/useStorage';
import { belongsToRound, roundReference, type TaskResult, type TaskResults, type TaskStatus } from '@/entrypoints/utils/runState';

export type StatusTone = 'idle' | 'busy' | 'attention' | 'done';

export interface StatusView {
    text: string;
    tone: StatusTone;
}

const NEEDS_HANDLING: ReadonlySet<TaskStatus> = new Set(['failed', 'unconfirmed']);

export function needsHandling(result: TaskResult | undefined): boolean {
    return result != null && NEEDS_HANDLING.has(result.status);
}

// Failed and unconfirmed are the items the user still has to look at.
// A cancel is shown on its own row and is not one of those.
export function countNeedsHandling(results: TaskResults): number {
    return [results.search, results.daily, results.claim].filter(needsHandling).length;
}

function present(results: TaskResults): TaskResult[] {
    return [results.search, results.daily, results.claim].filter((result): result is TaskResult => result != null);
}

// The rows of one round: the live one while it runs, else the newest round the
// stored rows can name. A single-task retry keeps the other tasks' rows from
// earlier rounds, and those must stay out of any "this round" line — stitching
// them in would report a complete round that never ran as one.
export function resultsOfRound(results: TaskResults, runId: number | null): TaskResults {
    const reference = roundReference(results, runId);
    const picked: TaskResults = {};
    for (const kind of ['search', 'daily', 'claim'] as const) {
        const row = results[kind];
        if (row != null && belongsToRound(row, reference)) picked[kind] = row;
    }
    return picked;
}

// Priority, top to bottom: unread, stopping, running, then the settled outcome.
// A finished round that only completed (or had nothing to do) is not "stopped".
// The outcome speaks for one round only, never a mix of a round and the earlier
// results a retry kept.
export function statusView(input: {
    isLoaded: boolean;
    isStopping: boolean;
    isRunning: boolean;
    results: TaskResults;
}): StatusView {
    if (!input.isLoaded) return { text: '正在读取', tone: 'idle' };
    if (input.isStopping) return { text: '正在停止', tone: 'busy' };
    if (input.isRunning) return { text: '正在执行', tone: 'busy' };

    const rows = present(resultsOfRound(input.results, null));
    if (rows.some((result) => result.status === 'failed')) return { text: '本轮有任务失败', tone: 'attention' };
    if (rows.some((result) => result.status === 'unconfirmed')) return { text: '部分结果待确认', tone: 'attention' };
    if (rows.some((result) => result.status === 'cancelled')) return { text: '本轮已停止', tone: 'attention' };
    if (rows.length > 0 && rows.every((result) => result.status === 'completed' || result.status === 'not-needed')) {
        return { text: '本轮已完成', tone: 'done' };
    }
    return { text: '准备就绪', tone: 'idle' };
}

const TASK_LABELS = [
    ['search', '搜索'],
    ['daily', '每日活动'],
    ['claim', '领取积分'],
] as const;

// A write still in flight wins over an earlier success. One field finishing
// must not report the popup saved while another field is still writing.
export function combinedSave(states: SaveState[]): SaveState {
    if (states.includes('error')) return 'error';
    if (states.includes('saving')) return 'saving';
    if (states.includes('saved')) return 'saved';
    return 'idle';
}

// Same precedence as combinedSave: a failed read is shown even while another
// one is still on its way, and every read must have finished before the
// settings count as loaded.
export function combinedLoad(states: LoadState[]): LoadState {
    if (states.includes('error')) return 'error';
    if (states.includes('loading')) return 'loading';
    return 'loaded';
}

// Idle summary of the next round. Search count and gap belong to the search
// task; a round that only runs daily or claim does not mention them.
export function nextRoundSummary(input: {
    search: boolean;
    daily: boolean;
    claim: boolean;
    searches: number;
    timeout: number;
}): string {
    const selected = TASK_LABELS.filter(([key]) => input[key]).map(([, label]) => label);
    if (selected.length === 0) return '未选择任务';
    const tasks = selected.join(' · ');
    if (!input.search) return tasks;
    return `${tasks} ${input.searches} 次 · 间隔 ${input.timeout} 秒`;
}
