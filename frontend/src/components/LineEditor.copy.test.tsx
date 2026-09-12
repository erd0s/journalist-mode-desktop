// @vitest-environment jsdom
import {EditorView} from '@codemirror/view';
import {Clipboard} from '@wailsio/runtime';
import {act} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {appAPI, DayData} from '../api';
import {DayWorkspace} from './DayWorkspace';
import {WorkspaceActionRequest} from '../lib/workspace';

vi.mock('@wailsio/runtime', async importOriginal => {
    const runtime = await importOriginal<typeof import('@wailsio/runtime')>();
    return {...runtime, Clipboard: {...runtime.Clipboard, SetText: vi.fn()}};
});

const todo = '[2026-09-08] Copy the entire task\n[2026-09-08] Another task';
const day = {
    date: '2026-09-08',
    todo: {path: '/test/Todo/day.md', name: 'day.md', content: todo, exists: true, streamIndex: 0},
    doing: [1, 2].map(streamIndex => ({path: `/test/Doing/${streamIndex}.md`, name: `${streamIndex}.md`,
        content: `(2026-09-08 10:00) Stream ${streamIndex}`, exists: true, streamIndex})),
} as DayData;
let host: HTMLDivElement;
let root: Root;
let onError = vi.fn<(message: string) => void>();
let editors: EditorView[];
let request: WorkspaceActionRequest;

beforeEach(() => {
    (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    vi.spyOn(appAPI, 'readJournalFiles').mockResolvedValue([day.todo, ...day.doing]);
    Object.defineProperty(navigator, 'clipboard', {configurable: true, get: () => undefined});
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    onError = vi.fn();
    request = {action: {type: 'focus-todo'}, revision: 0};
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window._wails?.environment;
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'clipboard');
    Reflect.deleteProperty(document, 'execCommand');
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

async function render() {
    await act(async () => root.render(
        <DayWorkspace day={day} debugMode={false} saveRequest={0} discardRequest={0} newDoingRequest={0}
            workspaceActionRequest={request} interactionDisabled={false} onError={onError}
            onSaveStateChange={() => {}} onSaveComplete={() => {}} />,
    ));
    editors = [...host.querySelectorAll<HTMLElement>('.cm-editor')].map(el => EditorView.findFromDOM(el)!);
}
async function settle() {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
}
async function copyTask() {
    await act(async () => {
        editors[0].focus();
        // Copy the task at the selection head, including the unselected text.
        editors[0].dispatch({selection: {anchor: 13, head: 17}});
        const mac = /Mac/.test(navigator.platform);
        const event = new KeyboardEvent('keydown', {key: 'C', code: 'KeyC', keyCode: 67,
            metaKey: mac, ctrlKey: !mac, shiftKey: true, bubbles: true, cancelable: true});
        editors[0].contentDOM.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });
}
async function focusDoing(streamIndex: number) {
    request = {action: {type: 'focus-doing', streamIndex}, revision: request.revision + 1};
    await render();
    await settle();
    expect(document.activeElement).toBe(editors[streamIndex].contentDOM);
}
function unchanged() {
    expect(editors.map(view => view.state.doc.toString())).toEqual([todo, ...day.doing.map(file => file.content)]);
    expect(editors[0].state.selection.main).toMatchObject({anchor: 13, head: 17});
}

it.each([true, false])('never reclaims focus when a delayed copy completes (native: %s)', async native => {
    if (native) window._wails = {...window._wails, environment: {OS: 'darwin'}};
    let complete!: () => void;
    const copy = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    if (native) vi.spyOn(Clipboard, 'SetText').mockImplementation(copy);
    else vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({writeText: copy} as unknown as typeof navigator.clipboard);
    await render();
    await copyTask();
    expect(copy).toHaveBeenCalledWith('Copy the entire task');
    expect(document.activeElement).toBe(editors[0].contentDOM);
    await focusDoing(1);
    await act(async () => complete());
    await settle();
    expect(document.activeElement).toBe(editors[1].contentDOM);
    await focusDoing(2);
    await act(async () => editors[1].contentDOM.focus());
    await settle();
    expect(document.activeElement).toBe(editors[1].contentDOM);
    unchanged();
    expect(onError).not.toHaveBeenCalled();
});

it.each(['unavailable', 'denied'])('preserves focus and selection when browser clipboard access is %s', async mode => {
    const setData = vi.fn();
    if (mode === 'denied') {
        vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
            writeText: vi.fn().mockRejectedValue(new Error('Denied')),
        } as unknown as typeof navigator.clipboard);
    }
    Object.defineProperty(document, 'execCommand', {configurable: true, value: vi.fn(() => {
        // The browser dispatches at the active editor. Our data must win over
        // CodeMirror's ordinary selected-text copy without selecting a textarea.
        const event = new Event('copy', {bubbles: true, cancelable: true});
        Object.defineProperty(event, 'clipboardData', {value: {setData, clearData: vi.fn()}});
        document.activeElement!.dispatchEvent(event);
        return event.defaultPrevented;
    })});
    const select = vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(function (this: HTMLTextAreaElement) { this.focus(); });
    await render();
    await copyTask();
    expect(setData).toHaveBeenCalledExactlyOnceWith('text/plain', 'Copy the entire task');
    expect(select).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editors[0].contentDOM);
    await focusDoing(1);
    await focusDoing(2);
    unchanged();
    setData.mockClear();
    await act(async () => {
        editors[0].focus();
        document.execCommand('copy');
    });
    expect(setData).toHaveBeenCalledExactlyOnceWith('text/plain', todo.slice(13, 17));
    expect(onError).not.toHaveBeenCalled();
});

it('reports a rejected native copy without changing documents or trapping focus', async () => {
    window._wails = {...window._wails, environment: {OS: 'darwin'}};
    vi.spyOn(Clipboard, 'SetText').mockRejectedValue(new Error('Clipboard unavailable'));
    await render();
    await copyTask();
    expect(onError).toHaveBeenCalledExactlyOnceWith('Could not copy this Todo item. Please try again.');
    await focusDoing(1);
    unchanged();
});

it('removes a failed browser copy override so ordinary Copy can receive its event', async () => {
    Object.defineProperty(document, 'execCommand', {configurable: true, value: vi.fn(() => { throw new Error('Copy unavailable'); })});
    await render();
    await copyTask();
    expect(onError).toHaveBeenCalledOnce();
    const setData = vi.fn();
    const event = new Event('copy', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: {setData}});
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
    await focusDoing(1);
    unchanged();
});
