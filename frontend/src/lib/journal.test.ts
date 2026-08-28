import {describe, expect, it} from 'vitest';
import {
    appendDoingChild,
    copyTodoText,
    ensureDoingTimestamp,
    ensureDoingTimestampSpacing,
    ensureTodoDate,
    finishDeepestDoing,
    finishTodo,
} from './journal';

const now = new Date(2026, 7, 28, 10, 46);

describe('JM Doing behavior', () => {
    it('timestamps first input and appends a child beneath the deepest task', () => {
        const root = ensureDoingTimestamp('build the app', now);
        expect(root).toBe('(2026-08-28 10:46) build the app');

        const result = appendDoingChild([root], now);
        expect(result.lines[1]).toBe('\t(2026-08-28 10:46) ');
        expect(ensureDoingTimestampSpacing('\t(2026-08-28 10:46)draft')).toBe('\t(2026-08-28 10:46) draft');
    });

    it('completes the deepest task and returns focus to its parent', () => {
        const lines = [
            '(2026-08-28 10:40) build the app',
            '\t(2026-08-28 10:41) style the panes',
        ];
        const result = finishDeepestDoing(lines, false, now);

        expect(result.lines[1]).toBe('\t~~(2026-08-28 10:41) style the panes (2026-08-28 10:46)~~');
        expect(result.focusIndex).toBe(0);
    });
});

describe('JM TODO behavior', () => {
    it('prepends a creation date only to task lines', () => {
        expect(ensureTodoDate('write tests', now)).toBe('[2026-08-28] write tests');
        expect(ensureTodoDate('# Work', now)).toBe('# Work');
    });

    it('moves a completed task beneath the divider and removes an empty category', () => {
        const result = finishTodo(['# Work', '', '[2026-08-28] write tests'], 2, false, now);
        expect(result.lines).toEqual(['---', '', '~~[2026-08-28] write tests [2026-08-28]~~']);
    });

    it('copies task text without surrounding dates', () => {
        expect(copyTodoText('~~[2026-08-28] write tests [2026-08-29]~~')).toBe('write tests');
    });
});
