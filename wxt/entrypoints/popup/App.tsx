import './App.css';
import { useEffect, useState } from 'react';
import { useStorage } from '@/entrypoints/hooks/useStorage';
import { useSearchProgress } from '@/entrypoints/hooks/useSearchProgress';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { DEFAULTS, LEVEL_SEARCHES, SETTING_LIMITS, clampSetting } from '@/entrypoints/utils/settings';
import { clearBadge } from '@/entrypoints/utils/browserAction';
import { RECOMMENDED_MIN_TIMEOUT_SECONDS } from '@/entrypoints/utils/search';
import type { TaskResult, TaskStatus } from '@/entrypoints/utils/runState';
import NumberInput from '@/entrypoints/components/NumberInput';
import AccountLevelSelect from '@/entrypoints/components/AccountLevelSelect';
import ManualClaimButton from '@/entrypoints/components/ManualClaimButton';
import SearchProgressBar from '@/entrypoints/components/SearchProgressBar';
import TaskResultsList from '@/entrypoints/components/TaskResults';

// The fork's own Chinese README, not the upstream one: the behaviour documented
// there (stopping a round, the auto-run switch, 已发起 versus 到账) is this fork's.
const HELP_URL = 'https://github.com/shixiaogaoya/MicrosoftRewardsWebsite#readme';
const REWARDS_URL = 'https://rewards.bing.com/';

const QUIET: ReadonlySet<TaskStatus> = new Set(['completed', 'not-needed']);

function needsAttention(result: TaskResult | undefined): boolean {
    return result != null && !QUIET.has(result.status);
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
    const [detailsOpen, setDetailsOpen] = useState(false);
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

    // Nothing has run yet: a 0/N bar would read as stalled, so it stays hidden.
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

    // Picking a level sets a sensible search count; the number field stays
    // editable so the user can still override it. Opening the popup never does
    // this — only an explicit change of the preset does.
    function handleLevelChange(level: string): void {
        setAccountLevel(level);
        setSearches(LEVEL_SEARCHES[level] ?? DEFAULTS.searches);
    }

    return (
        <main className="popup">
            <h1 className="heading">Rewards 助手</h1>
            <p className="status-line" role="status">{statusText}</p>

            <ManualClaimButton
                isRunning={isRunning}
                isStopping={isStopping}
                canStart={hasTaskSelected}
                disabled={!isLoaded || isStopping}
                onStop={() => setStopRequested(true)}
            />
            {!hasTaskSelected && !isRunning && (
                <p className="field-warning" role="status">请在高级设置中选择至少一项任务</p>
            )}

            {hasSearchToShow && (
                <SearchProgressBar completed={completed} total={total} />
            )}
            {hasResults && (
                <TaskResultsList results={results} isRunning={isRunning} />
            )}
            {hasAttention && (
                <details className="details" open={detailsOpen} onToggle={(e) => setDetailsOpen(e.currentTarget.open)}>
                    <summary>查看详情</summary>
                    <TaskResultsList results={results} isRunning={isRunning} detailed />
                </details>
            )}

            <div className="checkboxes">
                <div className="input-with-info">
                    <input className="form-check-input" type="checkbox" id="autoRunEnabled" checked={autoRunEnabled} onChange={(e) => setAutoRunEnabled(e.target.checked)} />
                    <label htmlFor="autoRunEnabled">每日自动执行</label>
                </div>
            </div>

            <details className="advanced">
                <summary>高级设置</summary>
                <div className="checkboxes">
                    <div className="input-with-info">
                        <input className="form-check-input" type="checkbox" id="autoCheckbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                        <label htmlFor="autoCheckbox">执行搜索</label>
                    </div>
                    <div className="input-with-info">
                        <input className="form-check-input" type="checkbox" id="autoDaily" checked={autoDaily} onChange={(e) => setAutoDaily(e.target.checked)} />
                        <label htmlFor="autoDaily">完成每日活动</label>
                    </div>
                    <div className="input-with-info">
                        <input className="form-check-input" type="checkbox" id="claimPoints" checked={claimPoints} onChange={(e) => setClaimPoints(e.target.checked)} />
                        <label htmlFor="claimPoints">领取积分</label>
                    </div>
                    <div className="input-with-info">
                        <input className="form-check-input" type="checkbox" id="openFirstResult" checked={openFirstResult} onChange={(e) => setOpenFirstResult(e.target.checked)} />
                        <label htmlFor="openFirstResult">打开首个搜索结果</label>
                    </div>
                </div>

                <div className="inputs">
                    <AccountLevelSelect value={accountLevel} onChange={handleLevelChange} />
                    <div>
                        <NumberInput
                            id="searches"
                            kind="searches"
                            label="搜索次数"
                            hint={`请输入 ${SETTING_LIMITS.searches.min}～${SETTING_LIMITS.searches.max} 的整数`}
                            value={searches}
                            onChange={setSearches}
                        />
                    </div>
                    <div>
                        <NumberInput
                            id="timeout"
                            kind="timeout"
                            label="搜索间隔（秒）"
                            hint={`请输入 ${SETTING_LIMITS.timeout.min}～${SETTING_LIMITS.timeout.max} 的整数`}
                            value={timeout}
                            onChange={setTimeoutValue}
                        />
                        {isTimeoutRisky && (
                            <p className="field-warning" role="status">
                                短于 {RECOMMENDED_MIN_TIMEOUT_SECONDS} 秒时，Microsoft 常常不计积分，浏览器也可能把间隔拉长。建议 {DEFAULTS.timeout} 秒或更长。填 0 时实际大约相隔 1 秒，不会一次打开全部标签页。
                            </p>
                        )}
                    </div>
                    <div>
                        <NumberInput
                            id="closeTime"
                            kind="closeTime"
                            label="标签页关闭时间（秒）"
                            hint={`请输入 ${SETTING_LIMITS.closeTime.min}～${SETTING_LIMITS.closeTime.max} 的整数。0 表示页面加载后就关闭`}
                            value={closeTime}
                            onChange={setCloseTime}
                        />
                    </div>
                </div>
            </details>

            <nav className="footer-links" aria-label="相关页面">
                <a className="links" href={REWARDS_URL} target="_blank" rel="noopener noreferrer" id="rewardsLink">打开 Rewards</a>
                <a className="links" href={HELP_URL} target="_blank" rel="noopener noreferrer" id="helpLink">帮助</a>
            </nav>
        </main>
    );
}

export default App;
