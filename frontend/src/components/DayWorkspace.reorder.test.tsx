// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {EditorView} from '@codemirror/view';
import {undo} from '@codemirror/commands';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {appAPI, DayData, JournalFile} from '../api';
import {DayWorkspace, WorkspaceSaveState} from './DayWorkspace';

const day = {
    date: '2026-09-29',
    todo: {path: '/journal/Todo/2026-09-29.jmtodo.md', name: '2026-09-29.jmtodo.md', content: '[2026-09-29] Todo', exists: true, streamIndex: 0},
    doing: [1, 2, 3].map(streamIndex => ({
        path: `/journal/Doing/2026-09-29${streamIndex === 1 ? '' : `_${streamIndex}`}.jm.md`,
        name: `2026-09-29${streamIndex === 1 ? '' : `_${streamIndex}`}.jm.md`,
        content: `Stream ${streamIndex}`,
        exists: true,
        streamIndex,
    })),
} as DayData;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

describe('Doing content shuffle', () => {
    let host: HTMLDivElement;
    let root: Root;
    let disk: JournalFile[];
    let onError = vi.fn<(message: string) => void>();
    let onSaveStateChange = vi.fn<(state: WorkspaceSaveState) => void>();
    let saveRequest: number;
    let disabled: boolean;
    let transfer: {types: string[]; effectAllowed: string; dropEffect: string; setData: ReturnType<typeof vi.fn>};

    beforeEach(() => {
        (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
        globalThis.ResizeObserver = class {observe() {} unobserve() {} disconnect() {}};
        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = () => new DOMRect();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        disk = day.doing.map(file => ({...file}));
        onError = vi.fn();
        onSaveStateChange = vi.fn();
        saveRequest = 0;
        disabled = false;
        transfer = {types: ['application/x-journalist-doing'], effectAllowed: '', dropEffect: '', setData: vi.fn()};
        vi.spyOn(appAPI, 'readJournalFiles').mockImplementation(async () => [day.todo, ...disk]);
        vi.spyOn(appAPI, 'moveDoingContents').mockImplementation(async (_date, from, to) => {
            const contents = disk.map(file => file.content);
            contents.splice(to - 1, 0, contents.splice(from - 1, 1)[0]);
            disk = disk.map((file, i) => ({...file, content: contents[i]}));
            return disk;
        });
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        vi.restoreAllMocks();
    });

    const render = () => act(async () => root.render(
        <DayWorkspace day={day} debugMode={false} saveRequest={saveRequest} discardRequest={0} newDoingRequest={0}
            workspaceActionRequest={{action: {type: 'focus-todo'}, revision: 0}}
            interactionDisabled={disabled} onError={onError} onSaveStateChange={onSaveStateChange} onSaveComplete={vi.fn()}/>,
    ));
    const bars = () => [...host.querySelectorAll<HTMLElement>('.doing-pane .file-bar')];
    const editors = () => [...host.querySelectorAll<HTMLElement>('.cm-editor')].map(el => EditorView.findFromDOM(el)!);
    const contents = () => editors().map(editor => editor.state.doc.toString());
    const drag = async (element: HTMLElement, type: string, clientX = 0) => {
        const event = new MouseEvent(type, {bubbles: true, cancelable: true, clientX});
        Object.defineProperty(event, 'dataTransfer', {value: transfer});
        // jsdom has no layout: make each header's midpoint 50px.
        vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 38));
        await act(async () => {element.dispatchEvent(event);});
        return event;
    };

    it.each([
        [2, 0, 10, ['Stream 3', 'Stream 1', 'Stream 2'], 3, 1],
        [2, 0, 90, ['Stream 1', 'Stream 3', 'Stream 2'], 3, 2],
        [0, 2, 90, ['Stream 2', 'Stream 3', 'Stream 1'], 1, 3],
    ] as const)('inserts content without reordering headers (%i to %i)', async (source, target, x, expected, from, to) => {
        await render();
        const names = bars().map(bar => bar.textContent);
        await drag(bars()[source], 'dragstart');
        await drag(bars()[target], 'dragover', x);
        expect(host.querySelector('.drop-before, .drop-after')).not.toBeNull();
        await drag(bars()[target], 'drop', x);
        expect(appAPI.moveDoingContents).toHaveBeenCalledWith(day.date, from, to, day.doing);
        expect(contents()).toEqual([day.todo.content, ...expected]);
        expect(bars().map(bar => bar.textContent)).toEqual(names);
        expect(host.querySelector('.drop-before, .drop-after')).toBeNull();
        expect(onSaveStateChange).toHaveBeenLastCalledWith('saved');
    });

    it('does nothing for a drop beside itself, a cancelled drag, or an external drag', async () => {
        await render();
        await drag(bars()[1], 'drop', 10);
        await drag(bars()[1], 'dragstart');
        await drag(bars()[1], 'drop', 90);
        await drag(bars()[2], 'dragstart');
        await drag(bars()[0], 'dragover', 10);
        await drag(bars()[2], 'dragend');
        await drag(bars()[0], 'drop', 10);
        expect(appAPI.moveDoingContents).not.toHaveBeenCalled();
        expect(contents()).toEqual([day.todo.content, ...day.doing.map(file => file.content)]);
        expect(host.querySelector('.drop-before')).toBeNull();
    });

    it('preserves unsaved Doing edits and refuses to start a shuffle', async () => {
        await render();
        await act(async () => {editors()[1].dispatch({changes: {from: 0, insert: 'Unsaved '}});});
        const start = await drag(bars()[2], 'dragstart');
        expect(start.defaultPrevented).toBe(true);
        await drag(bars()[0], 'drop', 10);
        expect(appAPI.moveDoingContents).not.toHaveBeenCalled();
        expect(contents()[1]).toBe('Unsaved Stream 1');
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('Save or resolve'));
    });

    it('allows dirty Todo and keeps its editor and unsaved contents', async () => {
        await render();
        const todo = editors()[0];
        await act(async () => {todo.dispatch({changes: {from: todo.state.doc.length, insert: ' unsaved'}});});
        await drag(bars()[2], 'dragstart');
        await drag(bars()[0], 'drop', 10);
        expect(editors()[0]).toBe(todo);
        expect(contents()[0]).toBe(`${day.todo.content} unsaved`);
        expect(onSaveStateChange).toHaveBeenLastCalledWith('dirty');
    });

    it('blocks interaction and keeps close state saving until the move finishes, ignoring late polls', async () => {
        const poll = deferred<JournalFile[]>();
        vi.mocked(appAPI.readJournalFiles).mockReturnValueOnce(poll.promise);
        const move = deferred<JournalFile[]>();
        vi.mocked(appAPI.moveDoingContents).mockReturnValueOnce(move.promise);
        await render();
        await drag(bars()[2], 'dragstart');
        await drag(bars()[0], 'drop', 10);
        expect(host.querySelector('main')!.hasAttribute('inert')).toBe(true);
        expect(onSaveStateChange).toHaveBeenLastCalledWith('saving');
        saveRequest++;
        await render();
        expect(onSaveStateChange).toHaveBeenLastCalledWith('saving');
        await act(async () => {poll.resolve(day.doing.map(file => ({...file, content: 'stale poll'})));});
        expect(contents().slice(1)).toEqual(['Stream 1', 'Stream 2', 'Stream 3']);
        disk = day.doing.map((file, i) => ({...file, content: ['Stream 3', 'Stream 1', 'Stream 2'][i]}));
        await act(async () => {move.resolve(disk);});
        expect(contents().slice(1)).toEqual(['Stream 3', 'Stream 1', 'Stream 2']);
        expect(host.querySelector('main')!.hasAttribute('inert')).toBe(false);
        expect(onSaveStateChange).toHaveBeenLastCalledWith('saved');
    });

    it('leaves editors intact on lock failure and allows retry', async () => {
        vi.mocked(appAPI.moveDoingContents).mockRejectedValueOnce(new Error('file lock unavailable'));
        await render();
        const before = editors();
        await drag(bars()[2], 'dragstart');
        await drag(bars()[0], 'drop', 10);
        expect(editors()).toEqual(before);
        expect(contents()).toEqual([day.todo.content, 'Stream 1', 'Stream 2', 'Stream 3']);
        expect(onError).toHaveBeenCalledWith('file lock unavailable');
        expect(host.querySelector('main')!.hasAttribute('inert')).toBe(false);
        await drag(bars()[2], 'dragstart');
        await drag(bars()[0], 'drop', 10);
        expect(contents().slice(1)).toEqual(['Stream 3', 'Stream 1', 'Stream 2']);
    });

    it('clears old undo histories after a successful shuffle', async () => {
        await render();
        await act(async () => {editors()[1].dispatch({changes: {from: 0, insert: 'Saved edit '}});});
        vi.spyOn(appAPI, 'saveFile').mockImplementation(async (path, content) => {
            disk = disk.map(file => file.path === path ? {...file, content} : file);
            return {saved: true, conflict: false, content, exists: true};
        });
        saveRequest++;
        await render();
        await drag(bars()[2], 'dragstart');
        await drag(bars()[0], 'drop', 10);
        await act(async () => {expect(undo(editors()[2])).toBe(false);});
        expect(contents().slice(1)).toEqual(['Stream 3', 'Saved edit Stream 1', 'Stream 2']);
    });

    it('refuses dragging while a modal has disabled interaction', async () => {
        disabled = true;
        await render();
        expect(bars().every(bar => !bar.draggable)).toBe(true);
        expect((await drag(bars()[2], 'dragstart')).defaultPrevented).toBe(true);
        await drag(bars()[0], 'drop');
        expect(appAPI.moveDoingContents).not.toHaveBeenCalled();
    });
});
