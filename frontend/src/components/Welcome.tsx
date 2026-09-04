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

    return (
        <main className={`welcome-shell${embedded ? ' welcome-embedded' : ''}`}>
            {!embedded && <div className="window-drag-region" aria-hidden="true"/>}
            <section className="welcome-content">
                <button
                    className="today-action"
                    autoFocus={embedded}
                    onClick={() => todaySummary ? onOpenDay(today) : onCreateToday()}
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
