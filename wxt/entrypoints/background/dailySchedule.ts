import { storage } from '#imports';
import { browser } from 'wxt/browser';
import { getStorageItems, setStorageItems } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { DEFAULTS, clampSetting } from '@/entrypoints/utils/settings';
import { localDateId } from '@/entrypoints/utils/localDate';
import { setBadgeText } from '@/entrypoints/utils/browserAction';
import { MIGRATION_KEY, STATE_MIGRATION_VERSION, type RunConfig, type TaskKind, type TaskResult } from '@/entrypoints/utils/runState';
import { openDailyRewards } from './dailyRewards';
import { startSearches, stopSearches } from './searchRunner';
import { clearTrackedTabs } from './tabCleanup';
import { abandonRun, beginRun, endRun, noteAttempt, readAttempts, recordResult, requestStop, settleUnresolved } from './taskRun';
import { migrateRunState } from './stateMigration';

const DAILY_CHECK_ALARM = 'dailyCheck';
// onStartup only fires when the browser actually launches, so a long-lived
// session that never restarts across a day boundary used to miss the
// once-per-day gate below entirely. This alarm re-runs that gate periodically
// so the day rollover is caught without needing a restart.
const DAILY_CHECK_PERIOD_MINUTES = 360;

interface RoundPlan {
    config: RunConfig;
    wantsSearch: boolean;
    wantsDaily: boolean;
    wantsClaim: boolean;
}

// What a round would run, from the user's settings. Shared by the button and
// the automatic trigger so both honour the same task toggles; only the
// automatic path also requires autoRunEnabled.
async function planRound(): Promise<RoundPlan> {
    const s = await getStorageItems(
        ['searches', 'timeout', 'closeTime', 'active', 'autoDaily', 'claimPoints'],
        StorageValues.SYNC
    );
    const searches = clampSetting('searches', s.searches);
    return {
        config: {
            searches,
            timeout: clampSetting('timeout', s.timeout),
            closeTime: clampSetting('closeTime', s.closeTime),
        },
        wantsSearch: (s.active ?? DEFAULTS.active) && searches > 0,
        wantsDaily: s.autoDaily ?? DEFAULTS.autoDaily,
        wantsClaim: s.claimPoints ?? DEFAULTS.claimPoints,
    };
}

function kindsOf(plan: RoundPlan, only?: TaskKind[]): TaskKind[] {
    const kinds: TaskKind[] = [];
    if (plan.wantsSearch && (!only || only.includes('search'))) kinds.push('search');
    if (plan.wantsDaily && (!only || only.includes('daily'))) kinds.push('daily');
    if (plan.wantsClaim && (!only || only.includes('claim'))) kinds.push('claim');
    return kinds;
}

export interface RunOptions {
    // Set by the popup button and by "retry this task". The daily alarm and
    // startup do not set it: they skip a task that was already attempted today,
    // whatever that attempt's result was.
    manual?: boolean;
    // Restricts the round to one task. Used by the per-result retry, so a failed
    // claim does not re-run a search that already finished.
    only?: TaskKind[];
}

// Runs the tasks the user has selected. The dashboard visit (daily cards and
// claim share one tab) and the searches start together and neither waits on
// the other: a dashboard that fails must not block the searches.
export async function runRewards(options: RunOptions = {}): Promise<void> {
    const plan = await planRound();
    const kinds = kindsOf(plan, options.only);
    if (kinds.length === 0) return;

    const today = localDateId();
    const attempts = options.manual ? {} : await readAttempts();
    const pending = kinds.filter((kind) => attempts[kind] !== today);
    if (pending.length === 0) return;

    // A second click, or the daily alarm overlapping the button, joins the round
    // already in flight instead of opening another search and another dashboard.
    const run = await beginRun(pending, plan.config);
    if (!run.started) return;

    // Record the attempt before any tab opens. A crash after this point still
    // counts as "tried today", so the six-hour alarm does not start a second
    // round. A failure, a cancel and an unconfirmed result are all attempts.
    for (const kind of pending) await noteAttempt(kind, today);

    const wantsDashboard = pending.includes('daily') || pending.includes('claim');
    if (wantsDashboard) {
        void openDailyRewards(run.id, {
            doDailySet: pending.includes('daily'),
            doClaim: pending.includes('claim'),
        }).catch((error: unknown) => failDashboard(run.id, pending, error));
    }
    if (pending.includes('search')) {
        await startSearches(run.id, plan.config);
    }
}

async function failDashboard(runId: number, pending: TaskKind[], error: unknown): Promise<void> {
    const result: TaskResult = { status: 'failed', reason: reasonOf(error) };
    for (const kind of pending) {
        if (kind === 'search') continue;
        await recordResult(runId, kind, result);
        await endRun(runId, kind);
    }
}

function reasonOf(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return '未能打开每日活动页面';
}

// Stops the searches and the dashboard visit of this round. The daily toggles
// are left as the user set them. Closing "每日自动执行" does not come through
// here — that only stops future automatic starts.
export async function stopRewards(): Promise<void> {
    const runId = await requestStop();
    await stopSearches();
    if (runId == null) return;
    const cancelled: TaskResult = { status: 'cancelled', reason: '已停止' };
    await settleUnresolved(runId, ['search', 'daily', 'claim'], cancelled);
    // Search has no page of its own left to close: stopSearches already dropped
    // the alarm and the short timer, and each search tab closes itself. The
    // dashboard record stays. finish() in the dashboard visit still holds this
    // tab's id and will call tabs.remove when its timer, its stop watch, or a
    // late message arrives. Deleting the record here would let a new round — or
    // a page the user opened afterwards — reuse that id and be closed instead.
    // The dashboard visit ends the daily and claim records when it closes.
    await endRun(runId, 'search');
}

// Automatic entry point. Skipped entirely while auto-run is off, and each task
// that already has an attempt recorded for the local day is skipped inside
// runRewards. A manual press does not come through here.
export async function checkLastOpened(): Promise<void> {
    const s = await getStorageItems(['autoRunEnabled'], StorageValues.SYNC);
    if (!(s.autoRunEnabled ?? DEFAULTS.autoRunEnabled)) return;
    await runRewards();
}

export function isDailyCheckAlarm(name: string): boolean {
    return name === DAILY_CHECK_ALARM;
}

// Armed only while auto-run is on AND at least one task is selected, so a
// fully disabled extension is not woken every few hours for nothing — the same
// discipline tabCleanup uses for its sweep alarm. The task toggles alone no
// longer arm it: they describe a manual round, not an automatic one.
export async function scheduleDailyCheckAlarm(): Promise<void> {
    const s = await getStorageItems(['autoRunEnabled', 'active', 'autoDaily', 'claimPoints'], StorageValues.SYNC);
    const autoRun = s.autoRunEnabled ?? DEFAULTS.autoRunEnabled;
    const hasTask =
        (s.active ?? DEFAULTS.active) ||
        (s.autoDaily ?? DEFAULTS.autoDaily) ||
        (s.claimPoints ?? DEFAULTS.claimPoints);
    if (!autoRun || !hasTask) {
        await browser.alarms.clear(DAILY_CHECK_ALARM);
        return;
    }
    // Creating an alarm replaces it, which restarts the six-hour period. A worker
    // that woke an hour into that period must leave the schedule it already has.
    if (await browser.alarms.get(DAILY_CHECK_ALARM)) return;
    browser.alarms.create(DAILY_CHECK_ALARM, { periodInMinutes: DAILY_CHECK_PERIOD_MINUTES });
}

export async function handleDailyCheckAlarm(alarm: { name: string }): Promise<void> {
    if (alarm.name !== DAILY_CHECK_ALARM) return;
    await checkLastOpened();
}

// Re-arms (or disarms) the alarm the moment a relevant toggle changes, so
// turning auto-run or the last task on/off takes effect immediately rather
// than waiting for the next restart — including a toggle synced in from
// another device. Turning auto-run off does not stop a round already running.
export function watchDailyFeatureToggles(): void {
    storage.watch<boolean>('sync:autoRunEnabled', () => void scheduleDailyCheckAlarm());
    storage.watch<boolean>('sync:active', () => void scheduleDailyCheckAlarm());
    storage.watch<boolean>('sync:autoDaily', () => void scheduleDailyCheckAlarm());
    storage.watch<boolean>('sync:claimPoints', () => void scheduleDailyCheckAlarm());
}

export async function handleInstallOrUpdate(details: { reason: string }): Promise<void> {
    if (details.reason === 'install') {
        await setStorageItems({
            active: DEFAULTS.active,
            autoDaily: DEFAULTS.autoDaily,
            accountLevel: DEFAULTS.accountLevel,
            timeout: DEFAULTS.timeout,
            searches: DEFAULTS.searches,
            closeTime: DEFAULTS.closeTime,
            openFirstResult: DEFAULTS.openFirstResult,
            claimPoints: DEFAULTS.claimPoints,
            autoRunEnabled: DEFAULTS.autoRunEnabled,
        }, StorageValues.SYNC);
        await setStorageItems({ [MIGRATION_KEY]: STATE_MIGRATION_VERSION }, StorageValues.LOCAL);
    } else if (details.reason === 'update') {
        await migrateRunState();
        setBadgeText('新');
    }
}

export async function handleStartup(): Promise<void> {
    await migrateRunState();
    // A search run never survives a browser restart. Alarms outlive the session
    // and would resume opening Bing tabs on their own, and the local run record
    // outlives it too: leaving that record as `running` would make today's
    // automatic start join a round whose tabs are already gone.
    await stopSearches();
    await abandonRun('浏览器已重启，未能确认结果');
    await clearTrackedTabs();
    const s = await getStorageItems(['autoRunEnabled'], StorageValues.SYNC);
    if (s.autoRunEnabled ?? DEFAULTS.autoRunEnabled) await checkLastOpened();
    await scheduleDailyCheckAlarm();
}
