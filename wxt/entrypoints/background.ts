import { defineBackground } from '#imports';
import { browser } from 'wxt/browser';
import {
    handleDailyCheckAlarm,
    handleInstallOrUpdate,
    handleStartup,
    isDailyCheckAlarm,
    runRewards,
    scheduleDailyCheckAlarm,
    stopRewards,
    watchDailyFeatureToggles,
} from './background/dailySchedule';
import { migrateRunState } from './background/stateMigration';
import { handleAlarmStep, watchSearchesToggle } from './background/searchRunner';
import { isCleanupAlarm, sweepStaleTabs } from './background/tabCleanup';
import type { TaskKind } from './background/taskRun';

const TASK_KINDS: readonly TaskKind[] = ['search', 'daily', 'claim'];

function requestedTasks(value: unknown): TaskKind[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const kinds = value.filter((item): item is TaskKind => TASK_KINDS.includes(item as TaskKind));
    return kinds.length > 0 ? kinds : undefined;
}

export default defineBackground(() => {
    browser.runtime.onInstalled.addListener(handleInstallOrUpdate);
    browser.runtime.onStartup.addListener(handleStartup);
    watchSearchesToggle();
    watchDailyFeatureToggles();
    // Covers a fresh install and any other worker wake-up that isn't a full
    // browser restart, so the daily-check alarm doesn't wait on onStartup.
    // Migration is idempotent and opens nothing; a wake that is the first one
    // after an update has to run it before the alarm is armed.
    void migrateRunState().then(() => scheduleDailyCheckAlarm());
    browser.runtime.onMessage.addListener((request: { action?: string; only?: unknown }) => {
        // The button is a manual start: it may re-run a task already attempted
        // today. `only` limits that to the tasks the button named, so a retry of
        // one failure does not restart the others.
        if (request.action === 'popup') void runRewards({ manual: true, only: requestedTasks(request.only) });
        else if (request.action === 'stop') void stopRewards();
    });
    // Registered here, at the worker's top level, so the browser wakes a
    // torn-down service worker for it — the only kind of timer that survives.
    browser.alarms.onAlarm.addListener((alarm) => {
        if (isCleanupAlarm(alarm.name)) void sweepStaleTabs();
        else if (isDailyCheckAlarm(alarm.name)) void handleDailyCheckAlarm(alarm);
        else void handleAlarmStep(alarm);
    });
});
