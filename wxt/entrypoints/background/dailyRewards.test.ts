// @vitest-environment node
// Same reason as dailySchedule.test.ts: background code needs no DOM, and node
// avoids the esbuild/jsdom clash WXT's `#imports` transform triggers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { openDailyRewards } from './dailyRewards';
import { beginRun } from './taskRun';
import { getStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { RESULTS_KEY, type TaskResults } from '@/entrypoints/utils/runState';

// The dashboard tab id every mock here hands out, and the tab the user was on
// before the round started.
const DASHBOARD_ID = 7;
const USER_TAB_ID = 3;

interface FocusedRound {
    runId: number;
    // Listeners the visit registered on runtime.onMessage; a dashboardDone
    // through them is what finishes the round.
    messages: Array<(message: unknown, sender: unknown) => void>;
    // Listeners registered on tabs.onCreated; firing one is how the dashboard
    // page opens a daily-set search tab.
    created: Array<(tab: unknown) => void>;
    // Every tabs.update call, as (tabId, active) pairs.
    updates: Array<{ tabId: number; active: boolean }>;
    // Moves the user's focus: what tabs.query answers for "active tab of the
    // last focused window" from here on.
    setActive(tabId: number | undefined): void;
}

// captureListeners, same workaround as dailySchedule.test.ts: several browser
// events are unimplemented stubs in fake-browser whose addListener throws.
function captureListeners(target: object, method: string): Array<(...args: unknown[]) => void> {
    const listeners: Array<(...args: unknown[]) => void> = [];
    vi.spyOn(target as Record<string, (...args: unknown[]) => unknown>, method).mockImplementation((listener: unknown) => {
        listeners.push(listener as (...args: unknown[]) => void);
    });
    return listeners;
}

// Starts a dashboard-only round with the browser calls it makes under test
// control. The user begins on USER_TAB_ID; the dashboard opens as DASHBOARD_ID.
async function startDashboardRound(): Promise<FocusedRound> {
    const messages = captureListeners(fakeBrowser.runtime.onMessage, 'addListener');
    vi.spyOn(fakeBrowser.runtime.onMessage, 'removeListener').mockImplementation(() => {});
    const created = captureListeners(fakeBrowser.tabs.onCreated, 'addListener');
    vi.spyOn(fakeBrowser.tabs.onCreated, 'removeListener').mockImplementation(() => {});
    captureListeners(fakeBrowser.tabs.onRemoved, 'addListener');
    vi.spyOn(fakeBrowser.tabs.onRemoved, 'removeListener').mockImplementation(() => {});

    vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({ id: DASHBOARD_ID } as any);
    vi.spyOn(fakeBrowser.tabs, 'remove').mockResolvedValue(undefined as any);
    vi.spyOn(fakeBrowser.tabs, 'get').mockResolvedValue({ id: 99 } as any);
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined as any);

    let activeTabId: number | undefined = USER_TAB_ID;
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => (
        activeTabId == null ? [] : [{ id: activeTabId }] as any
    ));

    const updates: Array<{ tabId: number; active: boolean }> = [];
    // The spy's inferred type picks the one-argument overload of tabs.update,
    // while the code under test always passes (tabId, updateProperties); rest
    // arguments accept either shape.
    vi.spyOn(fakeBrowser.tabs, 'update').mockImplementation(async (...args: unknown[]) => {
        updates.push({ tabId: args[0] as number, active: Boolean((args[1] as { active?: boolean })?.active) });
        return {} as any;
    });

    const run = await beginRun(['daily'], { searches: 5, timeout: 60, closeTime: 5 });
    void openDailyRewards(run.id, { doDailySet: true, doClaim: false });
    // The visit registers its listeners and reads the starting tab inside the
    // same call; let that settle before the test moves the focus around.
    for (let i = 0; i < 20 && messages.length === 0; i += 1) await vi.advanceTimersByTimeAsync(0);

    return {
        runId: run.id,
        messages,
        created,
        updates,
        setActive: (tabId: number | undefined) => {
            activeTabId = tabId;
        },
    };
}

function reportDone(round: FocusedRound): void {
    round.messages.forEach((listener) => listener(
        { action: 'dashboardDone', runId: round.runId, daily: { status: 'completed' } },
        { tab: { id: DASHBOARD_ID } }
    ));
}

// finish() closes the tab and writes the results across several awaited steps;
// one timer turn flushes the microtasks between them, so take a couple.
async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
}

describe('openDailyRewards 结束与子页面的焦点处理', () => {
    beforeEach(() => {
        fakeBrowser.reset();
        vi.restoreAllMocks();
        // The visit arms long safety timers nothing here waits on.
        vi.useFakeTimers();
    });
    afterEach(() => vi.useRealTimers());

    // A09: the round used to reactivate the pre-round tab unconditionally, so
    // a user who had switched away on purpose was pulled back. The restore now
    // asks first and only moves a user who is still on the dashboard.
    it('用户焦点仍在活动页时，结束后回到任务开始前的标签页', async () => {
        const round = await startDashboardRound();
        // The user never switched: the dashboard is still the active tab.
        round.setActive(DASHBOARD_ID);

        reportDone(round);
        await flush();

        expect(round.updates).toContainEqual({ tabId: USER_TAB_ID, active: true });
        expect((await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL))?.daily?.status).toBe('completed');
    });

    it('用户已切换到别的标签页时，结束后不抢回原来的标签页', async () => {
        const round = await startDashboardRound();
        // The user moved to another tab (another window reads the same: the
        // last focused window no longer has the dashboard active).
        round.setActive(9);

        reportDone(round);
        await flush();

        expect(round.updates).toEqual([]);
        expect((await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL))?.daily?.status).toBe('completed');
    });

    // A09 review of the child-tab focus handling: opening a daily-set search
    // tab snaps focus back to the dashboard so it stays rendered and keeps
    // clicking. Whether that SPA still works from a background tab is
    // unverified, so the snap-back is kept — a user who switched away is still
    // snapped back here; the end-of-round check above is what leaves them
    // alone once the visit finishes.
    it('每日活动创建子页面时，仍把活动页拉回前台', async () => {
        const round = await startDashboardRound();
        round.setActive(9);

        round.created.forEach((listener) => listener({ id: 99, openerTabId: DASHBOARD_ID }));
        await flush();

        expect(round.updates).toContainEqual({ tabId: DASHBOARD_ID, active: true });
    });
});
