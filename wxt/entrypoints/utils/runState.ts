// Shared shape of a run, read by the background (which writes it) and the popup
// (which only subscribes). Kept out of taskRun.ts so the popup bundle does not
// pull in the background's storage writers.

export type TaskKind = 'search' | 'daily' | 'claim';

export type RunPhase = 'running' | 'stopping';

// What one task ended as. `running` only exists while the round is in flight.
// `not-needed` is a definite "nothing to do" (no claim card that can be pressed
// because the points are already claimed). `unconfirmed` is everything we cannot
// prove: a click that never answered, a page that timed out, a DOM we no longer
// recognise. Neither of those is a success, and neither is retried by the alarm.
export type TaskStatus = 'running' | 'completed' | 'not-needed' | 'failed' | 'unconfirmed' | 'cancelled';

export interface TaskResult {
    status: TaskStatus;
    // Short, human-readable, and only set when we actually know the cause.
    reason?: string;
    // The round that wrote this result. The stored results hold each task's
    // most recent outcome, and a single-task retry replaces only its own row —
    // without the id the rows left over could be read as one round's work.
    runId?: number;
    // When this result was written. Missing on results stored before these
    // fields existed, which are shown without a time rather than a made-up one.
    at?: number;
    // Machine-readable cause, written only by the recognition layer
    // (a RecognitionCause value from rewardsRecognition) together with the
    // recognizer version that produced it. The pair is what lets a stored row
    // be classified without parsing its Chinese display text; a row without
    // these fields came from the background's timeout/interruption paths,
    // which are not recognizer output (A08).
    cause?: string;
    recognizerVersion?: number;
}

// What the background answers a start, a stop or a single-task retry with.
// `reason` is set on every refusal, in the popup's own wording, so a click that
// did nothing is explained instead of silently ignored.
export type CommandReceipt = { accepted: true } | { accepted: false; reason: string };

export interface TaskRunState {
    id: number;
    phase: RunPhase;
    search: boolean;
    daily: boolean;
    claim: boolean;
    // When the round started. The fallback deadline for a round whose dashboard
    // tab was never recorded (the create failed, or the worker died in the gap),
    // so a sweep cannot mistake a just-started round for an abandoned one.
    startedAt: number;
    // This round's own dashboard tab and the instant it must be gone. Recorded
    // when the tab is created so the durable sweep can tell this round's page
    // apart from a Rewards page the user has open themselves, and can settle the
    // round once its own page is past the deadline.
    dashboardTabId?: number;
    dashboardDeadline?: number;
    // When the next search step is due, plus a wake-up allowance. Search has no
    // page of its own to be judged by, including when this round also opened the
    // dashboard, so without this an in-flight round whose worker died between
    // opening a tab and arming the next step would never be settled and would
    // block every later start.
    searchDeadline?: number;
    // The search tabs this round opened, recorded as each is created. The
    // bing-result content script asks before navigating to the first organic
    // result; only a tab named here counts as this round's own, so a page that
    // merely carries the ?marAuto marker (a bookmark, a copied link, a leftover
    // tab from an earlier round) is refused.
    searchTabIds?: number[];
}

// Frozen when the round starts. Editing the search count, the gap or the close
// time while a round is running changes the next round, not this one.
export interface RunConfig {
    searches: number;
    timeout: number;
    closeTime: number;
}

export interface RunProgress {
    // Search tabs this round has opened. Not points earned.
    opened: number;
    total: number;
    isSearching: boolean;
}

export const EMPTY_PROGRESS: RunProgress = { opened: 0, total: 0, isSearching: false };

export type TaskAttempts = {
    search?: string;
    daily?: string;
    claim?: string;
};

// Safety cap: close the dashboard tab even if the content script never reports
// done (page failed to render the daily sets, message dropped, etc.). Also the
// hard bound on how long a round may stay unresolved: the durable sweep uses it
// to settle a round whose in-worker timers were lost with the service worker.
export const DASHBOARD_MAX_LIFETIME_MS = 90000;

export type TaskResults = Partial<Record<TaskKind, TaskResult>>;

export const RUN_KEY = 'taskRun';
export const STEP_KEY = 'taskStep';
export const CONFIG_KEY = 'taskConfig';
export const PROGRESS_KEY = 'taskProgress';
export const RESULTS_KEY = 'taskResults';
export const ATTEMPTS_KEY = 'taskAttempts';
// Navigation grants for the search tabs a round opened, keyed by tab id.
export const SEARCH_GRANTS_KEY = 'searchTabGrants';
export const MIGRATION_KEY = 'stateMigrationVersion';
export const LAST_RUN_KEY = 'taskLastRunId';

export const STATE_MIGRATION_VERSION = 1;

// The one round the stored results may be spoken for as: the live round's id
// when there is one, else the newest round the rows themselves can name. Used
// to keep rows carried over from earlier rounds (a single-task retry keeps
// them) out of any "this round" claim, so results from different rounds cannot
// be stitched into one seemingly complete round.
export function roundReference(results: TaskResults, runId: number | null): number | null {
    if (runId != null) return runId;
    let latest: number | null = null;
    for (const kind of ['search', 'daily', 'claim'] as const) {
        const id = results[kind]?.runId;
        if (id != null && (latest == null || id > latest)) latest = id;
    }
    return latest;
}

// Whether one stored row belongs to the round `roundReference` names. A row
// with no round mark predates the marking: it is the previous version's last
// round when nothing is marked (that version rewrote every row each round),
// and older than every marked row once one is.
export function belongsToRound(result: TaskResult, reference: number | null): boolean {
    return result.runId != null ? result.runId === reference : reference == null;
}
