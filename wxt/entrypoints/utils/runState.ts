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
}

export interface TaskRunState {
    id: number;
    phase: RunPhase;
    search: boolean;
    daily: boolean;
    claim: boolean;
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

export interface TaskAttempts {
    search?: string;
    daily?: string;
    claim?: string;
}

export type TaskResults = Partial<Record<TaskKind, TaskResult>>;

export const RUN_KEY = 'taskRun';
export const STEP_KEY = 'taskStep';
export const CONFIG_KEY = 'taskConfig';
export const PROGRESS_KEY = 'taskProgress';
export const RESULTS_KEY = 'taskResults';
export const ATTEMPTS_KEY = 'taskAttempts';
export const MIGRATION_KEY = 'stateMigrationVersion';
export const LAST_RUN_KEY = 'taskLastRunId';

export const STATE_MIGRATION_VERSION = 1;
