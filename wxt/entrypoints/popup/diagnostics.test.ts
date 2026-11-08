import { describe, expect, it } from 'vitest';
import { buildDiagnosticReport, diagnosticFileName, formatDiagnosticReport } from '@/entrypoints/popup/diagnostics';
import { RECOGNIZER_VERSION } from '@/entrypoints/utils/rewardsRecognition';
import type { RunProgress, TaskResults, TaskRunState } from '@/entrypoints/utils/runState';

// A11 的定位字段集合：扩展版本、浏览器版本、轮次时间、任务状态、调度时间、
// 结构化错误原因、识别器版本。导出是白名单重构，所以这里同时验证两件事：
// 需要的字段都在，存储里混入的敏感内容（账号、邮箱、Cookie、Token、带查询
// 参数的 URL、页面 HTML、搜索词）一个都进不来。
const NOW = 1762502400000; // 2026-01-01T00:00:00.000Z 附近的固定时刻

describe('buildDiagnosticReport 定位字段', () => {
    it('包含版本、时间、任务状态、结构化原因与识别器版本', () => {
        const report = buildDiagnosticReport({
            extensionVersion: '3.1.5',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
            now: NOW,
            run: {
                id: 7,
                phase: 'running',
                search: true,
                daily: true,
                claim: false,
                startedAt: NOW - 60000,
            } as TaskRunState,
            results: {
                search: { status: 'failed', at: NOW - 30000, runId: 7 },
                daily: { status: 'unconfirmed', cause: 'unknown-structure', recognizerVersion: 1, at: NOW - 10000, runId: 7 },
            },
            progress: { opened: 3, total: 10, isSearching: true } as RunProgress,
            nextCheckAt: NOW + 3600000,
            scheduleNotedAt: NOW - 86400000,
        });

        expect(report.extensionVersion).toBe('3.1.5');
        expect(report.userAgent).toContain('Chrome/131');
        expect(report.generatedAt).toBe(new Date(NOW).toISOString());
        expect(report.recognizerVersion).toBe(RECOGNIZER_VERSION);
        expect(report.run).toEqual({
            id: 7,
            phase: 'running',
            startedAt: new Date(NOW - 60000).toISOString(),
            tasks: { search: true, daily: true, claim: false },
            progress: { opened: 3, total: 10, isSearching: true },
        });
        expect(report.results.search).toEqual({ status: 'failed', at: new Date(NOW - 30000).toISOString(), runId: 7 });
        expect(report.results.daily).toEqual({
            status: 'unconfirmed',
            cause: 'unknown-structure',
            recognizerVersion: 1,
            at: new Date(NOW - 10000).toISOString(),
            runId: 7,
        });
        expect(report.schedule).toEqual({
            nextCheckAt: new Date(NOW + 3600000).toISOString(),
            notedAt: new Date(NOW - 86400000).toISOString(),
        });
    });

    it('无轮次、无闹钟时对应字段为空而不是编造', () => {
        const report = buildDiagnosticReport({
            extensionVersion: '3.1.5',
            userAgent: 'ua',
            now: NOW,
            run: null,
            results: {},
            progress: null,
            nextCheckAt: null,
            scheduleNotedAt: null,
        });
        expect(report.run).toBeNull();
        expect(report.results).toEqual({});
        expect(report.schedule).toEqual({ nextCheckAt: null, notedAt: null });
    });

    it('轮次开始时间不合形状时为 null，不回退成导出时刻等其他值', () => {
        const report = buildDiagnosticReport({
            extensionVersion: '3.1.5',
            userAgent: 'ua',
            now: NOW,
            run: {
                id: 7,
                phase: 'running',
                search: true,
                daily: false,
                claim: false,
                startedAt: '不是时间戳',
            } as unknown as TaskRunState,
            results: {},
            progress: null,
            nextCheckAt: null,
            scheduleNotedAt: null,
        });
        expect(report.run?.id).toBe(7);
        expect(report.run?.startedAt).toBeNull();
        expect(formatDiagnosticReport(report)).not.toContain(String(NOW));
    });
});

describe('buildDiagnosticReport 脱敏', () => {
    it('存储里混入敏感字段不会进入导出', () => {
        // 模拟被污染/旧版本遗留的存储：结果行、轮次记录和进度里塞进了
        // 账号、邮箱、Cookie、Token、完整查询串 URL、页面 HTML 和搜索词。
        const results = {
            search: {
                status: 'failed',
                reason: 'user@example.com 打开 https://www.bing.com/search?q=秘密搜索词&form=QBLH 失败',
                at: NOW,
                runId: 7,
                account: 'user@example.com',
                cookie: 'MUID=abc; _RwBf=169k',
                token: 'EwAoK8q7mXHFBBBB',
                html: '<html><body>rewards dashboard</body></html>',
            },
            daily: {
                status: 'unconfirmed',
                reason: '页面未在时限内返回结果',
                // 非识别器枚举里的 cause（例如被误写的 URL）不带出去。
                cause: 'https://rewards.bing.com/?redir=secret',
                recognizerVersion: 1,
                at: NOW,
                runId: 7,
            },
        } as unknown as TaskResults;
        const run = {
            id: 7,
            phase: 'running',
            search: true,
            daily: true,
            claim: true,
            startedAt: NOW,
            email: 'user@example.com',
            cookie: 'MUID=abc',
            url: 'https://www.bing.com/search?q=秘密搜索词',
            dashboardTabId: 42,
            searchTabIds: [43, 44],
        } as unknown as TaskRunState;
        const progress = {
            opened: 2,
            total: 5,
            isSearching: true,
            lastQuery: '秘密搜索词',
        } as unknown as RunProgress;

        const text = formatDiagnosticReport(buildDiagnosticReport({
            extensionVersion: '3.1.5',
            userAgent: 'Mozilla/5.0 Chrome/131.0.0.0',
            now: NOW,
            run,
            results,
            progress,
            nextCheckAt: NOW + 1000,
            scheduleNotedAt: NOW,
        }));

        expect(text).toContain('"extensionVersion": "3.1.5"');
        expect(text).toContain('"status": "failed"');
        for (const secret of [
            'user@example.com',
            'MUID',
            '_RwBf',
            'EwAoK8q7mXHFBBBB',
            'q=',
            '秘密搜索词',
            '<html',
            'rewards.bing.com',
            'redir=secret',
            'reason',
            'lastQuery',
            'cookie',
            'token',
            'account',
            'email',
            'url',
            'html',
        ]) {
            expect(text).not.toContain(secret);
        }
    });

    it('状态与时间不合形状的行整行丢弃，不输出半成品', () => {
        const report = buildDiagnosticReport({
            extensionVersion: '3.1.5',
            userAgent: 'ua',
            now: NOW,
            run: null,
            results: {
                search: { status: 'weird-status', cause: 'timeout' } as never,
                daily: { status: 'completed', at: '不是时间戳' } as never,
                claim: { status: 'completed', at: NOW, cause: 'timeout', recognizerVersion: 1 },
            },
            progress: null,
            nextCheckAt: null,
            scheduleNotedAt: null,
        });
        expect(report.results.search).toBeUndefined();
        expect(report.results.daily).toEqual({ status: 'completed' });
        expect(report.results.claim).toEqual({ status: 'completed', at: new Date(NOW).toISOString(), cause: 'timeout', recognizerVersion: 1 });
    });
});

describe('diagnosticFileName', () => {
    it('只含扩展版本与本地日期', () => {
        const name = diagnosticFileName('3.1.5', new Date(2026, 10, 7, 9, 30).getTime());
        expect(name).toBe('rewards-diagnostics-v3.1.5-2026-11-07.json');
    });
});
