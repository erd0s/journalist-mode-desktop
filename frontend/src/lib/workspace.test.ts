import {describe, expect, it} from 'vitest';
import {
    aggregateSaveState,
    adjacentPanePath,
    createSaveBatch,
    needsCloseConfirmation,
    nextAllDoingHistoryVisibility,
    recordSaveBatchResult,
    workspaceActionForShortcut,
} from './workspace';

const command = (key: string, modifiers: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
}> = {}) => workspaceActionForShortcut({
    key,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
});

describe('workspaceActionForShortcut', () => {
    it('maps horizontal focus shortcuts', () => {
        expect(command('ArrowLeft', {altKey: true})).toEqual({type: 'move-focus', delta: -1});
        expect(command('ArrowRight', {altKey: true})).toEqual({type: 'move-focus', delta: 1});
    });

    it('maps pane visibility and zoom shortcuts', () => {
        expect(command('z', {shiftKey: true})).toEqual({type: 'toggle-zoom'});
        expect(command('b')).toEqual({type: 'focus-todo'});
        expect(command('h', {shiftKey: true})).toEqual({type: 'toggle-all-doing-history'});
        expect(command('h', {altKey: true})).toEqual({type: 'toggle-focused-doing-history'});
    });

    it('maps numbers to matching Doing streams and rejects conflicting modifiers or repeats', () => {
        expect(command('3')).toEqual({type: 'focus-doing', streamIndex: 3});
        expect(command('3', {altKey: true})).toBeNull();
        expect(command('b', {shiftKey: true})).toBeNull();
        expect(command('b', {repeat: true})).toBeNull();
        expect(command('b', {metaKey: false})).toBeNull();
    });
});

describe('nextAllDoingHistoryVisibility', () => {
    it('shows all only when every Doing pane currently hides history', () => {
        expect(nextAllDoingHistoryVisibility([false, false, false])).toBe(true);
        expect(nextAllDoingHistoryVisibility([true, true, true])).toBe(false);
        expect(nextAllDoingHistoryVisibility([true, false, true])).toBe(false);
        expect(nextAllDoingHistoryVisibility([])).toBe(false);
    });
});

describe('aggregateSaveState', () => {
    it('closes clean workspaces directly and prompts for every non-clean state', () => {
        expect(needsCloseConfirmation('saved')).toBe(false);
        expect(needsCloseConfirmation('dirty')).toBe(true);
        expect(needsCloseConfirmation('saving')).toBe(true);
        expect(needsCloseConfirmation('conflict')).toBe(true);
        expect(needsCloseConfirmation('error')).toBe(true);
    });

    it('keeps close protection active until every pane is saved', () => {
        expect(aggregateSaveState(['saved', 'saved'])).toBe('saved');
        expect(aggregateSaveState(['saved', 'dirty'])).toBe('dirty');
        expect(aggregateSaveState(['saving', 'dirty'])).toBe('saving');
        expect(aggregateSaveState(['error', 'saving'])).toBe('saving');
        expect(aggregateSaveState(['conflict', 'saving'])).toBe('saving');
        expect(aggregateSaveState(['conflict', 'error'])).toBe('conflict');
    });

    it('waits for the original panes and preserves any failure', () => {
        const batch = createSaveBatch(['todo', 'doing-1']);
        expect(recordSaveBatchResult(batch, 'doing-created-later', true)).toBeNull();
        expect(recordSaveBatchResult(batch, 'todo', true)).toBeNull();
        expect(recordSaveBatchResult(batch, 'doing-1', false)).toBe(false);

        const successful = createSaveBatch(['todo', 'doing-1']);
        expect(recordSaveBatchResult(successful, 'doing-1', true)).toBeNull();
        expect(recordSaveBatchResult(successful, 'todo', true)).toBe(true);
    });
});

describe('adjacentPanePath', () => {
    const paths = ['todo', 'doing-1', 'doing-2'];

    it('moves in both directions and wraps at the edges', () => {
        expect(adjacentPanePath(paths, 'doing-1', -1)).toBe('todo');
        expect(adjacentPanePath(paths, 'doing-1', 1)).toBe('doing-2');
        expect(adjacentPanePath(paths, 'todo', -1)).toBe('doing-2');
        expect(adjacentPanePath(paths, 'doing-2', 1)).toBe('todo');
    });

    it('chooses the movement edge if the current pane is not visible', () => {
        expect(adjacentPanePath(paths, 'hidden', 1)).toBe('todo');
        expect(adjacentPanePath(paths, 'hidden', -1)).toBe('doing-2');
        expect(adjacentPanePath([], 'hidden', 1)).toBe('');
    });
});
