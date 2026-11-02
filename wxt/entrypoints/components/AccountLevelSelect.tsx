interface AccountLevelSelectProps {
    value: string;
    onChange: (level: string) => void;
}

const LEVELS: { value: string; label: string }[] = [
    { value: 'member', label: '会员（5 次）' },
    { value: 'silver', label: '银级（10 次）' },
    { value: 'gold', label: '金级（20 次）' },
];

const BENEFITS_URL = 'https://rewards.bing.com/about?section=benefits';

// The hint under the control links to the Rewards benefits page so users can
// check which level they're on. Picking a level sets a sensible default search
// count. The link sits outside the label on purpose: inside it, the block-level
// link stacked the control, its label and the link into three separate lines.
function AccountLevelSelect({ value, onChange }: AccountLevelSelectProps) {
    return (
        <div className="field">
            <label htmlFor="accountLevel">账号等级</label>
            <select id="accountLevel" value={value} onChange={(e) => onChange(e.target.value)}>
                {LEVELS.map((level) => (
                    <option key={level.value} value={level.value}>{level.label}</option>
                ))}
            </select>
            <a className="level-link" href={BENEFITS_URL} target="_blank" rel="noopener noreferrer">
                查看 Microsoft Rewards 等级
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                </svg>
            </a>
        </div>
    );
}

export default AccountLevelSelect;
