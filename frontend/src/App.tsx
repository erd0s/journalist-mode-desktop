import {useEffect, useRef, useState} from 'react';
import {EventsOn, Quit, WindowSetTitle} from '../wailsjs/runtime/runtime';
import './App.css';
import {appAPI, DayData, DaySummary, Settings} from './api';
import {DayWorkspace} from './components/DayWorkspace';
import {SettingsView} from './components/SettingsView';
import {Welcome} from './components/Welcome';

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

    const createToday = async () => {
        try {
            const day = await appAPI.createToday();
            if (appAPI.isNative()) {
                await appAPI.openDayWindow(day.date);
                Quit();
            } else {
                showDay(day);
            }
            return day;
        } catch (reason) {
            setError(errorMessage(reason));
            throw reason;
        }
    };

    const openExistingDay = async (date: string) => {
        try {
            if (appAPI.isNative()) {
                await appAPI.openDayWindow(date);
                Quit();
                return;
            }
            showDay(await appAPI.openDay(date));
        } catch (reason) {
            setError(errorMessage(reason));
        }
    };

    const openSettings = () => {
        setScreen(current => {
            settingsReturnScreen.current = current === 'settings' ? 'welcome' : current;
            return 'settings';
        });
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

        const stopSettings = EventsOn('menu:settings', openSettings);
        const stopSave = EventsOn('menu:save', () => {
            if (screen === 'day') {
                setSaveRequest(request => request + 1);
            }
        });
        const stopToggleCompleted = EventsOn('menu:toggle-completed', () => {
            if (screen === 'day') {
                setToggleCompletedRequest(request => request + 1);
            }
        });
        const stopFont = EventsOn('menu:font', (editorFont: string) => {
            setSettings(current => current ? {...current, editorFont} as Settings : current);
        });
        const stopError = EventsOn('menu:error', (message: string) => setError(message));
        return () => {
            stopSettings();
            stopSave();
            stopToggleCompleted();
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
            if ((event.metaKey || event.ctrlKey) && event.key === ',') {
                event.preventDefault();
                openSettings();
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && screen === 'day') {
                event.preventDefault();
                setSaveRequest(request => request + 1);
            }
        };
        window.addEventListener('keydown', shortcut);
        return () => window.removeEventListener('keydown', shortcut);
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
                    onCreateToday={createToday}
                    onOpenDay={openExistingDay}
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
                />
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
