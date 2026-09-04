import {useEffect, useRef} from 'react';
import {DayData, DaySummary} from '../api';
import {Icon} from './Icons';

type WelcomeProps = {
    days: DaySummary[];
    onCreateToday: () => Promise<DayData>;
    onOpenDay: (date: string) => Promise<void>;
    embedded?: boolean;
};

export function Welcome({days, onCreateToday, onOpenDay, embedded = false}: WelcomeProps) {
    const today = localISODate();
    const todaySummary = days.find(day => day.date === today);
    const previousDays = days.filter(day => day.date !== today);
    const todayButton = useRef<HTMLButtonElement>(null);
    const primaryActionPending = useRef(false);

    const runPrimaryAction = async () => {
        if (primaryActionPending.current) {
            return;
        }
        primaryActionPending.current = true;
        try {
            if (todaySummary) {
                await onOpenDay(today);
            } else {
                await onCreateToday();
            }
        } catch {
            // The callbacks report their own failures in the app's error banner,
            // so a rejection here carries nothing new to surface.
        } finally {
            primaryActionPending.current = false;
        }
    };

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
                return;
            }
            if (targetsAnotherControl(event.target, todayButton.current)) {
                return;
            }
            // The embedded picker auto-focuses the today button, and a focused
            // button fires its own click on Return, including on every key
            // repeat. Cancelling the default keeps the action to one run per
            // press.
            event.preventDefault();
            if (event.repeat) {
                return;
            }
            void runPrimaryAction();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    });

    return (
        <main className={`welcome-shell${embedded ? ' welcome-embedded' : ''}`}>
            {!embedded && <div className="window-drag-region" aria-hidden="true"/>}
            <section className="welcome-content">
                <button
                    ref={todayButton}
                    className="today-action"
                    autoFocus={embedded}
                    onClick={runPrimaryAction}
                >
                    <span className="today-icon"><Icon name="calendar"/></span>
                    <span>
                        <strong>{todaySummary ? 'Open today' : 'Start today'}</strong>
                        <small>{formatLongDate(today)}</small>
                    </span>
                    <Icon name="chevron-right"/>
                </button>

                <section className="previous-days">
                    <div className="section-heading">
                        <h2>Previous days</h2>
                        <span>{previousDays.length}</span>
                    </div>
                    <div className="day-list">
                        {previousDays.length === 0 ? (
                            <div className="empty-history">
                                No previous journal days yet.
                            </div>
                        ) : previousDays.map(day => (
                            <button className="day-row" key={day.date} onClick={() => onOpenDay(day.date)}>
                                <span className="day-date">
                                    <strong>{formatShortDate(day.date)}</strong>
                                    <small>{day.date}</small>
                                </span>
                                <span className="day-meta">
                                    <span>{day.doingCount} {pluralise(day.doingCount, 'stream')}</span>
                                    {day.hasTodo && <span className="todo-dot" title="Todo file present"/>}
                                </span>
                                <Icon name="chevron-right" size={16}/>
                            </button>
                        ))}
                    </div>
                </section>
            </section>
        </main>
    );
}

const CONTROL_SELECTOR = 'button, input, textarea, select, a[href], [contenteditable]:not([contenteditable="false"])';

// Return belongs to whichever control has focus: a previous-day row, the
// error banner's dismiss button, or an editor still focused behind the day
// picker. Only the today button, or no control at all, hands it to the
// primary action.
function targetsAnotherControl(target: EventTarget | null, todayButton: HTMLButtonElement | null): boolean {
    if (!(target instanceof Element)) {
        return false;
    }
    const control = target.closest(CONTROL_SELECTOR);
    return control !== null && control !== todayButton;
}

function localISODate(): string {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseLocalDate(date: string): Date {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(year, month - 1, day);
}

function formatLongDate(date: string): string {
    return new Intl.DateTimeFormat('en-GB', {weekday: 'long', day: 'numeric', month: 'long'}).format(parseLocalDate(date));
}

function formatShortDate(date: string): string {
    return new Intl.DateTimeFormat('en-GB', {weekday: 'short', day: 'numeric', month: 'short'}).format(parseLocalDate(date));
}

function pluralise(count: number, noun: string): string {
    return count === 1 ? noun : `${noun}s`;
}
