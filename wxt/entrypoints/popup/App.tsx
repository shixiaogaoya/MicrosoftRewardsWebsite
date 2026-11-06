import './App.css';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { useStorage, type LoadState, type SaveState } from '@/entrypoints/hooks/useStorage';
import { useSearchProgress } from '@/entrypoints/hooks/useSearchProgress';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { DEFAULTS, SETTING_LIMITS, clampSetting } from '@/entrypoints/utils/settings';
import { clearBadge } from '@/entrypoints/utils/browserAction';
import { RECOMMENDED_MIN_TIMEOUT_SECONDS } from '@/entrypoints/utils/search';
import { ATTEMPTS_KEY, CONFIG_KEY, type RunConfig, type TaskAttempts, type TaskKind, type TaskResults } from '@/entrypoints/utils/runState';
import { localDateId } from '@/entrypoints/utils/localDate';
import NumberInput from '@/entrypoints/components/NumberInput';
import SearchPresetSelect from '@/entrypoints/components/SearchPresetSelect';
import ManualClaimButton from '@/entrypoints/components/ManualClaimButton';
import SearchProgressBar from '@/entrypoints/components/SearchProgressBar';
import TaskResultsList from '@/entrypoints/components/TaskResults';
import Icon from '@/entrypoints/components/Icon';
import { combinedLoad, combinedSave, countNeedsHandling, nextRoundSummary, statusView } from './status';

// The fork's own Chinese README, not the upstream one: the behaviour documented
// there (stopping a round, the auto-run switch, 已发起 versus 到账) is this fork's.
const HELP_URL = 'https://github.com/shixiaogaoya/MicrosoftRewardsWebsite#readme';
const REWARDS_URL = 'https://rewards.bing.com/';

// A running task is still in progress, not something the user has to confirm.
const ATTEMPT_LABELS: Record<TaskKind, string> = {
    search: '搜索',
    daily: '每日活动',
    claim: '领取积分',
};

function App() {
    const activeStore = useStorage<boolean>('active', DEFAULTS.active, StorageValues.SYNC);
    const autoDailyStore = useStorage<boolean>('autoDaily', DEFAULTS.autoDaily, StorageValues.SYNC);
    const searchesStore = useStorage<number>('searches', DEFAULTS.searches, StorageValues.SYNC);
    const timeoutStore = useStorage<number>('timeout', DEFAULTS.timeout, StorageValues.SYNC);
    const closeTimeStore = useStorage<number>('closeTime', DEFAULTS.closeTime, StorageValues.SYNC);
    const openFirstStore = useStorage<boolean>('openFirstResult', DEFAULTS.openFirstResult, StorageValues.SYNC);
    const claimStore = useStorage<boolean>('claimPoints', DEFAULTS.claimPoints, StorageValues.SYNC);
    const autoRunStore = useStorage<boolean>('autoRunEnabled', DEFAULTS.autoRunEnabled, StorageValues.SYNC);
    const active = activeStore.value;
    const setActive = activeStore.setValue;
    const autoDaily = autoDailyStore.value;
    const setAutoDaily = autoDailyStore.setValue;
    const searchesStored = searchesStore.value;
    const setSearches = searchesStore.setValue;
    const timeoutStored = timeoutStore.value;
    const setTimeoutValue = timeoutStore.setValue;
    const closeTimeStored = closeTimeStore.value;
    const setCloseTime = closeTimeStore.setValue;
    const openFirstResult = openFirstStore.value;
    const setOpenFirstResult = openFirstStore.setValue;
    const claimPoints = claimStore.value;
    const setClaimPoints = claimStore.setValue;
    const autoRunEnabled = autoRunStore.value;
    const setAutoRunEnabled = autoRunStore.setValue;
    const [stopRequested, setStopRequested] = useState(false);
    // The settings live on their own view: the popup is one document, so this is
    // a view switch rather than a route.
    const [showSettings, setShowSettings] = useState(false);
    const [attempts, setAttempts] = useState<TaskAttempts>({});
    const [nextCheck, setNextCheck] = useState<number | null>(null);
    const [frozenConfig, setFrozenConfig] = useState<RunConfig | null>(null);
    const { isLoaded, isSearching, completed, total, isRunning, phase, results } = useSearchProgress();

    const searches = clampSetting('searches', searchesStored);
    const timeout = clampSetting('timeout', timeoutStored);
    const closeTime = clampSetting('closeTime', closeTimeStored);

    // The update badge is dismissed once the popup is opened — but the badge
    // doubles as the live search counter, so a running count is left alone.
    useEffect(() => {
        if (isLoaded && !isSearching) clearBadge();
    }, [isLoaded, isSearching]);

    // The background drops the run record when cleanup finishes. Until then the
    // button stays on "正在停止" and cannot be pressed again.
    useEffect(() => {
        if (!isRunning) setStopRequested(false);
    }, [isRunning]);

    // Today's attempt dates and the existing daily-check alarm. Read only: the
    // background already owns both, and this view must not arm another timer.
    useEffect(() => {
        let cancelled = false;
        function refresh(): void {
            void browser.storage.local.get(ATTEMPTS_KEY).then((stored) => {
                if (cancelled) return;
                const value = stored[ATTEMPTS_KEY];
                setAttempts(value && typeof value === 'object' ? value as TaskAttempts : {});
            });
            void browser.alarms.get('dailyCheck').then((alarm) => {
                if (cancelled) return;
                setNextCheck(alarm?.scheduledTime ?? null);
            });
        }
        refresh();
        const onChanged: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, area) => {
            if (area === 'local' && ATTEMPTS_KEY in changes) refresh();
        };
        const onAlarm: Parameters<typeof browser.alarms.onAlarm.addListener>[0] = (alarm) => {
            if (alarm.name === 'dailyCheck') refresh();
        };
        const onSyncChanged: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, area) => {
            // dailyCheckScheduledAt is written after the background finishes
            // creating or clearing the alarm. Reading on the setting change
            // itself would still see the previous schedule.
            if (area === 'local' && changes.dailyCheckScheduledAt) refresh();
        };
        browser.storage.onChanged.addListener(onChanged);
        browser.storage.onChanged.addListener(onSyncChanged);
        browser.alarms.onAlarm.addListener(onAlarm);
        return () => {
            cancelled = true;
            browser.storage.onChanged.removeListener(onChanged);
            browser.storage.onChanged.removeListener(onSyncChanged);
            browser.alarms.onAlarm.removeListener(onAlarm);
        };
    }, []);

    // The count and gap shown while a round is running come from the config that
    // round froze at start. Editing settings changes the next round only.
    useEffect(() => {
        let cancelled = false;
        function readFrozen(): void {
            if (!isRunning) {
                setFrozenConfig(null);
                return;
            }
            void browser.storage.local.get(CONFIG_KEY).then((stored) => {
                if (cancelled) return;
                const value = stored[CONFIG_KEY] as RunConfig | undefined;
                setFrozenConfig(value && typeof value.searches === 'number' ? value : null);
            });
        }
        readFrozen();
        const onChanged: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, area) => {
            if (area === 'local' && CONFIG_KEY in changes) readFrozen();
        };
        browser.storage.onChanged.addListener(onChanged);
        return () => {
            cancelled = true;
            browser.storage.onChanged.removeListener(onChanged);
        };
    }, [isRunning]);

    // Nothing has run yet: 0/N would read as stalled, so progress stays hidden.
    const hasSearchToShow = isLoaded && (isSearching || completed > 0);
    const hasResults = isLoaded && (results.search || results.daily || results.claim);
    // "开始任务" needs at least one task selected. Auto-run is a separate switch:
    // off only means the alarm and startup will not start a round.
    const hasTaskSelected = active || autoDaily || claimPoints;
    const isStopping = phase === 'stopping' || stopRequested;

    // Gaps this short are honoured, but whether Microsoft credits them cannot
    // be verified from the extension — so the field warns rather than silently
    // overriding the choice.
    const isTimeoutRisky = timeout < RECOMMENDED_MIN_TIMEOUT_SECONDS;

    const status = statusView({ isLoaded, isStopping, isRunning, results });
    const handlingCount = countNeedsHandling(results);
    const bindings = [activeStore, autoDailyStore, searchesStore, timeoutStore, closeTimeStore, openFirstStore, claimStore, autoRunStore];
    const saveState = combinedSave(bindings.map((binding) => binding.saveState));
    const loadState = combinedLoad(bindings.map((binding) => binding.loadState));
    // Starting a round uses the values on screen, so it waits until every
    // setting has been read and its latest edit is stored: a value still being
    // read, or one whose write has not gone through, is not a value a round may
    // run on. Stopping is not gated here — it sends no values.
    const settingsNotReady = loadState !== 'loaded' || saveState === 'saving' || saveState === 'error';
    // A failed read leaves the defaults on screen, not the user's settings, and
    // the hook holds every write back until its read has landed — so an edit
    // made in that window would only change what is on screen and be silently
    // replaced once the retry succeeds. The controls stay disabled until the
    // "重新读取" beside them brings the real values in; nothing is editable to
    // lose.
    const settingsUnreadable = loadState === 'error';
    const settingsDirtyWhileRunning = isRunning && frozenConfig != null && (
        frozenConfig.searches !== searches || frozenConfig.timeout !== timeout || frozenConfig.closeTime !== closeTime
    );
    const displaySearches = isRunning && frozenConfig ? frozenConfig.searches : searches;
    const displayTimeout = isRunning && frozenConfig ? frozenConfig.timeout : timeout;

    if (showSettings) {
        return (
            <main className="popup">
                <header className="settings-header">
                    <button type="button" className="back-button" onClick={() => setShowSettings(false)} aria-label="返回">
                        <Icon name="arrow-left" size="medium" />
                    </button>
                    <h1 className="settings-heading">设置</h1>
                </header>

                <section className="card">
                    <div className="switch-row">
                        <label className="switch-label" htmlFor="autoRunEnabled">每日自动执行</label>
                        <input
                            className="switch"
                            type="checkbox"
                            role="switch"
                            id="autoRunEnabled"
                            checked={autoRunEnabled}
                            disabled={settingsUnreadable}
                            onChange={(e) => setAutoRunEnabled(e.target.checked)}
                        />
                    </div>
                    <AutoRunNote enabled={autoRunEnabled} attempts={attempts} nextCheck={nextCheck} />
                </section>

                <div className="group">
                    <h2 className="group-title">执行内容</h2>
                    <section className="card">
                        <div className="tile-grid">
                            <TaskTile id="autoCheckbox" label="执行搜索" checked={active} onChange={setActive} disabled={settingsUnreadable} />
                            <TaskTile id="autoDaily" label="完成每日活动" checked={autoDaily} onChange={setAutoDaily} disabled={settingsUnreadable} />
                            <TaskTile id="claimPoints" label="领取积分" checked={claimPoints} onChange={setClaimPoints} disabled={settingsUnreadable} />
                        </div>
                    </section>
                </div>

                <div className="group">
                    <h2 className="group-title">搜索参数</h2>
                    <section className="card">
                        <SearchPresetSelect searches={searches} onSelect={setSearches} disabled={settingsUnreadable} />
                        <div className="divider" />
                        <div className="param-grid">
                            <NumberInput
                                id="searches"
                                kind="searches"
                                label="搜索次数"
                                unit="次"
                                hint={`${SETTING_LIMITS.searches.min}～${SETTING_LIMITS.searches.max} 的整数`}
                                value={searches}
                                onChange={setSearches}
                                disabled={settingsUnreadable}
                            />
                            <NumberInput
                                id="timeout"
                                kind="timeout"
                                label="搜索间隔"
                                unit="秒"
                                hint={`${SETTING_LIMITS.timeout.min}～${SETTING_LIMITS.timeout.max} 的整数`}
                                value={timeout}
                                onChange={setTimeoutValue}
                                disabled={settingsUnreadable}
                            />
                            <NumberInput
                                id="closeTime"
                                kind="closeTime"
                                label="加载后停留"
                                unit="秒"
                                hint={`${SETTING_LIMITS.closeTime.min}～${SETTING_LIMITS.closeTime.max} 的整数`}
                                value={closeTime}
                                onChange={setCloseTime}
                                disabled={settingsUnreadable}
                            />
                        </div>
                        <p className="field-note">页面加载完成后，等待指定时间再关闭；0 表示加载后尽快关闭。</p>
                        {isTimeoutRisky && (
                            <p className="field-warning" role="status">
                                短于 {RECOMMENDED_MIN_TIMEOUT_SECONDS} 秒的间隔是否会被计分，扩展无法确认；浏览器也可能把间隔拉长。建议 {DEFAULTS.timeout} 秒或更长；填 0 时实际约 1 秒。
                            </p>
                        )}
                        <div className="divider" />
                        <div className="search-option">
                            <TaskTile id="openFirstResult" label="打开首个结果" checked={openFirstResult} onChange={setOpenFirstResult} disabled={settingsUnreadable} />
                            <p className="field-note">搜索的附属设置。开启后，每个搜索页会在停留片刻后跳转到首个结果所在的网站。</p>
                        </div>
                    </section>
                </div>
                {settingsDirtyWhileRunning && (
                    <p className="field-note" role="status">设置将用于下一轮任务。</p>
                )}
                <LoadNote state={loadState} onRetry={() => retryFailedLoads(bindings)} />
                <SaveNote state={saveState} onRetry={() => retryFailed(bindings)} />

                <a className="ghost-button" href={HELP_URL} target="_blank" rel="noopener noreferrer" id="settingsHelpLink">
                    使用说明
                    <Icon name="external-link" />
                </a>
            </main>
        );
    }

    return (
        <main className="popup">
            <header className="header">
                <h1 className="heading">Rewards 助手</h1>
                <a className="help-button" href={HELP_URL} target="_blank" rel="noopener noreferrer" aria-label="帮助" id="helpLink">
                    <Icon name="circle-help" size="medium" />
                </a>
            </header>

            <section className="card card--status" aria-labelledby="status-heading">
                <h2 id="status-heading" className="visually-hidden">运行状态</h2>
                <div className="status-head">
                    <span className={`status-pill status-pill--${status.tone}`} role="status">
                        {status.text}
                    </span>
                </div>
                <p className="round-note">
                    {isRunning
                        ? runningSummary(results, displaySearches, displayTimeout)
                        : nextRoundSummary({ search: active, daily: autoDaily, claim: claimPoints, searches, timeout })}
                </p>
                {settingsDirtyWhileRunning && (
                    <p className="field-note" role="status">设置将用于下一轮任务。</p>
                )}

                {hasSearchToShow && <SearchProgressBar completed={completed} total={total} />}

                <ManualClaimButton
                    isRunning={isRunning}
                    isStopping={isStopping}
                    canStart={hasTaskSelected}
                    disabled={!isLoaded || isStopping || settingsNotReady}
                    onStop={() => setStopRequested(true)}
                    // The stop was refused or never answered while the round may
                    // still be running: unroll the mark, or the button stays on
                    // "正在停止" and the stop cannot be sent again.
                    onStopFailed={() => setStopRequested(false)}
                />
                {!hasTaskSelected && !isRunning && (
                    <p className="field-warning" role="status">请在设置中选择至少一项任务</p>
                )}
            </section>

            {hasResults && (
                <section className="card" aria-labelledby="results-heading">
                    <div className="card-head">
                        <h2 id="results-heading" className="card-title">任务进度</h2>
                        {handlingCount > 0 && <span className="card-head-note">{handlingCount} 项需处理</span>}
                    </div>
                    <TaskResultsList results={results} isRunning={isRunning} settingsNotReady={settingsNotReady} />
                </section>
            )}

            <section className="card">
                <div className="switch-row">
                    <label className="switch-label" htmlFor="autoRunEnabled">每日自动执行</label>
                    <input
                        className="switch"
                        type="checkbox"
                        role="switch"
                        id="autoRunEnabled"
                        checked={autoRunEnabled}
                        disabled={settingsUnreadable}
                        onChange={(e) => setAutoRunEnabled(e.target.checked)}
                    />
                </div>
                <AutoRunNote enabled={autoRunEnabled} attempts={attempts} nextCheck={nextCheck} />
                <div className="divider" />
                <button type="button" className="advanced-row" onClick={() => setShowSettings(true)}>
                    <span className="advanced-text">
                        <span className="advanced-title">高级设置</span>
                        <span className="advanced-sub">{nextRoundSummary({ search: active, daily: autoDaily, claim: claimPoints, searches, timeout })}</span>
                    </span>
                    <Icon name="chevron-right" />
                </button>
            </section>

            <LoadNote state={loadState} onRetry={() => retryFailedLoads(bindings)} />
            <SaveNote state={saveState} onRetry={() => retryFailed(bindings)} />
            <a className="ghost-button" href={REWARDS_URL} target="_blank" rel="noopener noreferrer" id="rewardsLink">
                打开 Rewards
                <Icon name="external-link" />
            </a>
        </main>
    );
}

// What this round is actually doing, from the results it recorded at start.
// The search count is the frozen one, so a later edit of the setting cannot
// change the line while the round is still going.
function runningSummary(results: TaskResults, searches: number, timeout: number): string {
    const parts = [
        results.search && `搜索 ${searches} 次 · 间隔 ${timeout} 秒`,
        results.daily && '每日活动',
        results.claim && '领取积分',
    ].filter(Boolean);
    return parts.length > 0 ? `本轮 ${parts.join(' · ')}` : '本轮任务进行中';
}

function retryFailed(bindings: { saveState: SaveState; retrySave: () => void }[]): void {
    for (const binding of bindings) {
        if (binding.saveState === 'error') binding.retrySave();
    }
}

function retryFailedLoads(bindings: { loadState: LoadState; retryLoad: () => void }[]): void {
    for (const binding of bindings) {
        if (binding.loadState === 'error') binding.retryLoad();
    }
}

// A failed read leaves the defaults on screen, so the failure carries its own
// retry — on both views, next to the save note.
function LoadNote({ state, onRetry }: { state: LoadState; onRetry: () => void }) {
    if (state !== 'error') return null;
    return (
        <p className="save-note save-note--error" role="status">
            设置读取失败
            <button type="button" className="save-retry" onClick={onRetry}>重新读取</button>
        </p>
    );
}

function SaveNote({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
    if (state === 'idle') return null;
    const failed = state === 'error';
    return (
        <p className={`save-note${failed ? ' save-note--error' : ''}`} role="status">
            {state === 'saving' ? '正在保存' : failed ? '保存失败，请重试' : '已保存'}
            {failed && (
                <button type="button" className="save-retry" onClick={onRetry}>重试保存</button>
            )}
        </p>
    );
}

const CHECK_TIME = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

function AutoRunNote({ enabled, attempts, nextCheck }: {
    enabled: boolean;
    attempts: TaskAttempts;
    nextCheck: number | null;
}) {
    if (!enabled) return <p className="field-note">每日自动未开启</p>;
    const today = localDateId();
    const tried = (Object.keys(ATTEMPT_LABELS) as TaskKind[])
        .filter((kind) => attempts[kind] === today)
        .map((kind) => ATTEMPT_LABELS[kind]);
    return (
        <div className="auto-note">
            <p className="field-note">浏览器启动时检查，之后约每 6 小时检查</p>
            {tried.length > 0 && <p className="field-note">今日已尝试：{tried.join('、')}</p>}
            {nextCheck != null && <p className="field-note">下次检查：{CHECK_TIME.format(nextCheck)}</p>}
        </div>
    );
}

interface TaskTileProps {
    id: string;
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    // While the stored value could not be read, the shown state is the default,
    // not the user's setting — a flip made then would never reach storage.
    disabled?: boolean;
}

function TaskTile({ id, label, checked, onChange, disabled }: TaskTileProps) {
    return (
        <label className={`tile${checked ? ' tile--on' : ''}`} htmlFor={id}>
            <input
                className="tile-input"
                type="checkbox"
                id={id}
                checked={checked}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
            />
            <span className="tile-box" aria-hidden="true">
                <Icon name="check" />
            </span>
            {label}
        </label>
    );
}

export default App;
