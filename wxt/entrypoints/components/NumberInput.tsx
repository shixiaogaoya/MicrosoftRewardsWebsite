import { useEffect, useState } from 'react';
import { parseSettingInput, type NumericSetting } from '@/entrypoints/utils/settings';

interface NumberInputProps {
    id: string;
    label: string;
    kind: NumericSetting;
    value: number;
    hint: string;
    onChange: (value: number) => void;
}

// The box may be emptied while the user is typing. That draft is not a setting:
// only a whole number inside the range is written, and an invalid draft is
// replaced by the last saved value when the field loses focus.
function NumberInput({ id, label, kind, value, hint, onChange }: NumberInputProps) {
    const [draft, setDraft] = useState(String(value));
    const [invalid, setInvalid] = useState(false);

    useEffect(() => {
        setDraft(String(value));
        setInvalid(false);
    }, [value]);

    function commit(raw: string): void {
        const next = parseSettingInput(kind, raw);
        if (next == null) {
            setDraft(String(value));
            setInvalid(false);
            return;
        }
        setInvalid(false);
        if (next !== value) onChange(next);
    }

    return (
        <span className="field">
            <input
                type="text"
                inputMode="numeric"
                id={id}
                aria-invalid={invalid}
                aria-describedby={invalid ? `${id}-hint` : undefined}
                value={draft}
                onChange={(e) => {
                    const raw = e.target.value;
                    setDraft(raw);
                    const next = parseSettingInput(kind, raw);
                    // A blank box is a draft, not a valid setting: report it the
                    // same way as a decimal or an out-of-range value instead of
                    // staying silent until blur quietly restores the old number.
                    setInvalid(next == null);
                    if (next != null && next !== value) onChange(next);
                }}
                onBlur={() => commit(draft)}
            />
            <label htmlFor={id}>{label}</label>
            {invalid && <span id={`${id}-hint`} className="field-hint" role="status">{hint}</span>}
        </span>
    );
}

export default NumberInput;
