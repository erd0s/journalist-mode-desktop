export type WorkspaceAction =
    | {type: 'focus-todo'}
    | {type: 'focus-doing'; streamIndex: number}
    | {type: 'move-focus'; delta: -1 | 1}
    | {type: 'toggle-zoom'}
    | {type: 'toggle-all-doing-history'}
    | {type: 'toggle-focused-doing-history'};

export type WorkspaceActionRequest = {
    action: WorkspaceAction;
    revision: number;
};

export type WorkspaceSaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

export type SaveBatch = {
    expectedPaths: Set<string>;
    results: Map<string, boolean>;
};

type Shortcut = {
    key: string;
    code?: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    repeat?: boolean;
};

export function workspaceActionForShortcut(shortcut: Shortcut): WorkspaceAction | null {
    if (shortcut.repeat || !(shortcut.metaKey || shortcut.ctrlKey)) {
        return null;
    }

    const key = shortcut.key.toLowerCase();
    // Option can change event.key (for example, Z becomes Ω on a Mac).
    if (shortcut.ctrlKey && shortcut.altKey && !shortcut.metaKey && !shortcut.shiftKey
        && (shortcut.code === 'KeyZ' || key === 'z')) {
        return {type: 'toggle-zoom'};
    }
    if (shortcut.altKey && !shortcut.shiftKey) {
        if (key === 'arrowleft') {
            return {type: 'move-focus', delta: -1};
        }
        if (key === 'arrowright') {
            return {type: 'move-focus', delta: 1};
        }
        if (key === 'h') {
            return {type: 'toggle-focused-doing-history'};
        }
        return null;
    }
    if (shortcut.altKey) {
        return null;
    }
    if (shortcut.shiftKey) {
        if (key === 'h') {
            return {type: 'toggle-all-doing-history'};
        }
        return null;
    }
    if (key === 'b') {
        return {type: 'focus-todo'};
    }
    if (/^[1-9]$/.test(key)) {
        return {type: 'focus-doing', streamIndex: Number(key)};
    }
    return null;
}

export function nextAllDoingHistoryVisibility(visible: boolean[]): boolean {
    return visible.length > 0 && visible.every(value => !value);
}

export function aggregateSaveState(states: WorkspaceSaveState[]): WorkspaceSaveState {
    // Never expose Discard while any pane still has an uncancellable write in
    // flight. Once saving settles, conflicts and errors take precedence.
    for (const state of ['saving', 'conflict', 'error', 'dirty'] as const) {
        if (states.includes(state)) {
            return state;
        }
    }
    return 'saved';
}

export function needsCloseConfirmation(state: WorkspaceSaveState): boolean {
    return state !== 'saved';
}

export function createSaveBatch(paths: string[]): SaveBatch {
    return {
        expectedPaths: new Set(paths),
        results: new Map<string, boolean>(),
    };
}

// Returns null until every expected pane reports, then returns whether all
// panes saved. Results from panes created after the batch began are ignored.
export function recordSaveBatchResult(
    batch: SaveBatch,
    path: string,
    succeeded: boolean,
): boolean | null {
    if (!batch.expectedPaths.has(path)) {
        return null;
    }
    batch.results.set(path, succeeded);
    if (![...batch.expectedPaths].every(expectedPath => batch.results.has(expectedPath))) {
        return null;
    }
    return [...batch.expectedPaths].every(expectedPath => batch.results.get(expectedPath) === true);
}

export function adjacentPanePath(
    paths: string[],
    currentPath: string,
    delta: -1 | 1,
): string {
    if (paths.length === 0) {
        return '';
    }
    const currentIndex = paths.indexOf(currentPath);
    if (currentIndex === -1) {
        return delta === 1 ? paths[0] : paths[paths.length - 1];
    }
    return paths[(currentIndex + delta + paths.length) % paths.length];
}
