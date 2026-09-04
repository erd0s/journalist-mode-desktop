// @vitest-environment jsdom

import {act} from 'react-dom/test-utils';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DayData, DaySummary} from '../api';
import {Welcome} from './Welcome';
import '../App.css';

const TODAY = '2026-09-04';
const PREVIOUS = '2026-09-02';

const daysWithToday = [
    {date: TODAY, doingCount: 2, hasTodo: true},
    {date: PREVIOUS, doingCount: 1, hasTodo: false},
] as DaySummary[];

const daysWithoutToday = [
    {date: PREVIOUS, doingCount: 1, hasTodo: false},
] as DaySummary[];

type RenderProps = {
    days?: DaySummary[];
    embedded?: boolean;
    onCreateToday?: () => Promise<DayData>;
    onOpenDay?: (date: string) => Promise<void>;
};

function welcomeShellDeclarations(property: string): string[] {
    const values: string[] = [];
    for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
            if (rule instanceof CSSStyleRule && rule.selectorText.split(',').some(s => s.trim() === '.welcome-shell')) {
                const value = rule.style.getPropertyValue(property);
                if (value) {
                    values.push(value);
                }
            }
        }
    }
    return values;
}

describe('Welcome', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean})
            .IS_REACT_ACT_ENVIRONMENT = true;
        vi.setSystemTime(new Date(2026, 8, 4, 9, 30));
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        vi.useRealTimers();
    });

    async function render(props: RenderProps = {}) {
        const onCreateToday = props.onCreateToday ?? vi.fn(async () => ({} as DayData));
        const onOpenDay = props.onOpenDay ?? vi.fn(async () => undefined);
        await act(async () => {
            root.render(
                <Welcome
                    days={props.days ?? daysWithToday}
                    embedded={props.embedded}
                    onCreateToday={onCreateToday}
                    onOpenDay={onOpenDay}
                />,
            );
        });
        return {onCreateToday, onOpenDay};
    }

    describe('window chrome', () => {
        it('renders a draggable title band in the standalone window', async () => {
            await render();
            const region = host.querySelector<HTMLElement>('.welcome-shell > .window-drag-region');
            expect(region).not.toBeNull();
            expect(region!.getAttribute('aria-hidden')).toBe('true');
            expect(getComputedStyle(region!).getPropertyValue('--wails-draggable')).toBe('drag');
        });

        it('renders no title band inside the embedded day picker', async () => {
            await render({embedded: true});
            expect(host.querySelector('.window-drag-region')).toBeNull();
        });

        it('does not let static welcome text be selected', async () => {
            await render();
            const shell = host.querySelector<HTMLElement>('.welcome-shell')!;
            // Guard: App.css must actually be applied for the next assertion to mean anything.
            expect(getComputedStyle(shell).display).toBe('flex');
            expect(getComputedStyle(shell).userSelect).toBe('none');
            // jsdom's computed style drops the prefixed form, but WKWebView is
            // what applies it, so check the declaration itself.
            expect(welcomeShellDeclarations('-webkit-user-select')).toContain('none');
        });

        it('keeps the embedded day picker text unselectable too', async () => {
            await render({embedded: true});
            const shell = host.querySelector<HTMLElement>('.welcome-shell.welcome-embedded')!;
            expect(getComputedStyle(shell).userSelect).toBe('none');
        });
    });

    describe('primary action', () => {
        it('opens today from the button when today exists', async () => {
            const {onOpenDay, onCreateToday} = await render();
            const button = host.querySelector<HTMLButtonElement>('.today-action')!;
            expect(button.textContent).toContain('Open today');
            await act(async () => button.click());
            expect(onOpenDay).toHaveBeenCalledExactlyOnceWith(TODAY);
            expect(onCreateToday).not.toHaveBeenCalled();
        });

        it('starts today from the button when today does not exist', async () => {
            const {onOpenDay, onCreateToday} = await render({days: daysWithoutToday});
            const button = host.querySelector<HTMLButtonElement>('.today-action')!;
            expect(button.textContent).toContain('Start today');
            await act(async () => button.click());
            expect(onCreateToday).toHaveBeenCalledOnce();
            expect(onOpenDay).not.toHaveBeenCalled();
        });

        it('opens a previous day from its row', async () => {
            const {onOpenDay} = await render();
            const row = host.querySelector<HTMLButtonElement>('.day-row')!;
            await act(async () => row.click());
            expect(onOpenDay).toHaveBeenCalledExactlyOnceWith(PREVIOUS);
        });

        it('ignores a second click while the first action is still pending', async () => {
            let finish!: () => void;
            const onOpenDay = vi.fn(() => new Promise<void>(resolve => {
                finish = resolve;
            }));
            await render({onOpenDay});
            const button = host.querySelector<HTMLButtonElement>('.today-action')!;
            await act(async () => button.click());
            await act(async () => button.click());
            expect(onOpenDay).toHaveBeenCalledTimes(1);
            finish();
        });
    });

    describe('Return key', () => {
        async function pressReturn(target: EventTarget = document.body, init: KeyboardEventInit = {}) {
            const event = new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true, ...init});
            await act(async () => {
                target.dispatchEvent(event);
            });
            return event;
        }

        it('opens today when today exists', async () => {
            const {onOpenDay, onCreateToday} = await render();
            await pressReturn();
            expect(onOpenDay).toHaveBeenCalledExactlyOnceWith(TODAY);
            expect(onCreateToday).not.toHaveBeenCalled();
        });

        it('starts today when today does not exist', async () => {
            const {onOpenDay, onCreateToday} = await render({days: daysWithoutToday});
            await pressReturn();
            expect(onCreateToday).toHaveBeenCalledOnce();
            expect(onOpenDay).not.toHaveBeenCalled();
        });

        it('claims the keystroke when the today button itself has focus', async () => {
            // The embedded picker auto-focuses the button, and a focused button
            // also fires click on Return, so the handler must cancel the default.
            const {onOpenDay} = await render({embedded: true});
            const button = host.querySelector<HTMLButtonElement>('.today-action')!;
            button.focus();
            const event = await pressReturn(button);
            expect(event.defaultPrevented).toBe(true);
            expect(onOpenDay).toHaveBeenCalledExactlyOnceWith(TODAY);
        });

        it('leaves Return to a focused previous-day row', async () => {
            const {onOpenDay, onCreateToday} = await render();
            const row = host.querySelector<HTMLButtonElement>('.day-row')!;
            row.focus();
            const event = await pressReturn(row);
            expect(event.defaultPrevented).toBe(false);
            // jsdom does not activate buttons on Return; a browser would, so
            // replay that default and check the row, not today, is what opens.
            await act(async () => row.click());
            expect(onOpenDay).toHaveBeenCalledExactlyOnceWith(PREVIOUS);
            expect(onCreateToday).not.toHaveBeenCalled();
        });

        it('claims auto-repeated Return on the focused today button without re-running', async () => {
            const {onOpenDay} = await render({embedded: true});
            const button = host.querySelector<HTMLButtonElement>('.today-action')!;
            button.focus();
            const event = await pressReturn(button, {repeat: true});
            expect(event.defaultPrevented).toBe(true);
            expect(onOpenDay).not.toHaveBeenCalled();
        });

        it('recovers after a failed action without leaking the rejection', async () => {
            const onCreateToday = vi.fn()
                .mockRejectedValueOnce(new Error('journal folder is read-only'))
                .mockResolvedValue({} as DayData);
            await render({days: daysWithoutToday, onCreateToday});
            await pressReturn();
            await pressReturn();
            expect(onCreateToday).toHaveBeenCalledTimes(2);
        });

        it('leaves Return alone inside an editor behind the day picker', async () => {
            const {onOpenDay} = await render({embedded: true});
            const editor = document.createElement('div');
            editor.setAttribute('contenteditable', 'true');
            document.body.appendChild(editor);
            try {
                const event = await pressReturn(editor);
                expect(event.defaultPrevented).toBe(false);
            } finally {
                editor.remove();
            }
            expect(onOpenDay).not.toHaveBeenCalled();
        });

        it('ignores modified and auto-repeated Return presses', async () => {
            const {onOpenDay} = await render();
            await pressReturn(document.body, {shiftKey: true});
            await pressReturn(document.body, {metaKey: true});
            await pressReturn(document.body, {ctrlKey: true});
            await pressReturn(document.body, {altKey: true});
            await pressReturn(document.body, {repeat: true});
            expect(onOpenDay).not.toHaveBeenCalled();
        });

        it('runs the action once while it is still pending', async () => {
            let finish!: () => void;
            const onOpenDay = vi.fn(() => new Promise<void>(resolve => {
                finish = resolve;
            }));
            await render({onOpenDay});
            await pressReturn();
            await pressReturn();
            expect(onOpenDay).toHaveBeenCalledTimes(1);

            finish();
            await act(async () => {});
            await pressReturn();
            expect(onOpenDay).toHaveBeenCalledTimes(2);
        });
    });
});
