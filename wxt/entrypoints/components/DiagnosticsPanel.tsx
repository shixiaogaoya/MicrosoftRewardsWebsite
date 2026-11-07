import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { PROGRESS_KEY, RUN_KEY, type RunProgress, type TaskResults, type TaskRunState } from '@/entrypoints/utils/runState';
import {
    buildDiagnosticReport,
    diagnosticFileName,
    downloadDiagnostics,
    formatDiagnosticReport,
    type DiagnosticReport,
} from '@/entrypoints/popup/diagnostics';

// The background's daily-check alarm, and the local stamp it writes after each
// reschedule — the same literals the popup elsewhere reads them by.
const DAILY_CHECK_ALARM = 'dailyCheck';
const SCHEDULE_STAMP_KEY = 'dailyCheckScheduledAt';

// A11：本地诊断视图。打开时一次性读取后台状态并构造白名单快照，先预览
// 再导出；导出走本地下载，不经过任何网络。技术字段只出现在这里，普通
// 界面保持简明。
export default function DiagnosticsPanel({ results }: { results: TaskResults }) {
    const [report, setReport] = useState<DiagnosticReport | null>(null);
    const [failed, setFailed] = useState(false);

    // 预览与导出始终同源：本视图持有的是打开期间的一份快照，results 的
    // 订阅更新（新一轮写入结果）会让快照重建，导出按钮永远导出当前预览。
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const [stored, alarm] = await Promise.all([
                    browser.storage.local.get([RUN_KEY, PROGRESS_KEY, SCHEDULE_STAMP_KEY]),
                    browser.alarms.get(DAILY_CHECK_ALARM),
                ]);
                if (cancelled) return;
                const stamp = stored[SCHEDULE_STAMP_KEY];
                setReport(buildDiagnosticReport({
                    extensionVersion: browser.runtime.getManifest().version,
                    userAgent: navigator.userAgent,
                    now: Date.now(),
                    run: (stored[RUN_KEY] ?? null) as TaskRunState | null,
                    results,
                    progress: (stored[PROGRESS_KEY] ?? null) as RunProgress | null,
                    nextCheckAt: alarm?.scheduledTime ?? null,
                    scheduleNotedAt: typeof stamp === 'number' ? stamp : null,
                }));
            } catch {
                if (!cancelled) setFailed(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [results]);

    if (report == null) {
        return (
            <section className="card" aria-labelledby="diagnostics-heading">
                <h2 id="diagnostics-heading" className="card-title">诊断信息</h2>
                <p className="field-note" role="status">{failed ? '诊断信息读取失败，请关闭后重试' : '正在读取诊断信息'}</p>
            </section>
        );
    }

    const text = formatDiagnosticReport(report);

    return (
        <section className="card" aria-labelledby="diagnostics-heading">
            <h2 id="diagnostics-heading" className="card-title">诊断信息</h2>
            <p className="field-note">用于反馈问题的脱敏快照：扩展版本、浏览器 User-Agent（含浏览器与操作系统版本等环境信息）、轮次与调度时间、任务状态和结构化原因。不含账号、邮箱、Cookie、令牌、搜索内容和页面内容。</p>
            <pre className="diag-preview" aria-label="诊断内容预览">{text}</pre>
            <button
                type="button"
                className="btn"
                id="diagnosticExport"
                onClick={() => downloadDiagnostics(text, diagnosticFileName(report.extensionVersion, Date.now()))}
            >
                导出 JSON 文件
            </button>
        </section>
    );
}
