import { describe, expect, it } from 'vitest';
import type { TaskResult, TaskResults } from '@/entrypoints/utils/runState';
import { combinedLoad, combinedSave, countNeedsHandling, nextRoundSummary, resultsOfRound, statusView } from './status';

function result(status: TaskResult['status']): TaskResult {
    return { status };
}

function view(overrides: Partial<Parameters<typeof statusView>[0]> = {}) {
    return statusView({
        isLoaded: true,
        isStopping: false,
        isRunning: false,
        results: {},
        ...overrides,
    });
}

describe('statusView', () => {
    it('follows the display priority', () => {
        expect(view({ isLoaded: false }).text).toBe('正在读取');
        expect(view({ isStopping: true, isRunning: true }).text).toBe('正在停止');
        expect(view({ isRunning: true, results: { search: result('failed') } }).text).toBe('正在执行');
    });

    it('names a failure before an unconfirmed or cancelled result', () => {
        expect(view({
            results: { search: result('failed'), daily: result('unconfirmed'), claim: result('cancelled') },
        }).text).toBe('本轮有任务失败');
        expect(view({
            results: { daily: result('unconfirmed'), claim: result('cancelled') },
        }).text).toBe('部分结果待确认');
        expect(view({ results: { search: result('cancelled') } }).text).toBe('本轮已停止');
    });

    it('calls a fully settled round complete, not stopped', () => {
        const settled: TaskResults = {
            search: result('completed'),
            daily: result('not-needed'),
            claim: result('completed'),
        };
        expect(view({ results: settled })).toEqual({ text: '本轮已完成', tone: 'done' });
        expect(view({ results: {} }).text).toBe('准备就绪');
    });
});

// A single-task retry keeps the other tasks' rows from earlier rounds. The
// outcome line may only speak for one round, so those kept rows stay out of
// it — stitched in, a completed retry over two old completions would report a
// complete round that never ran as one.
describe('resultsOfRound 与跨轮次的 outcome', () => {
    it('scopes the idle outcome to the newest round the rows can name', () => {
        const mixed: TaskResults = {
            search: { status: 'completed', runId: 2, at: 200 },
            daily: { status: 'completed', runId: 1, at: 100 },
            claim: { status: 'unconfirmed', runId: 1, at: 100 },
        };
        // The pill speaks for the retry round only: its row completed, so the
        // round is complete — the older unconfirmed row is not part of it.
        expect(view({ results: mixed }).text).toBe('本轮已完成');
        expect(resultsOfRound(mixed, null)).toEqual({ search: mixed.search });
        // A kept row still needing handling stays visible in the handling count.
        expect(countNeedsHandling(mixed)).toBe(1);
    });

    it('reports the newest round’s failure even beside older completions', () => {
        const mixed: TaskResults = {
            search: { status: 'failed', runId: 2, at: 200 },
            daily: { status: 'completed', runId: 1, at: 100 },
        };
        expect(view({ results: mixed }).text).toBe('本轮有任务失败');
    });

    it('scopes a running round to the live id, not the newest rows', () => {
        const stored: TaskResults = {
            search: { status: 'running', runId: 7 },
            daily: { status: 'completed', runId: 6, at: 100 },
        };
        expect(resultsOfRound(stored, 7)).toEqual({ search: stored.search });
    });

    it('treats rows stored before round marks as their own single round', () => {
        const legacy: TaskResults = {
            search: result('completed'),
            daily: result('completed'),
        };
        expect(view({ results: legacy }).text).toBe('本轮已完成');
        // Once any row carries a round id, an unmarked row predates it and is
        // not part of that round.
        const afterUpgrade: TaskResults = { ...legacy, claim: { status: 'completed', runId: 9, at: 900 } };
        expect(resultsOfRound(afterUpgrade, null)).toEqual({ claim: afterUpgrade.claim });
    });
});

describe('countNeedsHandling', () => {
    it('counts failed and unconfirmed, and leaves a cancel out', () => {
        expect(countNeedsHandling({
            search: result('failed'),
            daily: result('unconfirmed'),
            claim: result('cancelled'),
        })).toBe(2);
        expect(countNeedsHandling({ search: result('cancelled') })).toBe(0);
        expect(countNeedsHandling({ search: result('completed'), daily: result('not-needed') })).toBe(0);
    });
});

describe('combinedSave', () => {
    it('waits until every write has finished', () => {
        expect(combinedSave(['saved', 'saving'])).toBe('saving');
        expect(combinedSave(['saving', 'idle'])).toBe('saving');
        expect(combinedSave(['saved', 'saved'])).toBe('saved');
        expect(combinedSave(['saved', 'error'])).toBe('error');
        expect(combinedSave(['idle', 'idle'])).toBe('idle');
    });
});

describe('combinedLoad', () => {
    it('shows a failure before an in-flight read, and loaded only when all reads finish', () => {
        expect(combinedLoad(['loaded', 'loading'])).toBe('loading');
        expect(combinedLoad(['loading', 'loaded'])).toBe('loading');
        expect(combinedLoad(['loaded', 'error'])).toBe('error');
        expect(combinedLoad(['error', 'loading'])).toBe('error');
        expect(combinedLoad(['loaded', 'loaded'])).toBe('loaded');
    });
});

describe('nextRoundSummary', () => {
    it('includes the search count only when search is selected', () => {
        expect(nextRoundSummary({
            search: true, daily: true, claim: false, searches: 30, timeout: 60,
        })).toBe('搜索 · 每日活动 30 次 · 间隔 60 秒');
        expect(nextRoundSummary({
            search: false, daily: true, claim: false, searches: 30, timeout: 60,
        })).toBe('每日活动');
        expect(nextRoundSummary({
            search: false, daily: false, claim: true, searches: 30, timeout: 60,
        })).toBe('领取积分');
        expect(nextRoundSummary({
            search: false, daily: false, claim: false, searches: 30, timeout: 60,
        })).toBe('未选择任务');
    });
});
