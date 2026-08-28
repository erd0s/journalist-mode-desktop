import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {appAPI, DayData, JournalFile} from '../api';
import {contentToLines, linesToContent} from '../lib/journal';
import {LineEditor} from './LineEditor';

const diskPollInterval = 750;

type DayWorkspaceProps = {
    day: DayData;
    saveRequest: number;
    toggleCompletedRequest: number;
};

export function DayWorkspace({day, saveRequest, toggleCompletedRequest}: DayWorkspaceProps) {
    const files = useMemo(() => [day.todo, ...day.doing], [day]);
    const paths = useMemo(() => files.map(file => file.path), [files]);
    const [activeDoingPath, setActiveDoingPath] = useState(day.doing[0]?.path ?? '');
    const [diskContents, setDiskContents] = useState<Record<string, string>>(
        () => contentsByPath(files),
    );

    useEffect(() => {
        if (!day.doing.some(file => file.path === activeDoingPath)) {
            setActiveDoingPath(day.doing[0]?.path ?? '');
        }
    }, [activeDoingPath, day.doing]);

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

    return (
        <main className="workspace-shell">
            <section className="pane-strip">
                <TodoPane
                    file={day.todo}
                    saveRequest={saveRequest}
                    diskContent={diskContents[day.todo.path] ?? day.todo.content}
                    onDiskContent={updateDiskContent}
                />
                {day.doing.length > 0 ? day.doing.map(file => (
                    <DoingPane
                        file={file}
                        key={file.path}
                        saveRequest={saveRequest}
                        diskContent={diskContents[file.path] ?? file.content}
                        onDiskContent={updateDiskContent}
                        toggleCompletedRequest={toggleCompletedRequest}
                        active={file.path === activeDoingPath}
                        onFocus={() => setActiveDoingPath(file.path)}
                    />
                )) : (
                    <div className="missing-stream">
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
};

function TodoPane({file, saveRequest, diskContent, onDiskContent}: DiskAwarePaneProps) {
    const journal = useJournalFile(file, saveRequest, diskContent, onDiskContent);

    return (
        <article className="journal-pane todo-pane">
            <FileBar
                filename={file.name}
                saveState={journal.saveState}
                onUseDisk={journal.useDiskVersion}
                onOverwrite={journal.overwriteDisk}
            />
            <LineEditor kind="todo" lines={journal.lines} onChange={journal.update}/>
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
        <article className="journal-pane doing-pane">
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
