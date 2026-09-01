// @vitest-environment jsdom

import {act} from 'react-dom/test-utils';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {appAPI, DayData} from '../api';
import {DayWorkspace} from './DayWorkspace';

class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}

describe('DayWorkspace debug checkpoint', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean})
            .IS_REACT_ACT_ENVIRONMENT = true;
        globalThis.ResizeObserver = ResizeObserverStub;
        window.requestAnimationFrame = callback => window.setTimeout(
            () => callback(performance.now()),
            0,
        );
        window.cancelAnimationFrame = handle => window.clearTimeout(handle);
        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = () => new DOMRect();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        vi.restoreAllMocks();
    });

    it('shows the control and flushes a complete workspace snapshot', async () => {
        const day = {
            date: '2026-09-01',
            todo: {
                path: '/journal/Todo/2026-09-01.jmtodo.md',
                name: '2026-09-01.jmtodo.md',
                content: '[2026-09-01] todo',
                exists: true,
                streamIndex: 0,
            },
            doing: [{
                path: '/journal/Doing/2026-09-01.jm.md',
                name: '2026-09-01.jm.md',
                content: '(2026-09-01 09:00) doing',
                exists: true,
                streamIndex: 1,
            }],
        } as DayData;
        vi.spyOn(appAPI, 'readJournalFiles').mockResolvedValue([day.todo, ...day.doing]);
        const record = vi.spyOn(appAPI, 'recordDebugEvents').mockResolvedValue();

        await act(async () => {
            root.render(
                <DayWorkspace
                    day={day}
                    debugMode
                    saveRequest={0}
                    discardRequest={0}
                    newDoingRequest={0}
                    workspaceActionRequest={{action: {type: 'focus-todo'}, revision: 0}}
                    interactionDisabled={false}
                    onError={vi.fn()}
                    onSaveStateChange={vi.fn()}
                    onSaveComplete={vi.fn()}
                />,
            );
        });

        const checkpoint = host.querySelector<HTMLButtonElement>(
            '[aria-label="Mark debug checkpoint"]',
        );
        expect(checkpoint).not.toBeNull();
        await act(async () => checkpoint!.click());
        await vi.waitFor(() => expect(record).toHaveBeenCalled());

        const events = record.mock.calls.flatMap(call => call[0]);
        const marked = events.find(event => event.category === 'checkpoint');
        expect(marked?.action).toBe('user_checkpoint');
        expect(marked?.files).toHaveLength(2);
        expect(marked?.files.map(file => file.content)).toEqual([
            '[2026-09-01] todo',
            '(2026-09-01 09:00) doing',
        ]);
    });
});
