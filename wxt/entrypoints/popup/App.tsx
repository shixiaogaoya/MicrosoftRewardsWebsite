import './App.css';
import { useEffect, useState } from 'react';
import { useStorage } from '@/entrypoints/hooks/useStorage';
import { useSearchProgress } from '@/entrypoints/hooks/useSearchProgress';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { DEFAULTS, LEVEL_SEARCHES, SETTING_LIMITS, clampSetting } from '@/entrypoints/utils/settings';
import { clearBadge } from '@/entrypoints/utils/browserAction';
import { RECOMMENDED_MIN_TIMEOUT_SECONDS } from '@/entrypoints/utils/search';
import type { TaskResult, TaskResults, TaskStatus } from '@/entrypoints/utils/runState';
import NumberInput from '@/entrypoints/components/NumberInput';
import AccountLevelSelect from '@/entrypoints/components/AccountLevelSelect';
import ManualClaimButton from '@/entrypoints/components/ManualClaimButton';
import SearchProgressBar from '@/entrypoints/components/SearchProgressBar';
import TaskResultsList from '@/entrypoints/components/TaskResults';

// The fork's own Chinese README, not the upstream one: the behaviour documented
// there (stopping a round, the auto-run switch, 已发起 versus 到账) is this fork's.
const HELP_URL = 'https://github.com/shixiaogaoya/MicrosoftRewardsWebsite#readme';
const REWARDS_URL = 'https://rewards.bing.com/';

// A running task is still in progress, not something the user has to confirm.
const NEEDS_ATTENTION: ReadonlySet<TaskStatus> = new Set(['failed', 'unconfirmed', 'cancelled']);

const LEVEL_LABELS: Record<string, string> = {
    member: '会员 · 5 次',
    silver: '银级 · 10 次',
    gold: '金级 · 20 次',
};

export function needsAttention(result: TaskResult | undefined): boolean {
    return result != null && NEEDS_ATTENTION.has(result.status);
}

export function countAttention(results: TaskResults): number {
    return [results.search, results.daily, results.claim].filter(needsAttention).length;
}

function App() {
    const [active, setActive] = useStorage<boolean>('active', DEFAULTS.active, StorageValues.SYNC);
    const [autoDaily, setAutoDaily] = useStorage<boolean>('autoDaily', DEFAULTS.autoDaily, StorageValues.SYNC);
    const [searchesStored, setSearches] = useStorage<number>('searches', DEFAULTS.searches, StorageValues.SYNC);
    const [timeoutStored, setTimeoutValue] = useStorage<number>('timeout', DEFAULTS.timeout, StorageValues.SYNC);
    const [closeTimeStored, setCloseTime] = useStorage<number>('closeTime', DEFAULTS.closeTime, StorageValues.SYNC);
    const [accountLevel, setAccountLevel] = useStorage<string>('accountLevel', DEFAULTS.accountLevel, StorageValues.SYNC);
    const [openFirstResult, setOpenFirstResult] = useStorage<boolean>('openFirstResult', DEFAULTS.openFirstResult, StorageValues.SYNC);
    const [claimPoints, setClaimPoints] = useStorage<boolean>('claimPoints', DEFAULTS.claimPoints, StorageValues.SYNC);
    const [autoRunEnabled, setAutoRunEnabled] = useStorage<boolean>('autoRunEnabled', DEFAULTS.autoRunEnabled, StorageValues.SYNC);
    const [stopRequested, setStopRequested] = useState(false);
    // The settings live on their own view: the popup is one document, so this is
    // a view switch rather than a route.
    const [showSettings, setShowSettings] = useState(false);
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

    // Nothing has run yet: a 0/N ring would read as stalled, so it stays hidden.
    const hasSearchToShow = isLoaded && (isSearching || completed > 0);
    const hasResults = isLoaded && (results.search || results.daily || results.claim);
    const hasAttention = needsAttention(results.search) || needsAttention(results.daily) || needsAttention(results.claim);
    // "开始任务" needs at least one task selected. Auto-run is a separate switch:
    // off only means the alarm and startup will not start a round.
    const hasTaskSelected = active || autoDaily || claimPoints;
    const isStopping = phase === 'stopping' || stopRequested;

    // Gaps this short are honoured, but they are below what Microsoft reliably
    // credits — so the field warns rather than silently overriding the choice.
    const isTimeoutRisky = timeout < RECOMMENDED_MIN_TIMEOUT_SECONDS;

    const statusText = !isLoaded
        ? '正在读取'
        : isStopping
            ? '正在停止'
            : isRunning
                ? '正在执行'
                : hasAttention
                    ? '有结果待确认'
                    : completed > 0 || hasResults
                        ? '已停止'
                        : '准备就绪';

    // The pill next to the status text carries the state at a glance: a run in
    // flight, one that needs the user's eyes, and a plain idle state must not
    // all look the same.
    const statusTone = !isLoaded
        ? 'idle'
        : isStopping || isRunning
            ? 'busy'
            : hasAttention
                ? 'attention'
                : 'idle';

    const attentionCount = countAttention(results);

    // Picking a level sets a sensible search count; the number field stays
    // editable so the user can still override it. Opening the popup never does
    // this — only an explicit change of the preset does.
    function handleLevelChange(level: string): void {
        setAccountLevel(level);
        setSearches(LEVEL_SEARCHES[level] ?? DEFAULTS.searches);
    }

    if (showSettings) {
        return (
            <main className="popup">
                <header className="settings-header">
                    <button type="button" className="back-button" onClick={() => setShowSettings(false)} aria-label="返回">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M15 6l-6 6 6 6" />
                        </svg>
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
                            onChange={(e) => setAutoRunEnabled(e.target.checked)}
                        />
                    </div>
                </section>

                <div className="group">
                    <h2 className="group-title">执行内容</h2>
                    <section className="card">
                        <div className="tile-grid">
                            <TaskTile id="autoCheckbox" label="执行搜索" checked={active} onChange={setActive} />
                            <TaskTile id="autoDaily" label="完成每日活动" checked={autoDaily} onChange={setAutoDaily} />
                            <TaskTile id="claimPoints" label="领取积分" checked={claimPoints} onChange={setClaimPoints} />
                            <TaskTile id="openFirstResult" label="打开首个结果" checked={openFirstResult} onChange={setOpenFirstResult} />
                        </div>
                    </section>
                </div>

                <div className="group">
                    <h2 className="group-title">搜索参数</h2>
                    <section className="card">
                        <AccountLevelSelect value={accountLevel} onChange={handleLevelChange} />
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
                            />
                            <NumberInput
                                id="timeout"
                                kind="timeout"
                                label="搜索间隔"
                                unit="秒"
                                hint={`${SETTING_LIMITS.timeout.min}～${SETTING_LIMITS.timeout.max} 的整数`}
                                value={timeout}
                                onChange={setTimeoutValue}
                            />
                            <NumberInput
                                id="closeTime"
                                kind="closeTime"
                                label="关闭标签页"
                                unit="秒"
                                hint={`${SETTING_LIMITS.closeTime.min}～${SETTING_LIMITS.closeTime.max} 的整数，0 表示加载后即关闭`}
                                value={closeTime}
                                onChange={setCloseTime}
                            />
                        </div>
                        {isTimeoutRisky && (
                            <p className="field-warning" role="status">
                                短于 {RECOMMENDED_MIN_TIMEOUT_SECONDS} 秒时，Microsoft 常常不计积分，浏览器也可能把间隔拉长。建议 {DEFAULTS.timeout} 秒或更长；填 0 时实际约 1 秒。
                            </p>
                        )}
                    </section>
                </div>

                <a className="ghost-button" href={HELP_URL} target="_blank" rel="noopener noreferrer" id="settingsHelpLink">
                    使用说明
                    <ExternalIcon />
                </a>
            </main>
        );
    }

    return (
        <main className="popup">
            <header className="header">
                <div className="brand">
                    <span className="brand-mark" aria-hidden="true">
                        <img src="/imgs/rewards-r.svg" width="30" height="30" alt="" />
                    </span>
                    <h1 className="heading">Rewards 助手</h1>
                </div>
                <a className="help-button" href={HELP_URL} target="_blank" rel="noopener noreferrer" aria-label="帮助" id="helpLink">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M9.6 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1.1.9-1.1 1.7" />
                        <path d="M12 17h.01" />
                    </svg>
                </a>
            </header>

            <section className="card card--status" aria-labelledby="status-heading">
                <h2 id="status-heading" className="visually-hidden">运行状态</h2>
                <div className="status-head">
                    <span className={`status-pill status-pill--${statusTone}`} role="status">
                        <span className="status-dot" aria-hidden="true" />
                        {statusText}
                    </span>
                    <span className="level-note">{LEVEL_LABELS[accountLevel] ?? LEVEL_LABELS.member}</span>
                </div>

                {hasSearchToShow && <SearchProgressBar completed={completed} total={total} />}

                <ManualClaimButton
                    isRunning={isRunning}
                    isStopping={isStopping}
                    canStart={hasTaskSelected}
                    disabled={!isLoaded || isStopping}
                    onStop={() => setStopRequested(true)}
                />
                {!hasTaskSelected && !isRunning && (
                    <p className="field-warning" role="status">请在设置中选择至少一项任务</p>
                )}
            </section>

            {hasResults && (
                <section className="card" aria-labelledby="results-heading">
                    <div className="card-head">
                        <h2 id="results-heading" className="card-title">任务进度</h2>
                        {attentionCount > 0 && <span className="card-head-note">{attentionCount} 项待确认</span>}
                    </div>
                    <TaskResultsList results={results} isRunning={isRunning} />
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
                        onChange={(e) => setAutoRunEnabled(e.target.checked)}
                    />
                </div>
                <div className="divider" />
                <button type="button" className="advanced-row" onClick={() => setShowSettings(true)}>
                    <span className="advanced-text">
                        <span className="advanced-title">高级设置</span>
                        <span className="advanced-sub">{taskSummary(active, autoDaily, claimPoints, searches, timeout)}</span>
                    </span>
                    <svg className="advanced-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 6l6 6-6 6" />
                    </svg>
                </button>
            </section>

            <a className="ghost-button" href={REWARDS_URL} target="_blank" rel="noopener noreferrer" id="rewardsLink">
                打开 Rewards
                <ExternalIcon />
            </a>
        </main>
    );
}

// A one-line restatement of the current settings, so the entry point answers
// "what am I running?" without opening the settings view.
function taskSummary(active: boolean, autoDaily: boolean, claimPoints: boolean, searches: number, timeout: number): string {
    const tasks = [
        active && '搜索',
        autoDaily && '每日活动',
        claimPoints && '领取积分',
    ].filter(Boolean);
    if (tasks.length === 0) return '未选择任务';
    return `${tasks.join(' · ')} · ${searches} 次 · 间隔 ${timeout} 秒`;
}

interface TaskTileProps {
    id: string;
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}

function TaskTile({ id, label, checked, onChange }: TaskTileProps) {
    return (
        <label className={`tile${checked ? ' tile--on' : ''}`} htmlFor={id}>
            <input
                className="tile-input"
                type="checkbox"
                id={id}
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
            />
            <span className="tile-box" aria-hidden="true">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
            </span>
            {label}
        </label>
    );
}

function ExternalIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </svg>
    );
}

export default App;
