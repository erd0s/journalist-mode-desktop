import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {appAPI, DayData, JournalFile} from '../api';
import {contentToLines, linesToContent} from '../lib/journal';
import {
    adjacentPanePath,
    WorkspaceAction,
    WorkspaceActionRequest,
    workspaceActionForShortcut,
} from '../lib/workspace';
import {LineEditor} from './LineEditor';

const diskPollInterval = 750;

type DayWorkspaceProps = {
    day: DayData;
    saveRequest: number;
    toggleCompletedRequest: number;
    newDoingRequest: number;
    workspaceActionRequest: WorkspaceActionRequest;
    interactionDisabled: boolean;
    onError: (message: string) => void;
};

export function DayWorkspace({
    day,
    saveRequest,
    toggleCompletedRequest,
    newDoingRequest,
    workspaceActionRequest,
    interactionDisabled,
    onError,
}: DayWorkspaceProps) {
    const [doingFiles, setDoingFiles] = useState<JournalFile[]>(day.doing);
    const files = useMemo(() => [day.todo, ...doingFiles], [day.todo, doingFiles]);
    const paths = useMemo(() => files.map(file => file.path), [files]);
    const [focusedPath, setFocusedPath] = useState(doingFiles[0]?.path ?? day.todo.path);
    const [todoVisible, setTodoVisible] = useState(true);
    const [zoomedPath, setZoomedPath] = useState('');
    const [editorFocus, setEditorFocus] = useState({path: '', revision: 0});
    const [diskContents, setDiskContents] = useState<Record<string, string>>(
        () => contentsByPath(files),
    );
    const handledNewDoingRequest = useRef(newDoingRequest);
    const handledWorkspaceAction = useRef(workspaceActionRequest.revision);
    const createChain = useRef<Promise<void>>(Promise.resolve());
    const mounted = useRef(true);
    const currentDate = useRef(day.date);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    useEffect(() => {
        currentDate.current = day.date;
        setDoingFiles(day.doing);
        setFocusedPath(day.doing[0]?.path ?? day.todo.path);
        setTodoVisible(true);
        setZoomedPath('');
        setEditorFocus({path: '', revision: 0});
        handledNewDoingRequest.current = newDoingRequest;
        handledWorkspaceAction.current = workspaceActionRequest.revision;
        createChain.current = Promise.resolve();
    }, [day.date]);

    useEffect(() => {
        if (focusedPath === day.todo.path || doingFiles.some(file => file.path === focusedPath)) {
            return;
        }
        setFocusedPath(doingFiles[0]?.path ?? (todoVisible ? day.todo.path : ''));
    }, [day.todo.path, doingFiles, focusedPath, todoVisible]);

    useEffect(() => {
        setDiskContents(contentsByPath(files));
    }, [files]);

    useEffect(() => {
        let stopped = false;
        let reading = false;

        const readDisk = async () => {
            if (reading) {
                return;
            }
            reading = true;
            try {
                const snapshots = await appAPI.readJournalFiles(paths);
                if (!stopped) {
                    setDiskContents(current => mergeSnapshots(current, snapshots));
                }
            } catch {
                // A transient read failure should not disrupt typing. The next
                // poll retries; explicit saves still surface their own errors.
            } finally {
                reading = false;
            }
        };

        void readDisk();
        const interval = window.setInterval(readDisk, diskPollInterval);
        return () => {
            stopped = true;
            window.clearInterval(interval);
        };
    }, [paths]);

    const updateDiskContent = useCallback((path: string, nextContent: string) => {
        setDiskContents(current => current[path] === nextContent
            ? current
            : {...current, [path]: nextContent});
    }, []);

    const focusPath = useCallback((path: string): boolean => {
        if (path === day.todo.path) {
            setTodoVisible(true);
        } else if (!doingFiles.some(file => file.path === path)) {
            return false;
        }
        setFocusedPath(path);
        setZoomedPath(current => current ? path : current);
        setEditorFocus(current => ({path, revision: current.revision + 1}));
        return true;
    }, [day.todo.path, doingFiles]);

    const focusPosition = useCallback((position: number): boolean => {
        const path = position === 1
            ? day.todo.path
            : doingFiles[position - 2]?.path;
        return path ? focusPath(path) : false;
    }, [day.todo.path, doingFiles, focusPath]);

    const visiblePaths = useMemo(
        () => [...(todoVisible ? [day.todo.path] : []), ...doingFiles.map(file => file.path)],
        [day.todo.path, doingFiles, todoVisible],
    );

    const moveFocus = useCallback((delta: -1 | 1): boolean => {
        const path = adjacentPanePath(visiblePaths, focusedPath, delta);
        return path ? focusPath(path) : false;
    }, [focusPath, focusedPath, visiblePaths]);

    const toggleZoom = useCallback((): boolean => {
        if (zoomedPath) {
            setZoomedPath('');
            return true;
        }
        const path = visiblePaths.includes(focusedPath) ? focusedPath : visiblePaths[0];
        if (!path) {
            return false;
        }
        setZoomedPath(path);
        if (path !== focusedPath) {
            setFocusedPath(path);
            setEditorFocus(current => ({path, revision: current.revision + 1}));
        }
        return true;
    }, [focusedPath, visiblePaths, zoomedPath]);

    const toggleTodo = useCallback((): boolean => {
        if (!todoVisible) {
            setTodoVisible(true);
            return true;
        }

        setTodoVisible(false);
        if (zoomedPath === day.todo.path) {
            setZoomedPath('');
        }
        if (focusedPath === day.todo.path) {
            const path = doingFiles[0]?.path ?? '';
            setFocusedPath(path);
            if (path) {
                setEditorFocus(current => ({path, revision: current.revision + 1}));
            }
        }
        return true;
    }, [day.todo.path, doingFiles, focusedPath, todoVisible, zoomedPath]);

    const handleWorkspaceAction = useCallback((action: WorkspaceAction): boolean => {
        switch (action.type) {
            case 'focus-position':
                return focusPosition(action.position);
            case 'move-focus':
                return moveFocus(action.delta);
            case 'toggle-zoom':
                return toggleZoom();
            case 'toggle-todo':
                return toggleTodo();
        }
    }, [focusPosition, moveFocus, toggleTodo, toggleZoom]);

    useEffect(() => {
        const shortcut = (event: KeyboardEvent) => {
            if (interactionDisabled) {
                return;
            }
            const action = workspaceActionForShortcut(event);
            if (!action) {
                return;
            }
            if (handleWorkspaceAction(action)) {
                event.preventDefault();
                event.stopPropagation();
            }
        };
        window.addEventListener('keydown', shortcut, true);
        return () => window.removeEventListener('keydown', shortcut, true);
    }, [handleWorkspaceAction, interactionDisabled]);

    useEffect(() => {
        if (handledWorkspaceAction.current === workspaceActionRequest.revision) {
            return;
        }
        handledWorkspaceAction.current = workspaceActionRequest.revision;
        handleWorkspaceAction(workspaceActionRequest.action);
    }, [handleWorkspaceAction, workspaceActionRequest]);

    useEffect(() => {
        const count = newDoingRequest - handledNewDoingRequest.current;
        if (count <= 0) {
            return;
        }
        handledNewDoingRequest.current = newDoingRequest;
        createChain.current = createChain.current.then(async () => {
            for (let pending = 0; pending < count; pending += 1) {
                try {
                    const requestedDate = day.date;
                    const file = await appAPI.createDoingStream(requestedDate);
                    if (!mounted.current || currentDate.current !== requestedDate) {
                        return;
                    }
                    setDoingFiles(current => current.some(item => item.path === file.path)
                        ? current
                        : [...current, file].sort((left, right) => left.streamIndex - right.streamIndex));
                    setDiskContents(current => ({...current, [file.path]: file.content}));
                    setFocusedPath(file.path);
                    setZoomedPath(current => current ? file.path : current);
                    setEditorFocus(current => ({path: file.path, revision: current.revision + 1}));
                } catch (reason) {
                    onError(errorMessage(reason));
                }
            }
        });
    }, [day.date, newDoingRequest, onError]);

    return (
        <main className="workspace-shell">
            <div className="window-drag-region" aria-hidden="true"/>
            <section className={`pane-strip${zoomedPath ? ' is-zoomed' : ''}`}>
                <TodoPane
                    file={day.todo}
                    saveRequest={saveRequest}
                    diskContent={diskContents[day.todo.path] ?? day.todo.content}
                    onDiskContent={updateDiskContent}
                    focusRequest={editorFocus.path === day.todo.path ? editorFocus.revision : 0}
                    hidden={!todoVisible || Boolean(zoomedPath && zoomedPath !== day.todo.path)}
                    onFocus={() => setFocusedPath(day.todo.path)}
                />
                {doingFiles.length > 0 ? doingFiles.map(file => (
                    <DoingPane
                        file={file}
                        key={file.path}
                        saveRequest={saveRequest}
                        diskContent={diskContents[file.path] ?? file.content}
                        onDiskContent={updateDiskContent}
                        toggleCompletedRequest={toggleCompletedRequest}
                        active={file.path === focusedPath}
                        onFocus={() => setFocusedPath(file.path)}
                        focusRequest={editorFocus.path === file.path ? editorFocus.revision : 0}
                        hidden={Boolean(zoomedPath && zoomedPath !== file.path)}
                    />
                )) : (
                    <div className="missing-stream" hidden={Boolean(zoomedPath)}>
                        <h2>No Doing streams</h2>
                        <p>This day has no Doing file yet.</p>
                    </div>
                )}
            </section>
        </main>
    );
}

type DiskAwarePaneProps = {
    file: JournalFile;
    saveRequest: number;
    diskContent: string;
    onDiskContent: (path: string, content: string) => void;
    focusRequest: number;
    hidden: boolean;
    onFocus: () => void;
};

function TodoPane({
    file,
    saveRequest,
    diskContent,
    onDiskContent,
    focusRequest,
    hidden,
    onFocus,
}: DiskAwarePaneProps) {
    const journal = useJournalFile(file, saveRequest, diskContent, onDiskContent);

    return (
        <article className="journal-pane todo-pane" hidden={hidden}>
            <FileBar
                filename={file.name}
                saveState={journal.saveState}
                onUseDisk={journal.useDiskVersion}
                onOverwrite={journal.overwriteDisk}
            />
            <LineEditor
                kind="todo"
                lines={journal.lines}
                onChange={journal.update}
                onFocus={onFocus}
                focusRequest={focusRequest}
            />
        </article>
    );
}

type DoingPaneProps = DiskAwarePaneProps & {
    toggleCompletedRequest: number;
    active: boolean;
    onFocus: () => void;
};

function DoingPane({
    file,
    saveRequest,
    diskContent,
    onDiskContent,
    toggleCompletedRequest,
    active,
    onFocus,
    focusRequest,
    hidden,
}: DoingPaneProps) {
    const journal = useJournalFile(file, saveRequest, diskContent, onDiskContent);
    const [showCompleted, setShowCompleted] = useState(false);
    const handledToggleRequest = useRef(toggleCompletedRequest);

    useEffect(() => {
        if (handledToggleRequest.current === toggleCompletedRequest) {
            return;
        }
        handledToggleRequest.current = toggleCompletedRequest;
        if (active) {
            setShowCompleted(value => !value);
        }
    }, [active, toggleCompletedRequest]);

    return (
        <article className="journal-pane doing-pane" hidden={hidden}>
            <FileBar
                filename={file.name}
                saveState={journal.saveState}
                onUseDisk={journal.useDiskVersion}
                onOverwrite={journal.overwriteDisk}
            />
            <LineEditor
                kind="doing"
                lines={journal.lines}
                showCompleted={showCompleted}
                onChange={journal.update}
                onFocus={onFocus}
                onToggleCompleted={() => setShowCompleted(value => !value)}
                focusRequest={focusRequest}
            />
        </article>
    );
}

type FileBarProps = {
    filename: string;
    saveState: SaveState;
    onUseDisk: () => void;
    onOverwrite: () => void;
};

function FileBar({filename, saveState, onUseDisk, onOverwrite}: FileBarProps) {
    const label = saveStateLabel(saveState);
    return (
        <div className="file-header">
            <header className="file-bar">
                <span className="filename">{filename}</span>
                <span
                    className={`save-state ${saveState}`}
                    title={label}
                    aria-label={label}
                />
            </header>
            {saveState === 'conflict' && (
                <div className="file-conflict" role="alert">
                    <span>Changed outside the app</span>
                    <span className="conflict-actions">
                        <button type="button" onClick={onUseDisk}>Use disk</button>
                        <button type="button" onClick={onOverwrite}>Overwrite</button>
                    </span>
                </div>
            )}
        </div>
    );
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

function useJournalFile(
    file: JournalFile,
    saveRequest: number,
    diskContent: string,
    onDiskContent: (path: string, content: string) => void,
) {
    const [lines, setLines] = useState(() => contentToLines(file.content));
    const [saveState, setSaveState] = useState<SaveState>('saved');
    const content = useRef(file.content);
    const baseline = useRef(file.content);
    const observedDisk = useRef(file.content);
    const external = useRef<string | null>(null);
    const dirty = useRef(false);
    const handledSaveRequest = useRef(saveRequest);
    const saveChain = useRef<Promise<void>>(Promise.resolve());

    useEffect(() => {
        setLines(contentToLines(file.content));
        content.current = file.content;
        baseline.current = file.content;
        observedDisk.current = file.content;
        external.current = null;
        dirty.current = false;
        handledSaveRequest.current = saveRequest;
        saveChain.current = Promise.resolve();
        setSaveState('saved');
    }, [file.path, file.content]);

    useEffect(() => {
        if (diskContent === observedDisk.current) {
            return;
        }
        observedDisk.current = diskContent;

        if (diskContent === baseline.current) {
            external.current = null;
            setSaveState(dirty.current ? 'dirty' : 'saved');
            return;
        }

        if (!dirty.current) {
            content.current = diskContent;
            baseline.current = diskContent;
            external.current = null;
            setLines(contentToLines(diskContent));
            setSaveState('saved');
            return;
        }

        if (diskContent === content.current) {
            baseline.current = diskContent;
            external.current = null;
            dirty.current = false;
            setSaveState('saved');
            return;
        }

        external.current = diskContent;
        setSaveState('conflict');
    }, [diskContent]);

    const queueSave = (force: boolean) => {
        saveChain.current = saveChain.current.then(async () => {
            if (!dirty.current && !force) {
                return;
            }

            const saving = content.current;
            const expected = baseline.current;
            setSaveState('saving');
            try {
                const result = await appAPI.saveFile(file.path, saving, expected, force);
                if (result.conflict) {
                    observedDisk.current = result.content;
                    onDiskContent(file.path, result.content);
                    if (result.content === content.current) {
                        baseline.current = result.content;
                        external.current = null;
                        dirty.current = false;
                        setSaveState('saved');
                        return;
                    }
                    external.current = result.content;
                    setSaveState('conflict');
                    return;
                }

                baseline.current = saving;
                if (!force && external.current !== null && external.current !== saving) {
                    setSaveState('conflict');
                    return;
                }
                external.current = null;
                observedDisk.current = saving;
                onDiskContent(file.path, saving);
                if (content.current === saving) {
                    dirty.current = false;
                    setSaveState('saved');
                    return;
                }
                dirty.current = true;
                setSaveState('dirty');
            } catch {
                setSaveState(external.current === null ? 'error' : 'conflict');
            }
        });
    };

    useEffect(() => {
        if (handledSaveRequest.current === saveRequest) {
            return;
        }
        handledSaveRequest.current = saveRequest;
        queueSave(false);
    }, [file.path, saveRequest]);

    const update = (nextLines: string[]) => {
        setLines(nextLines);
        content.current = linesToContent(nextLines);
        dirty.current = true;
        setSaveState(external.current === null ? 'dirty' : 'conflict');
    };

    const useDiskVersion = () => {
        if (external.current === null) {
            return;
        }
        const nextContent = external.current;
        content.current = nextContent;
        baseline.current = nextContent;
        observedDisk.current = nextContent;
        external.current = null;
        dirty.current = false;
        setLines(contentToLines(nextContent));
        setSaveState('saved');
    };

    return {
        lines,
        update,
        saveState,
        useDiskVersion,
        overwriteDisk: () => queueSave(true),
    };
}

function contentsByPath(files: JournalFile[]): Record<string, string> {
    return Object.fromEntries(files.map(file => [file.path, file.content]));
}

function mergeSnapshots(
    current: Record<string, string>,
    snapshots: JournalFile[],
): Record<string, string> {
    let changed = false;
    const next = {...current};
    for (const file of snapshots) {
        if (next[file.path] !== file.content) {
            next[file.path] = file.content;
            changed = true;
        }
    }
    return changed ? next : current;
}

function saveStateLabel(state: SaveState): string {
    switch (state) {
    case 'saved':
        return 'Saved';
    case 'dirty':
        return 'Unsaved changes';
    case 'saving':
        return 'Saving';
    case 'conflict':
        return 'Changed outside the app';
    default:
        return 'Save failed';
    }
}

function errorMessage(reason: unknown): string {
    if (reason instanceof Error) {
        return reason.message;
    }
    return typeof reason === 'string'
        ? reason
        : 'Could not create another Doing stream.';
}
