import { RECOGNIZER_VERSION, RECOGNITION_CAUSES } from '@/entrypoints/utils/rewardsRecognition';
import type { RunProgress, TaskResult, TaskResults, TaskRunState } from '@/entrypoints/utils/runState';

// A11 脱敏诊断。导出不是存储对象的拷贝，而是白名单字段的重新构造：
// 每个字段单独取值并校验，存储里出现的其他内容（账号、邮箱、Cookie、
// Token、带查询参数的 URL、页面 HTML、搜索词）没有进入导出的通路。
// 显示用 reason 也不导出：它可能拼进了 error.message，无法保证不含 URL；
// 定位用的错误原因是封闭枚举的结构化 cause，见 rewardsRecognition。
export interface DiagnosticInput {
    extensionVersion: string;
    userAgent: string;
    // 导出生成时刻，用于判断各时间字段的新旧。
    now: number;
    run: TaskRunState | null;
    results: TaskResults;
    progress: RunProgress | null;
    // dailyCheck 闹钟的 scheduledTime；闹钟未创建时为 null。
    nextCheckAt: number | null;
    // 本地 dailyCheckScheduledAt 的值：后台最后一次创建或清除闹钟的时刻。
    scheduleNotedAt: number | null;
}

export interface DiagnosticTaskResult {
    status: string;
    // 仅识别器写入的封闭枚举（RECOGNITION_CAUSES）里的值会被带上。
    cause?: string;
    recognizerVersion?: number;
    at?: string;
    runId?: number;
}

export interface DiagnosticRun {
    id: number;
    phase: string;
    // 存储里的开始时间不合形状时为 null，不回退成其他时刻。
    startedAt: string | null;
    tasks: { search: boolean; daily: boolean; claim: boolean };
    progress: { opened: number; total: number; isSearching: boolean };
}

export interface DiagnosticReport {
    extensionVersion: string;
    userAgent: string;
    generatedAt: string;
    // 当前识别器版本；各行结果另带写入它的识别器版本。
    recognizerVersion: number;
    run: DiagnosticRun | null;
    results: Partial<Record<string, DiagnosticTaskResult>>;
    schedule: { nextCheckAt: string | null; notedAt: string | null };
}

const CAUSE_SET: ReadonlySet<string> = new Set(RECOGNITION_CAUSES);
const STATUS_SET: ReadonlySet<string> = new Set(['running', 'completed', 'not-needed', 'failed', 'unconfirmed', 'cancelled']);
const PHASE_SET: ReadonlySet<string> = new Set(['running', 'stopping']);

function iso(value: unknown): string | null {
    return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function flag(value: unknown): boolean {
    return value === true;
}

function taskResult(row: TaskResult | undefined): DiagnosticTaskResult | undefined {
    if (row == null || typeof row.status !== 'string' || !STATUS_SET.has(row.status)) return undefined;
    const picked: DiagnosticTaskResult = { status: row.status };
    if (typeof row.cause === 'string' && CAUSE_SET.has(row.cause)) picked.cause = row.cause;
    if (num(row.recognizerVersion) != null) picked.recognizerVersion = row.recognizerVersion;
    if (num(row.at) != null) picked.at = iso(row.at) ?? undefined;
    if (num(row.runId) != null) picked.runId = row.runId;
    return picked;
}

export function buildDiagnosticReport(input: DiagnosticInput): DiagnosticReport {
    const run = input.run != null && num(input.run.id) != null && typeof input.run.phase === 'string' && PHASE_SET.has(input.run.phase)
        ? {
            id: input.run.id,
            phase: input.run.phase,
            startedAt: iso(input.run.startedAt),
            // 本轮被要求执行哪些任务；不含标签页 id 与设置数值。
            tasks: { search: flag(input.run.search), daily: flag(input.run.daily), claim: flag(input.run.claim) },
            progress: {
                opened: num(input.progress?.opened) ?? 0,
                total: num(input.progress?.total) ?? 0,
                isSearching: flag(input.progress?.isSearching),
            },
        }
        : null;

    const results: Partial<Record<string, DiagnosticTaskResult>> = {};
    for (const kind of ['search', 'daily', 'claim'] as const) {
        const picked = taskResult(input.results[kind]);
        if (picked != null) results[kind] = picked;
    }

    return {
        extensionVersion: input.extensionVersion,
        userAgent: input.userAgent,
        generatedAt: new Date(input.now).toISOString(),
        recognizerVersion: RECOGNIZER_VERSION,
        run,
        results,
        schedule: {
            nextCheckAt: iso(input.nextCheckAt),
            notedAt: iso(input.scheduleNotedAt),
        },
    };
}

export function formatDiagnosticReport(report: DiagnosticReport): string {
    return JSON.stringify(report, null, 2);
}

// 导出文件名只含扩展版本与本地日期，不含任何用户数据。
export function diagnosticFileName(extensionVersion: string, now: number): string {
    const date = new Date(now);
    const pad = (value: number): string => String(value).padStart(2, '0');
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return `rewards-diagnostics-v${extensionVersion}-${day}.json`;
}

// 弹窗内的本地下载：Blob + 隐藏锚点，不需要 downloads 权限，不离开本机。
export function downloadDiagnostics(text: string, fileName: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    // 立即 revoke 可能截断尚未开始的读取，延后一拍释放。
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
