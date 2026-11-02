import { toSearchProgress } from '@/entrypoints/utils/progress';

interface SearchProgressBarProps {
    completed: number;
    total: number;
}

const RADIUS = 54;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// "completed" is how many search tabs this round has opened. It is not a count
// of points: opening a tab is all this extension can observe.
function SearchProgressBar({ completed, total }: SearchProgressBarProps) {
    const { completed: done, total: goal, percent } = toSearchProgress(completed, total);
    return (
        <div
            className="progress-ring"
            role="progressbar"
            aria-valuenow={done}
            aria-valuemin={0}
            aria-valuemax={goal}
            aria-label={`已发起 ${done} 次搜索，计划 ${goal} 次，不代表获得积分`}
        >
            <svg viewBox="0 0 120 120" aria-hidden="true">
                <circle cx="60" cy="60" r={RADIUS} fill="none" stroke="var(--border)" strokeWidth="10" />
                <circle
                    cx="60"
                    cy="60"
                    r={RADIUS}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="10"
                    strokeLinecap="round"
                    strokeDasharray={CIRCUMFERENCE}
                    strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
                    transform="rotate(-90 60 60)"
                    style={{ transition: 'stroke-dashoffset 0.25s ease' }}
                />
            </svg>
            <div className="progress-ring-value">
                <span className="progress-ring-number">{done}</span>
                <span className="progress-ring-unit">/ {goal}</span>
                <span className="progress-ring-caption">次搜索</span>
            </div>
        </div>
    );
}

export default SearchProgressBar;
