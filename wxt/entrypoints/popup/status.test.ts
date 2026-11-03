import { describe, expect, it } from 'vitest';
import type { TaskResult, TaskResults } from '@/entrypoints/utils/runState';
import { combinedSave, countNeedsHandling, nextRoundSummary, statusView } from './status';

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
