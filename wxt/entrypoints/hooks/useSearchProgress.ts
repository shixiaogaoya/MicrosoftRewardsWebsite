import { useEffect, useState } from 'react';
import { storage } from '#imports';
import { getStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { EMPTY_PROGRESS, PROGRESS_KEY, RESULTS_KEY, RUN_KEY, type RunProgress, type TaskResults, type TaskRunState } from '@/entrypoints/utils/runState';

export interface SearchProgressState {
    // False until the first read resolves, so the UI can avoid flashing an
    // "idle" state over a run that is actually in progress.
    isLoaded: boolean;
    isSearching: boolean;
    // Search tabs this round has opened. Not points earned.
    completed: number;
    total: number;
    isRunning: boolean;
    phase: TaskRunState['phase'] | null;
    results: TaskResults;
}

const INITIAL: SearchProgressState = {
    isLoaded: false,
    isSearching: false,
    completed: 0,
    total: 0,
    isRunning: false,
    phase: null,
    results: {},
};

// Live view of the background's round. The background owns these local keys, so
// this hook only reads them: once at mount, then on every storage change. The
// sync run keys are not read — another device's copy of them is not this
// device's progress.
export function useSearchProgress(): SearchProgressState {
    const [state, setState] = useState<SearchProgressState>(INITIAL);

    useEffect(() => {
        let isMounted = true;

        function apply(progress: RunProgress | null, run: TaskRunState | null, results: TaskResults | null): void {
            const view = progress ?? EMPTY_PROGRESS;
            setState({
                isLoaded: true,
                isSearching: view.isSearching,
                completed: view.opened,
                total: view.total,
                isRunning: run != null,
                phase: run?.phase ?? null,
                results: results ?? {},
            });
        }

        void Promise.all([
            getStorageItem<RunProgress>(PROGRESS_KEY, StorageValues.LOCAL),
            getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL),
            getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL),
        ]).then(([progress, run, results]) => {
            if (!isMounted) return;
            apply(progress, run, results);
        });

        const unwatchers = [
            storage.watch<RunProgress>(`local:${PROGRESS_KEY}`, (value) =>
                setState((prev) => ({
                    ...prev,
                    isSearching: value?.isSearching ?? false,
                    completed: value?.opened ?? 0,
                    total: value?.total ?? 0,
                }))
            ),
            storage.watch<TaskRunState>(`local:${RUN_KEY}`, (value) =>
                setState((prev) => ({ ...prev, isRunning: value != null, phase: value?.phase ?? null }))
            ),
            storage.watch<TaskResults>(`local:${RESULTS_KEY}`, (value) =>
                setState((prev) => ({ ...prev, results: value ?? {} }))
            ),
        ];

        return () => {
            isMounted = false;
            unwatchers.forEach((unwatch) => unwatch());
        };
    }, []);

    return state;
}
