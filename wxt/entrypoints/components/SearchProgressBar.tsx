import { toSearchProgress } from '@/entrypoints/utils/progress';

interface SearchProgressBarProps {
    completed: number;
    total: number;
}

// "completed" is how many search tabs this round has opened. It is not a count
// of points: opening a tab is all this extension can observe.
function SearchProgressBar({ completed, total }: SearchProgressBarProps) {
    const { completed: done, total: goal, percent } = toSearchProgress(completed, total);
    return (
        <div className="progress-card" role="status" aria-live="polite">
            <div className="progress-row">
                <span className="progress-count">
                    已发起 <strong>{done}</strong>/{goal} 次搜索
                </span>
            </div>
            <div
                className="progress-track"
                role="progressbar"
                aria-valuenow={done}
                aria-valuemin={0}
                aria-valuemax={goal}
                aria-label={`已发起 ${done} 次搜索，计划 ${goal} 次，不代表获得积分`}
            >
                <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
        </div>
    );
}

export default SearchProgressBar;
