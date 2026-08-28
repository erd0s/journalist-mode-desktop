export type WorkspaceAction =
    | {type: 'focus-position'; position: number}
    | {type: 'move-focus'; delta: -1 | 1}
    | {type: 'toggle-zoom'}
    | {type: 'toggle-todo'}
    | {type: 'toggle-all-doing-history'}
    | {type: 'toggle-focused-doing-history'};

export type WorkspaceActionRequest = {
    action: WorkspaceAction;
    revision: number;
};

type Shortcut = {
    key: string;
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
        if (key === 'z') {
            return {type: 'toggle-zoom'};
        }
        if (key === 'h') {
            return {type: 'toggle-all-doing-history'};
        }
        return null;
    }
    if (key === 'b') {
        return {type: 'toggle-todo'};
    }
    if (/^[1-9]$/.test(key)) {
        return {type: 'focus-position', position: Number(key)};
    }
    return null;
}

export function nextAllDoingHistoryVisibility(visible: boolean[]): boolean {
    return visible.length > 0 && visible.every(value => !value);
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
