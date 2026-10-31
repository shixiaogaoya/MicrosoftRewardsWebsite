import { getStorageItem, setStorageItem, setStorageItems } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import {
    ATTEMPTS_KEY,
    CONFIG_KEY,
    LAST_RUN_KEY,
    PROGRESS_KEY,
    RESULTS_KEY,
    RUN_KEY,
    STEP_KEY,
    type RunConfig,
    type RunPhase,
    type RunProgress,
    type TaskAttempts,
    type TaskKind,
    type TaskResult,
    type TaskResults,
    type TaskRunState,
    type TaskStatus,
} from '@/entrypoints/utils/runState';

export type { RunConfig, RunPhase, RunProgress, TaskKind, TaskResult, TaskResults, TaskRunState, TaskStatus };

let chain: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = chain.then(operation, operation);
    chain = run.then(() => {}, () => {});
    return run;
}

async function read(): Promise<TaskRunState | null> {
    return await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL);
}

async function write(state: TaskRunState | null): Promise<void> {
    await setStorageItem(RUN_KEY, state, StorageValues.LOCAL);
}

export async function currentRun(): Promise<TaskRunState | null> {
    return enqueue(read);
}

// A browser restart kills the worker, its timers and its tab listeners, but the
// local run record survives. Leaving it as `running` makes the next automatic
// start join a round whose tabs are already gone. The record is closed here and
// the tasks that were still in flight are marked unconfirmed — not resumed.
export function abandonRun(reason: string): Promise<void> {
    return enqueue(async () => {
        const state = await read();
        if (!state) return;
        const results = (await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL)) ?? {};
        const kinds: TaskKind[] = ['search', 'daily', 'claim'];
        for (const kind of kinds) {
            if (state[kind] && (!results[kind] || results[kind]?.status === 'running')) {
                results[kind] = { status: 'unconfirmed', reason };
            }
        }
        await setStorageItem(RESULTS_KEY, results, StorageValues.LOCAL);
        const progress = await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL);
        if (progress?.isSearching) {
            await setStorageItem(PROGRESS_KEY, { ...progress, isSearching: false }, StorageValues.LOCAL);
        }
        await write(null);
    });
}

async function stepIsFree(runId: number, step: number, kind: TaskKind): Promise<boolean> {
    const state = await read();
    if (!state || state.id !== runId || state.phase !== 'running' || !state[kind]) return false;
    const taken = (await getStorageItem<number>(STEP_KEY, StorageValues.LOCAL)) ?? 0;
    return taken < step;
}

// Claims the step. Returns false when this step was already taken, or the round
// was stopped or replaced while this one waited. The timer and the backstop
// alarm both call it; the second call loses.
export function claimStep(runId: number, step: number, kind: TaskKind): Promise<boolean> {
    return enqueue(async () => {
        if (!(await stepIsFree(runId, step, kind))) return false;
        await setStorageItem(STEP_KEY, step, StorageValues.LOCAL);
        return true;
    });
}

// One round at a time. A second start while a round is running or still stopping
// joins that round instead of opening another search and another dashboard.
export function beginRun(kinds: TaskKind[], config: RunConfig): Promise<{ id: number; started: boolean }> {
    return enqueue(async () => {
        const state = await read();
        if (state) return { id: state.id, started: false };
        // A round that ends and another that starts inside the same millisecond —
        // including across a worker restart — must not share an id, or a late
        // result from the first would be accepted as the second's.
        const previous = (await getStorageItem<number>(LAST_RUN_KEY, StorageValues.LOCAL)) ?? 0;
        const id = Math.max(Date.now(), previous + 1);
        await setStorageItem(LAST_RUN_KEY, id, StorageValues.LOCAL);
        const results: TaskResults = {};
        for (const kind of kinds) results[kind] = { status: 'running' };
        await write({
            id,
            phase: 'running',
            search: kinds.includes('search'),
            daily: kinds.includes('daily'),
            claim: kinds.includes('claim'),
            startedAt: Date.now(),
        });
        await setStorageItems({
            [STEP_KEY]: 0,
            [CONFIG_KEY]: config,
            [PROGRESS_KEY]: { opened: 0, total: config.searches, isSearching: kinds.includes('search') },
            [RESULTS_KEY]: results,
        }, StorageValues.LOCAL);
        return { id, started: true };
    });
}

// Marks the round as stopping and drops the kind that just finished. The record
// stays until every kind has finished, so the button can say "正在停止…" and a
// new start cannot slip in while cleanup is still closing this round's tabs.
export function endRun(runId: number, kind: TaskKind): Promise<void> {
    return enqueue(async () => {
        const state = await read();
        if (!state || state.id !== runId) return;
        state[kind] = false;
        if (!state.search && !state.daily && !state.claim) await write(null);
        else await write(state);
    });
}

export function requestStop(): Promise<number | null> {
    return enqueue(async () => {
        const state = await read();
        if (!state || state.phase === 'stopping') return state?.id ?? null;
        state.phase = 'stopping';
        await write(state);
        const progress = await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL);
        if (progress) {
            await setStorageItem(PROGRESS_KEY, { ...progress, isSearching: false }, StorageValues.LOCAL);
        }
        return state.id;
    });
}

// Writes one task's outcome, but only for the round that is still the current
// one. A dashboardDone that arrives after the next round has started — or after
// this one was replaced — must not overwrite the new round's record.
export function recordResult(runId: number, kind: TaskKind, result: TaskResult): Promise<boolean> {
    return enqueue(async () => {
        const state = await read();
        if (!state || state.id !== runId) return false;
        const results = (await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL)) ?? {};
        if (results[kind]?.status && results[kind]?.status !== 'running') return false;
        results[kind] = result;
        await setStorageItem(RESULTS_KEY, results, StorageValues.LOCAL);
        return true;
    });
}

// Anything still `running` when its part of the round ends without a report.
export function settleUnresolved(runId: number, kinds: TaskKind[], result: TaskResult): Promise<void> {
    return enqueue(async () => {
        const state = await read();
        if (!state || state.id !== runId) return;
        const results = (await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL)) ?? {};
        let changed = false;
        for (const kind of kinds) {
            if (!results[kind] || results[kind]?.status === 'running') {
                results[kind] = result;
                changed = true;
            }
        }
        if (changed) await setStorageItem(RESULTS_KEY, results, StorageValues.LOCAL);
    });
}

export async function isRunStopping(runId: number): Promise<boolean> {
    const state = await currentRun();
    return state?.id === runId && state.phase === 'stopping';
}

export function noteAttempt(kind: TaskKind, dateId: string): Promise<void> {
    return enqueue(async () => {
        const attempts = (await getStorageItem<TaskAttempts>(ATTEMPTS_KEY, StorageValues.LOCAL)) ?? {};
        attempts[kind] = dateId;
        await setStorageItem(ATTEMPTS_KEY, attempts, StorageValues.LOCAL);
    });
}

export async function readAttempts(): Promise<TaskAttempts> {
    return (await getStorageItem<TaskAttempts>(ATTEMPTS_KEY, StorageValues.LOCAL)) ?? {};
}

export async function readProgress(): Promise<RunProgress | null> {
    return await getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL);
}

export function writeProgress(progress: RunProgress): Promise<void> {
    return enqueue(async () => {
        await setStorageItem(PROGRESS_KEY, progress, StorageValues.LOCAL);
    });
}

// The check and the write have to be one queued operation. Checking for the
// round and then queueing the write separately leaves a gap: a stop or a new
// round can land in it, and the stale step then overwrites the new round's
// count. Returns false when this step no longer belongs to a live round, so the
// caller knows not to schedule the next one.
export function writeProgressIfRunning(runId: number, progress: RunProgress): Promise<boolean> {
    return enqueue(async () => {
        const state = await read();
        if (!state || state.id !== runId || state.phase !== 'running' || !state.search) return false;
        await setStorageItem(PROGRESS_KEY, progress, StorageValues.LOCAL);
        return true;
    });
}

// Remembers which tab this round's dashboard opened, and when it must be gone.
// The durable sweep needs both to settle the round after a worker restart: it
// must not mistake a Rewards page the user opened themselves for ours, and it
// must not conclude anything before this round's own deadline.
export function noteDashboardTab(runId: number, tabId: number, deadline: number): Promise<void> {
    return enqueue(async () => {
        const state = await read();
        if (!state || state.id !== runId) return;
        await write({ ...state, dashboardTabId: tabId, dashboardDeadline: deadline });
    });
}

export async function readConfig(): Promise<RunConfig | null> {
    return await getStorageItem<RunConfig>(CONFIG_KEY, StorageValues.LOCAL);
}
