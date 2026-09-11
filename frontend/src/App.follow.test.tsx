// @vitest-environment jsdom
import {act, useEffect} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import App from './App';

const harness = vi.hoisted(() => ({
    events: new Map<string, (event: {data: unknown}) => void>(),
    actions: [] as string[],
    settings: {storageRoot: '/journal', editorFont: 'system', debugMode: false, followDesktop: true},
    status: {available: true, reason: ''},
    openDayGate: null as null | (() => void),
    setState: (_state: string) => {},
}));
vi.mock('@wailsio/runtime', () => ({
    Events: {On: (name: string, handler: (event: {data: unknown}) => void) => {
        harness.events.set(name, handler);
        return () => harness.events.delete(name);
    }},
    Window: {SetTitle: vi.fn(async () => undefined)},
}));
vi.mock('./api', () => ({appAPI: {
    isNative: () => true,
    isSettingsWindow: () => false,
    getSettings: async () => harness.settings,
    getFollowDesktopStatus: async () => harness.status,
    listDays: async () => [],
    getLaunchDate: async () => '2026-09-11',
    openDay: async () => {
        if (harness.openDayGate === null) return {date: '2026-09-11', todo: {}, doing: []};
        await new Promise<void>(resolve => { harness.openDayGate = resolve; });
        return {date: '2026-09-11', todo: {}, doing: []};
    },
    cancelQuit: vi.fn(async () => undefined),
    closeWindow: vi.fn(async () => undefined),
}}));
vi.mock('./components/DayWorkspace', () => ({DayWorkspace: (props: any) => {
    harness.setState = props.onSaveStateChange;
    useEffect(() => props.onSaveStateChange('saved'), []);
    useEffect(() => {
        if (props.workspaceActionRequest.revision > 0) {
            harness.actions.push(JSON.stringify(props.workspaceActionRequest.action));
        }
    }, [props.workspaceActionRequest.revision]);
    return <button disabled={props.interactionDisabled}>Journal editor</button>;
}}));

describe('desktop follow routing', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(async () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        harness.events.clear();
        harness.actions = [];
        harness.settings = {...harness.settings, followDesktop: true};
        harness.status = {available: true, reason: ''};
        harness.openDayGate = null;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => root.render(<App/>));
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
    });
    const event = (name: string, data: unknown) => act(async () => harness.events.get(name)!({data}));
    const zoom = (streamIndex: number) => JSON.stringify({type: 'focus-doing-zoomed', streamIndex});
    const click = (text: string) => act(async () => {
        [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!.click();
    });

    it('applies fresh events, drops stale sequences, and stops when the setting turns off', async () => {
        await event('desktop:changed', {desktop: 7, sequence: 1});
        await event('desktop:changed', {desktop: 4, sequence: 1});
        await event('desktop:changed', {desktop: 2, sequence: 3});
        await event('desktop:changed', {desktop: 9, sequence: 2});
        expect(harness.actions).toEqual([zoom(7), zoom(2)]);
        await event('settings:changed', {...harness.settings, followDesktop: false});
        await event('desktop:changed', {desktop: 5, sequence: 4});
        expect(harness.actions).toEqual([zoom(7), zoom(2)]);
    });

    it('defers a change while the close prompt is open and applies the latest one after Cancel', async () => {
        await act(async () => harness.setState('dirty'));
        await event('window:close-request', undefined);
        expect(host.textContent).toContain('Save changes before closing?');
        await event('desktop:changed', {desktop: 4, sequence: 1});
        await event('desktop:changed', {desktop: 7, sequence: 2});
        expect(harness.actions).toEqual([]);
        await click('Cancel');
        expect(harness.actions).toEqual([zoom(7)]);
    });

    it('drops a deferred change when the setting turns off before the prompt closes', async () => {
        await act(async () => harness.setState('dirty'));
        await event('window:close-request', undefined);
        await event('desktop:changed', {desktop: 4, sequence: 1});
        await event('settings:changed', {...harness.settings, followDesktop: false});
        await click('Cancel');
        expect(harness.actions).toEqual([]);
    });

    it('applies a change at once while a file conflict is showing, so manual choices are never overridden later', async () => {
        await act(async () => harness.setState('conflict'));
        await event('desktop:changed', {desktop: 4, sequence: 1});
        expect(harness.actions).toEqual([zoom(4)]);
        await act(async () => harness.setState('saved'));
        expect(harness.actions).toEqual([zoom(4)]);
    });

    it('keeps a change that arrives while today\'s window is still opening', async () => {
        await act(async () => root.unmount());
        harness.openDayGate = () => {};
        root = createRoot(host);
        await act(async () => root.render(<App/>));
        expect(host.textContent).not.toContain('Journal editor');
        await event('desktop:changed', {desktop: 4, sequence: 1});
        await event('desktop:changed', {desktop: 7, sequence: 2});
        expect(harness.actions).toEqual([]);
        await act(async () => { harness.openDayGate!(); });
        expect(host.textContent).toContain('Journal editor');
        expect(harness.actions).toEqual([zoom(7)]);
    });

    it('shows why following is inactive when the setting is on but the native monitor is unavailable', async () => {
        await act(async () => root.unmount());
        harness.status = {available: false, reason: 'SkyLight does not export SLSCopyManagedDisplaySpaces'};
        root = createRoot(host);
        await act(async () => root.render(<App/>));
        expect(host.querySelector('.error-banner')?.textContent).toContain('SLSCopyManagedDisplaySpaces');
    });
});
