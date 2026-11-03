import { SEARCH_PRESETS, matchingSearchPreset } from '@/entrypoints/utils/settings';

interface SearchPresetSelectProps {
    searches: number;
    onSelect: (searches: number) => void;
}

// Shortcuts for the search count. The number field stays the source of truth:
// a count that matches a button highlights it, and any other count reads as custom.
function SearchPresetSelect({ searches, onSelect }: SearchPresetSelectProps) {
    const matched = matchingSearchPreset(searches);
    return (
        <div className="preset-row">
            <span className="preset-label" id="search-preset-label">次数预设</span>
            <div className="preset-buttons" role="group" aria-labelledby="search-preset-label">
                {SEARCH_PRESETS.map((count) => (
                    <button
                        key={count}
                        type="button"
                        className={`preset-button${matched === count ? ' preset-button--on' : ''}`}
                        aria-pressed={matched === count}
                        onClick={() => onSelect(count)}
                    >
                        {count} 次
                    </button>
                ))}
            </div>
            <span className={`preset-custom${matched == null ? ' preset-custom--on' : ''}`}>自定义</span>
        </div>
    );
}

export default SearchPresetSelect;
