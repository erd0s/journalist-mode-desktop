// @vitest-environment jsdom
import {act} from 'react';
import {EditorView} from '@codemirror/view';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {appAPI, DayData} from '../api';
import {WorkspaceActionRequest} from '../lib/workspace';
import {DayWorkspace} from './DayWorkspace';

const streams = [1, 2, 4, 7, 10];
const suffix = (streamIndex: number) => streamIndex === 1 ? '' : `_${streamIndex}`;
const day = {
    date: '2026-09-11',
    todo: {path: '/journal/Todo/2026-09-11.jmtodo.md', name: '2026-09-11.jmtodo.md', content: '[2026-09-11] Todo', exists: true, streamIndex: 0},
    doing: streams.map(streamIndex => ({
        path: `/journal/Doing/2026-09-11${suffix(streamIndex)}.jm.md`,
        name: `2026-09-11${suffix(streamIndex)}.jm.md`,
        content: `(2026-09-11 09:00) Stream ${streamIndex}`,
        exists: true,
        streamIndex,
    })),
} as DayData;

describe('focus-doing-zoomed', () => {
    let host: HTMLDivElement;
    let root: Root;
    let request: WorkspaceActionRequest;

    beforeEach(() => {
        (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
        globalThis.ResizeObserver = class {observe() {} unobserve() {} disconnect() {}};
        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = () => new DOMRect();
        vi.spyOn(appAPI, 'readJournalFiles').mockResolvedValue([day.todo, ...day.doing]);
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        request = {action: {type: 'focus-todo'}, revision: 0};
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        vi.restoreAllMocks();
    });

    const render = () => act(async () => root.render(
        <DayWorkspace day={day} debugMode={false} saveRequest={0} discardRequest={0} newDoingRequest={0}
            workspaceActionRequest={request} interactionDisabled={false} onError={vi.fn()}
            onSaveStateChange={vi.fn()} onSaveComplete={vi.fn()} />,
    ));
    const dispatch = async (action: WorkspaceActionRequest['action']) => {
        request = {action, revision: request.revision + 1};
        await render();
    };
    const visiblePanes = () => [...host.querySelectorAll<HTMLElement>('.journal-pane')]
        .filter(pane => !pane.hidden).map(pane => pane.querySelector('.filename')!.textContent);
    const zoomed = () => host.querySelector('.pane-strip')!.classList.contains('is-zoomed');
    const editors = () => [...host.querySelectorAll<HTMLElement>('.cm-editor')].map(el => EditorView.findFromDOM(el)!);

    it('zooms the matching stream from an unzoomed layout and from another zoomed pane, and stays put on repeats', async () => {
        await render();
        expect(zoomed()).toBe(false);
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 7});
        expect(zoomed()).toBe(true);
        expect(visiblePanes()).toEqual(['2026-09-11_7.jm.md']);
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 7});
        expect(visiblePanes()).toEqual(['2026-09-11_7.jm.md']);
        await dispatch({type: 'toggle-zoom'});
        expect(zoomed()).toBe(false);
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 4});
        expect(visiblePanes()).toEqual(['2026-09-11_4.jm.md']);
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 10});
        expect(visiblePanes()).toEqual(['2026-09-11_10.jm.md']);
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 1});
        expect(visiblePanes()).toEqual(['2026-09-11.jm.md']);
    });

    it('focuses the target editor and leaves the workspace unchanged for a missing stream', async () => {
        await render();
        const stream7 = editors()[4];
        await act(async () => { stream7.dispatch({selection: {anchor: 3, head: 8}}); });
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 7});
        await act(async () => { await new Promise(resolve => window.requestAnimationFrame(() => resolve(undefined))); });
        expect(document.activeElement).toBe(stream7.contentDOM);
        expect(stream7.state.selection.main).toMatchObject({anchor: 3, head: 8});
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 5});
        expect(zoomed()).toBe(true);
        expect(visiblePanes()).toEqual(['2026-09-11_7.jm.md']);
        expect(editors().map(view => view.state.doc.toString()))
            .toEqual([day.todo.content, ...day.doing.map(file => file.content)]);
    });
});
