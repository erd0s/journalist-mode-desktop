// @vitest-environment jsdom

import {act} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {appAPI, DayData} from '../api';
import {DayWorkspace} from './DayWorkspace';

const day = {
    date: '2026-09-05',
    todo: {
        path: '/journal/Todo/2026-09-05.jmtodo.md',
        name: '2026-09-05.jmtodo.md',
        content: '[2026-09-05] Todo zoom check',
        exists: true,
        streamIndex: 0,
    },
    doing: [{
        path: '/journal/Doing/2026-09-05.jm.md',
        name: '2026-09-05.jm.md',
        content: '(2026-09-05 18:00) Doing zoom check',
        exists: true,
        streamIndex: 1,
    }],
} as DayData;

class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}

describe('focused editor zoom shortcut', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean})
            .IS_REACT_ACT_ENVIRONMENT = true;
        globalThis.ResizeObserver = ResizeObserverStub;
        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = () => new DOMRect();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        vi.spyOn(appAPI, 'readJournalFiles').mockResolvedValue([day.todo, ...day.doing]);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        vi.restoreAllMocks();
    });

    it.each([false, true])('toggles the focused pane with a native environment of %s', async native => {
        vi.spyOn(appAPI, 'isNative').mockReturnValue(native);
        await act(async () => root.render(
            <DayWorkspace
                day={day}
                debugMode={false}
                saveRequest={0}
                discardRequest={0}
                newDoingRequest={0}
                workspaceActionRequest={{action: {type: 'focus-todo'}, revision: 0}}
                interactionDisabled={false}
                onError={vi.fn()}
                onSaveStateChange={vi.fn()}
                onSaveComplete={vi.fn()}
            />,
        ));
        const panes = [...host.querySelectorAll<HTMLElement>('.journal-pane')];
        expect(panes).toHaveLength(2);
        for (const pane of panes) {
            const editor = pane.querySelector<HTMLElement>('.cm-content')!;
            const content = editor.textContent;
            await act(async () => editor.focus());
            for (const zoomed of [true, false]) {
                const event = new KeyboardEvent('keydown', {
                    key: 'Ω', code: 'KeyZ', ctrlKey: true, altKey: true,
                    bubbles: true, cancelable: true,
                });
                await act(async () => { editor.dispatchEvent(event); });
                expect(event.defaultPrevented).toBe(true);
                expect(host.querySelector('.pane-strip')!.classList.contains('is-zoomed')).toBe(zoomed);
                expect(panes.filter(candidate => !candidate.hidden)).toHaveLength(zoomed ? 1 : 2);
                expect(pane.hidden).toBe(false);
                expect(editor.textContent).toBe(content);
            }
        }
    });
});
