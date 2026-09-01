import {useCallback, useEffect, useRef, useState} from 'react';
import {Events, Window as NativeWindow} from '@wailsio/runtime';
import './App.css';
import {appAPI, DayData, DaySummary, Settings} from './api';
import {DayWorkspace, WorkspaceSaveState} from './components/DayWorkspace';
import {SettingsView} from './components/SettingsView';
import {Welcome} from './components/Welcome';
import {needsCloseConfirmation, WorkspaceAction, WorkspaceActionRequest} from './lib/workspace';

type Screen = 'welcome' | 'settings' | 'day';
type ClosePrompt = 'confirm' | 'waiting' | 'saving' | 'failed' | null;

export default function App() {
    const settingsWindow = appAPI.isSettingsWindow();
    const [screen, setScreen] = useState<Screen>(settingsWindow ? 'settings' : 'welcome');
    const [settings, setSettings] = useState<Settings | null>(null);
    const [debugLogDirectory, setDebugLogDirectory] = useState('');
    const [days, setDays] = useState<DaySummary[]>([]);
    const [openDay, setOpenDay] = useState<DayData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [saveRequest, setSaveRequest] = useState(0);
    const [discardRequest, setDiscardRequest] = useState(0);
    const [workspaceSaveState, setWorkspaceSaveState] = useState<WorkspaceSaveState>('saved');
    const [closePrompt, setClosePrompt] = useState<ClosePrompt>(null);
    const [newDoingRequest, setNewDoingRequest] = useState(0);
    const [workspaceActionRequest, setWorkspaceActionRequest] = useState<WorkspaceActionRequest>({
        action: {type: 'focus-todo'},
        revision: 0,
    });
    const [dayPickerOpen, setDayPickerOpen] = useState(false);
    const settingsReturnScreen = useRef<Screen>('welcome');
    const closeSaveRevision = useRef(0);
    const workspaceSaveStateRef = useRef<WorkspaceSaveState>('saved');

    const handleWorkspaceSaveStateChange = useCallback((state: WorkspaceSaveState) => {
        workspaceSaveStateRef.current = state;
        setWorkspaceSaveState(state);
    }, []);

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
        workspaceSaveStateRef.current = 'saved';
        setWorkspaceSaveState('saved');
        setClosePrompt(null);
    };

    const createToday = async (closePickerWindow: boolean) => {
        try {
            const day = await appAPI.createToday();
            if (appAPI.isNative()) {
                await appAPI.openDayWindow(day.date);
                setDayPickerOpen(false);
                if (closePickerWindow) {
                    await appAPI.closeWindow();
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
                    await appAPI.closeWindow();
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
        if (screen === 'welcome' || closePrompt) {
            return;
        }
        setDayPickerOpen(true);
        void loadWelcome().catch(reason => setError(errorMessage(reason)));
    };

    const openSettings = () => {
        if (closePrompt) {
            return;
        }
        void appAPI.getDebugLogDirectory()
            .then(setDebugLogDirectory)
            .catch(reason => setError(errorMessage(reason)));
        if (appAPI.isNative()) {
            void appAPI.openSettingsWindow().catch(reason => setError(errorMessage(reason)));
            return;
        }
        if (screen === 'day' && needsCloseConfirmation(workspaceSaveStateRef.current)) {
            setError('Save or resolve this journal window before opening Settings.');
            return;
        }
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

    const closeCurrentWindow = () => {
        void appAPI.closeWindow().catch(reason => setError(errorMessage(reason)));
    };

    const requestWindowClose = () => {
        if (closePrompt) {
            return;
        }
        setDayPickerOpen(false);
        const saveState = workspaceSaveStateRef.current;
        if (screen === 'day' && saveState === 'saving') {
            setClosePrompt('waiting');
            return;
        }
        if (screen === 'day' && needsCloseConfirmation(saveState)) {
            setClosePrompt('confirm');
            return;
        }
        closeCurrentWindow();
    };

    useEffect(() => {
        const initialise = async () => {
            if (settingsWindow) {
                const [nextSettings, logDirectory] = await Promise.all([
                    appAPI.getSettings(),
                    appAPI.getDebugLogDirectory(),
                ]);
                setSettings(nextSettings);
                setDebugLogDirectory(logDirectory);
                setScreen('settings');
                return;
            }
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
        if (!appAPI.isNative()) {
            return;
        }

        const stopOpen = Events.On('menu:open', showDayPicker);
        const stopSave = Events.On('menu:save', () => {
            if (screen === 'day' && !dayPickerOpen && !closePrompt) {
                setSaveRequest(request => request + 1);
            }
        });
        const stopToggleAllDoingHistory = Events.On('menu:toggle-all-doing-history', () => {
            if (screen === 'day' && !dayPickerOpen && !closePrompt) {
                requestWorkspaceAction({type: 'toggle-all-doing-history'});
            }
        });
        const stopToggleFocusedDoingHistory = Events.On('menu:toggle-focused-doing-history', () => {
            if (screen === 'day' && !dayPickerOpen && !closePrompt) {
                requestWorkspaceAction({type: 'toggle-focused-doing-history'});
            }
        });
        const stopNewDoing = Events.On('menu:new-doing', () => {
            if (screen === 'day' && !dayPickerOpen && !closePrompt) {
                setNewDoingRequest(request => request + 1);
            }
        });
        const stopFocusPane = Events.On('menu:focus-pane', event => {
            const position = Number(event.data);
            if (screen === 'day' && !dayPickerOpen && !closePrompt) {
                if (position === 0) {
                    requestWorkspaceAction({type: 'focus-todo'});
                } else {
                    requestWorkspaceAction({type: 'focus-doing', streamIndex: position});
                }
            }
        });
        const stopMoveFocus = Events.On('menu:move-focus', event => {
            const delta = Number(event.data) as -1 | 1;
            if (screen === 'day' && !dayPickerOpen && !closePrompt) {
                requestWorkspaceAction({type: 'move-focus', delta});
            }
        });
        const stopTogglePaneZoom = Events.On('menu:toggle-pane-zoom', () => {
            if (screen === 'day' && !dayPickerOpen && !closePrompt) {
                requestWorkspaceAction({type: 'toggle-zoom'});
            }
        });
        const stopFont = Events.On('menu:font', event => {
            const editorFont = String(event.data);
            setSettings(current => current ? {...current, editorFont} as Settings : current);
        });
        const stopSettingsChanged = Events.On('settings:changed', event => {
            const changed = event.data as Settings;
            setSettings(changed);
            if (screen === 'welcome') {
                void appAPI.listDays()
                    .then(nextDays => setDays(nextDays ?? []))
                    .catch(reason => setError(errorMessage(reason)));
            }
        });
        const stopError = Events.On('menu:error', event => setError(String(event.data)));
        const stopClose = Events.On('window:close-request', requestWindowClose);
        return () => {
            stopOpen();
            stopSave();
            stopToggleAllDoingHistory();
            stopToggleFocusedDoingHistory();
            stopNewDoing();
            stopFocusPane();
            stopMoveFocus();
            stopTogglePaneZoom();
            stopFont();
            stopSettingsChanged();
            stopError();
            stopClose();
        };
    });

    useEffect(() => {
        if (!appAPI.isNative()) {
            return;
        }
        const title = screen === 'day' && openDay
            ? formatWindowTitle(openDay.date)
            : screen === 'settings' ? 'Settings — Journalist Mode' : 'Journalist Mode';
        void NativeWindow.SetTitle(title);
    }, [openDay, screen]);

    useEffect(() => {
        const shortcut = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && (closePrompt === 'confirm' || closePrompt === 'waiting')) {
                event.preventDefault();
                setClosePrompt(null);
                return;
            }
            if (event.key === 'Escape' && dayPickerOpen) {
                event.preventDefault();
                setDayPickerOpen(false);
                return;
            }
            if (closePrompt) {
                return;
            }
            // Native menu accelerators own application commands in Wails.
            // Handling the same keystroke in the webview can enqueue a
            // non-idempotent action such as New Doing Stream twice.
            if (appAPI.isNative()) {
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

    useEffect(() => {
        if (closePrompt !== 'waiting' || workspaceSaveState === 'saving') {
            return;
        }
        if (workspaceSaveState === 'saved') {
            setClosePrompt(null);
            closeCurrentWindow();
            return;
        }
        setClosePrompt('confirm');
    }, [closePrompt, workspaceSaveState]);

    const saveAndClose = () => {
        const revision = saveRequest + 1;
        closeSaveRevision.current = revision;
        setClosePrompt('saving');
        setSaveRequest(revision);
    };

    const discardAndClose = () => {
        setDiscardRequest(current => current + 1);
        setClosePrompt(null);
        window.requestAnimationFrame(closeCurrentWindow);
    };

    const handleSaveComplete = (revision: number, succeeded: boolean) => {
        if (revision !== closeSaveRevision.current || closePrompt !== 'saving') {
            return;
        }
        closeSaveRevision.current = 0;
        if (!succeeded) {
            setClosePrompt('failed');
            return;
        }
        setClosePrompt(null);
        closeCurrentWindow();
    };

    const saveSettings = async (nextSettings: Settings) => {
        try {
            const saved = await appAPI.saveSettings(nextSettings);
            setSettings(saved);
            setError('');
            if (settingsWindow && appAPI.isNative()) {
                await appAPI.closeWindow();
                return;
            }
            const returnScreen = settingsReturnScreen.current;
            setDays(await appAPI.listDays());
            if (returnScreen === 'day' && openDay) {
                setOpenDay(await appAPI.openDay(openDay.date));
                workspaceSaveStateRef.current = 'saved';
                setWorkspaceSaveState('saved');
                setScreen('day');
            } else {
                setOpenDay(null);
                setScreen('welcome');
            }
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
                    debugLogDirectory={debugLogDirectory}
                    onBack={() => settingsWindow && appAPI.isNative()
                        ? closeCurrentWindow()
                        : setScreen(settingsReturnScreen.current)}
                    onBrowse={appAPI.chooseStorageDirectory}
                    onOpenDebugFolder={async () => {
                        try {
                            await appAPI.openDebugLogFolder();
                        } catch (reason) {
                            setError(errorMessage(reason));
                        }
                    }}
                    onSave={saveSettings}
                />
            )}

            {screen === 'day' && openDay && (
                <DayWorkspace
                    day={openDay}
                    debugMode={settings.debugMode}
                    saveRequest={saveRequest}
                    discardRequest={discardRequest}
                    newDoingRequest={newDoingRequest}
                    workspaceActionRequest={workspaceActionRequest}
                    interactionDisabled={dayPickerOpen || closePrompt !== null}
                    onError={message => setError(message)}
                    onSaveStateChange={handleWorkspaceSaveStateChange}
                    onSaveComplete={handleSaveComplete}
                />
            )}

            {closePrompt && (
                <div className="close-prompt-backdrop">
                    <section
                        className="close-prompt"
                        role="alertdialog"
                        aria-modal="true"
                        aria-labelledby="close-prompt-title"
                        aria-describedby="close-prompt-description"
                    >
                        <h2 id="close-prompt-title">
                            {closePrompt === 'failed'
                                ? 'Couldn’t save this window'
                                : closePrompt === 'waiting' ? 'Finishing the current save…' : 'Save changes before closing?'}
                        </h2>
                        <p id="close-prompt-description">
                            {closePrompt === 'failed'
                                ? 'A save failed or a file changed outside Journalist Mode. The window is still open so you can resolve it without losing work.'
                                : closePrompt === 'waiting'
                                    ? 'The window will close when the current save succeeds. If it fails, your work will stay open.'
                                : 'This journal window has unsaved changes.'}
                        </p>
                        <div className="close-prompt-actions">
                            {closePrompt === 'confirm' && (
                                <>
                                    <button type="button" className="danger-button" onClick={discardAndClose}>
                                        Discard Changes
                                    </button>
                                    <button type="button" className="quiet-button" onClick={() => setClosePrompt(null)}>
                                        Cancel
                                    </button>
                                    <button type="button" className="save-button" onClick={saveAndClose} autoFocus>
                                        Save and Close
                                    </button>
                                </>
                            )}
                            {closePrompt === 'saving' && (
                                <button type="button" className="save-button" disabled>
                                    Saving…
                                </button>
                            )}
                            {closePrompt === 'waiting' && (
                                <button type="button" className="quiet-button" onClick={() => setClosePrompt(null)} autoFocus>
                                    Cancel
                                </button>
                            )}
                            {closePrompt === 'failed' && (
                                <button type="button" className="save-button" onClick={() => setClosePrompt(null)} autoFocus>
                                    Keep Editing
                                </button>
                            )}
                        </div>
                    </section>
                </div>
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
