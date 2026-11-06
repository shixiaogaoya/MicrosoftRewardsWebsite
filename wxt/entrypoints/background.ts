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
import { handleAlarmStep, mayOpenFirstResult, watchSearchesToggle } from './background/searchRunner';
import { isCleanupAlarm, sweepStaleTabs } from './background/tabCleanup';
import type { CommandReceipt, TaskKind } from './background/taskRun';

const TASK_KINDS: readonly TaskKind[] = ['search', 'daily', 'claim'];

function requestedTasks(value: unknown): TaskKind[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const kinds = value.filter((item): item is TaskKind => TASK_KINDS.includes(item as TaskKind));
    return kinds.length > 0 ? kinds : undefined;
}

// runRewards and stopRewards refuse with their own reasons; an unexpected throw
// still has to answer, or the popup's request would hang until its channel
// closes with the popup.
function failedReceipt(): CommandReceipt {
    return { accepted: false, reason: '操作未能完成，请重试' };
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
    browser.runtime.onMessage.addListener((request: { action?: string; only?: unknown }, sender: { tab?: { id?: number } }, sendResponse: (response?: unknown) => void) => {
        // The button is a manual start: it may re-run a task already attempted
        // today. `only` limits that to the tasks the button named, so a retry of
        // one failure does not restart the others. Start and stop answer with a
        // receipt, so a click the background refused is shown as refused.
        if (request.action === 'popup') {
            void runRewards({ manual: true, only: requestedTasks(request.only) }).then(
                (receipt) => sendResponse(receipt),
                () => sendResponse(failedReceipt())
            );
            return true;
        } else if (request.action === 'stop') {
            void stopRewards().then(
                (receipt) => sendResponse(receipt),
                () => sendResponse(failedReceipt())
            );
            return true;
        } else if (request.action === 'bingFirstResult') {
            // The bing-result content script asks this before leaving the
            // results page, and awaits the reply. Returning true keeps the
            // channel open for it. An unexpected throw still has to answer —
            // the script reads anything but an explicit yes as a no, so a
            // missing reply would keep it waiting until the page unloads.
            void mayOpenFirstResult(sender.tab?.id).then(
                (allowed) => sendResponse({ allowed }),
                () => sendResponse({ allowed: false })
            );
            return true;
        }
    });
    // Registered here, at the worker's top level, so the browser wakes a
    // torn-down service worker for it — the only kind of timer that survives.
    browser.alarms.onAlarm.addListener((alarm) => {
        if (isCleanupAlarm(alarm.name)) void sweepStaleTabs();
        else if (isDailyCheckAlarm(alarm.name)) void handleDailyCheckAlarm(alarm);
        else void handleAlarmStep(alarm);
    });
});
