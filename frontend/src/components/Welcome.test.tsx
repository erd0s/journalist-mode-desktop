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
    });
});
