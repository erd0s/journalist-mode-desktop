import {useEffect, useRef, useState} from 'react';
import {EventsOn, Quit, WindowSetTitle} from '../wailsjs/runtime/runtime';
import './App.css';
import {appAPI, DayData, DaySummary, Settings} from './api';
import {DayWorkspace} from './components/DayWorkspace';
import {SettingsView} from './components/SettingsView';
import {Welcome} from './components/Welcome';
import {WorkspaceAction, WorkspaceActionRequest} from './lib/workspace';

type Screen = 'welcome' | 'settings' | 'day';

export default function App() {
    const [screen, setScreen] = useState<Screen>('welcome');
    const [settings, setSettings] = useState<Settings | null>(null);
    const [days, setDays] = useState<DaySummary[]>([]);
    const [openDay, setOpenDay] = useState<DayData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [saveRequest, setSaveRequest] = useState(0);
    const [toggleCompletedRequest, setToggleCompletedRequest] = useState(0);
    const [newDoingRequest, setNewDoingRequest] = useState(0);
    const [workspaceActionRequest, setWorkspaceActionRequest] = useState<WorkspaceActionRequest>({
        action: {type: 'focus-position', position: 0},
        revision: 0,
    });
    const [dayPickerOpen, setDayPickerOpen] = useState(false);
    const settingsReturnScreen = useRef<Screen>('welcome');

    const loadWelcome = async () => {
        const [nextSettings, nextDays] = await Promise.all([
            appAPI.getSettings(),
            appAPI.listDays(),
        ]);
        setSettings(nextSettings);
        setDays(nextDays ?? []);
    };

    const showDay = (day: DayData) => {
        setOpenDay(day);
        setScreen('day');
        setError('');
    };

    const createToday = async (closePickerWindow: boolean) => {
        try {
            const day = await appAPI.createToday();
            if (appAPI.isNative()) {
                await appAPI.openDayWindow(day.date);
                setDayPickerOpen(false);
                if (closePickerWindow) {
                    Quit();
                }
            } else {
                showDay(day);
                setDayPickerOpen(false);
            }
            return day;
        } catch (reason) {
            setError(errorMessage(reason));
            throw reason;
        }
    };

    const openExistingDay = async (date: string, closePickerWindow: boolean) => {
        try {
            if (appAPI.isNative()) {
                await appAPI.openDayWindow(date);
                setDayPickerOpen(false);
                if (closePickerWindow) {
                    Quit();
                }
                return;
            }
            showDay(await appAPI.openDay(date));
            setDayPickerOpen(false);
        } catch (reason) {
            setError(errorMessage(reason));
        }
    };

    const showDayPicker = () => {
        if (screen === 'welcome') {
            return;
        }
        setDayPickerOpen(true);
        void loadWelcome().catch(reason => setError(errorMessage(reason)));
    };

    const openSettings = () => {
        setScreen(current => {
            settingsReturnScreen.current = current === 'settings' ? 'welcome' : current;
            return 'settings';
        });
    };

    const requestWorkspaceAction = (action: WorkspaceAction) => {
        setWorkspaceActionRequest(current => ({
            action,
            revision: current.revision + 1,
        }));
    };

    useEffect(() => {
        const initialise = async () => {
            await loadWelcome();
            const launchDate = await appAPI.getLaunchDate();
            if (launchDate) {
                showDay(await appAPI.openDay(launchDate));
            }
        };

        initialise()
            .catch(reason => setError(errorMessage(reason)))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        if (!window.runtime) {
            return;
        }

        const stopSettings = EventsOn('menu:settings', () => {
            if (!dayPickerOpen) {
                openSettings();
            }
        });
        const stopOpen = EventsOn('menu:open', showDayPicker);
        const stopSave = EventsOn('menu:save', () => {
            if (screen === 'day' && !dayPickerOpen) {
                setSaveRequest(request => request + 1);
            }
        });
        const stopToggleCompleted = EventsOn('menu:toggle-completed', () => {
            if (screen === 'day' && !dayPickerOpen) {
                setToggleCompletedRequest(request => request + 1);
            }
        });
        const stopNewDoing = EventsOn('menu:new-doing', () => {
            if (screen === 'day' && !dayPickerOpen) {
                setNewDoingRequest(request => request + 1);
            }
        });
        const stopFocusPane = EventsOn('menu:focus-pane', (position: number) => {
            if (screen === 'day' && !dayPickerOpen) {
                requestWorkspaceAction({type: 'focus-position', position});
            }
        });
        const stopMoveFocus = EventsOn('menu:move-focus', (delta: -1 | 1) => {
            if (screen === 'day' && !dayPickerOpen) {
                requestWorkspaceAction({type: 'move-focus', delta});
            }
        });
        const stopTogglePaneZoom = EventsOn('menu:toggle-pane-zoom', () => {
            if (screen === 'day' && !dayPickerOpen) {
                requestWorkspaceAction({type: 'toggle-zoom'});
            }
        });
        const stopToggleTodo = EventsOn('menu:toggle-todo', () => {
            if (screen === 'day' && !dayPickerOpen) {
                requestWorkspaceAction({type: 'toggle-todo'});
            }
        });
        const stopFont = EventsOn('menu:font', (editorFont: string) => {
            setSettings(current => current ? {...current, editorFont} as Settings : current);
        });
        const stopError = EventsOn('menu:error', (message: string) => setError(message));
        return () => {
            stopSettings();
            stopOpen();
            stopSave();
            stopToggleCompleted();
            stopNewDoing();
            stopFocusPane();
            stopMoveFocus();
            stopTogglePaneZoom();
            stopToggleTodo();
            stopFont();
            stopError();
        };
    });

    useEffect(() => {
        if (!window.runtime) {
            return;
        }
        const title = screen === 'day' && openDay
            ? formatWindowTitle(openDay.date)
            : screen === 'settings' ? 'Settings — Journalist Mode' : 'Journalist Mode';
        WindowSetTitle(title);
    }, [openDay, screen]);

    useEffect(() => {
        const shortcut = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && dayPickerOpen) {
                event.preventDefault();
                setDayPickerOpen(false);
                return;
            }
            if (!(event.metaKey || event.ctrlKey) || event.altKey) {
                return;
            }
            const key = event.key.toLowerCase();
            if (dayPickerOpen) {
                if (key === 'o' || key === 'n') {
                    event.preventDefault();
                }
                return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key === ',') {
                event.preventDefault();
                openSettings();
                return;
            }
            if ((key === 'o' || key === 'n')) {
                event.preventDefault();
                showDayPicker();
                return;
            }
            if (key === 's' && screen === 'day') {
                event.preventDefault();
                setSaveRequest(request => request + 1);
                return;
            }
            if (key === 't' && screen === 'day') {
                event.preventDefault();
                setNewDoingRequest(request => request + 1);
            }
        };
        window.addEventListener('keydown', shortcut, true);
        return () => window.removeEventListener('keydown', shortcut, true);
    });

    const saveSettings = async (nextSettings: Settings) => {
        try {
            const saved = await appAPI.saveSettings(nextSettings);
            setSettings(saved);
            setDays(await appAPI.listDays());
            setScreen('welcome');
            setOpenDay(null);
            setError('');
        } catch (reason) {
            setError(errorMessage(reason));
            throw reason;
        }
    };

    if (loading || !settings) {
        return (
            <main className="loading-screen">
                <span className="brand-mark pulse"/>
                <p>Opening your journal…</p>
            </main>
        );
    }

    return (
        <div className="app-shell" data-editor-font={settings.editorFont}>
            {error && (
                <div className="error-banner" role="alert">
                    <span>{error}</span>
                    <button onClick={() => setError('')} aria-label="Dismiss error">×</button>
                </div>
            )}

            {screen === 'welcome' && (
                <Welcome
                    days={days}
                    onCreateToday={() => createToday(true)}
                    onOpenDay={date => openExistingDay(date, true)}
                />
            )}

            {screen === 'settings' && (
                <SettingsView
                    settings={settings}
                    onBack={() => setScreen(settingsReturnScreen.current)}
                    onBrowse={appAPI.chooseStorageDirectory}
                    onSave={saveSettings}
                />
            )}

            {screen === 'day' && openDay && (
                <DayWorkspace
                    day={openDay}
                    saveRequest={saveRequest}
                    toggleCompletedRequest={toggleCompletedRequest}
                    newDoingRequest={newDoingRequest}
                    workspaceActionRequest={workspaceActionRequest}
                    interactionDisabled={dayPickerOpen}
                    onError={message => setError(message)}
                />
            )}

            {dayPickerOpen && screen !== 'welcome' && (
                <div
                    className="day-picker-backdrop"
                    onMouseDown={event => {
                        if (event.target === event.currentTarget) {
                            setDayPickerOpen(false);
                        }
                    }}
                >
                    <section
                        className="day-picker-sheet"
                        role="dialog"
                        aria-modal="true"
                        aria-label="Open a journal day"
                    >
                        <Welcome
                            days={days}
                            embedded
                            onCreateToday={() => createToday(!openDay)}
                            onOpenDay={date => openExistingDay(date, !openDay)}
                        />
                    </section>
                </div>
            )}
        </div>
    );
}

function formatWindowTitle(date: string): string {
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    const formatted = new Intl.DateTimeFormat('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    }).format(parsed);
    return `${formatted} — Journalist Mode`;
}

function errorMessage(reason: unknown): string {
    if (reason instanceof Error) {
        return reason.message;
    }
    return typeof reason === 'string' ? reason : 'Something went wrong while opening the journal.';
}
