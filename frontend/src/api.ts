import {
    ChooseStorageDirectory as nativeChooseStorageDirectory,
    ConfirmWindowClose as nativeConfirmWindowClose,
    CreateDoingStream as nativeCreateDoingStream,
    CreateToday as nativeCreateToday,
    GetDebugLogDirectory as nativeGetDebugLogDirectory,
    GetSettings as nativeGetSettings,
    ListDays as nativeListDays,
    OpenDay as nativeOpenDay,
    OpenDayWindow as nativeOpenDayWindow,
    OpenDebugLogFolder as nativeOpenDebugLogFolder,
    OpenSettingsWindow as nativeOpenSettingsWindow,
    ReadJournalFiles as nativeReadJournalFiles,
    RecordDebugEvents as nativeRecordDebugEvents,
    SaveFile as nativeSaveFile,
    SaveSettings as nativeSaveSettings,
} from '../bindings/journalist-mode-desktop/app';
import * as main from '../bindings/journalist-mode-desktop/models';

export type Settings = main.Settings;
export type DebugEvent = main.DebugEvent;
export type DebugFileSnapshot = main.DebugFileSnapshot;
export type DaySummary = main.DaySummary;
export type JournalFile = main.JournalFile;
export type DayData = main.DayData;
export type SaveResult = main.SaveResult;

declare global {
    interface Window {
        _wails?: {
            environment?: {OS?: string};
            [key: string]: unknown;
        };
    }
}

// The Wails runtime creates window._wails in ordinary browsers too. The
// desktop host additionally injects its environment before the app starts.
const isNative = () => Boolean(window._wails?.environment?.OS);

let mockSettings = new main.Settings({
    storageRoot: '~/Documents/JM',
    editorFont: 'avenir-next-condensed',
    debugMode: false,
});
let mockDay = new main.DayData({
    date: '2026-08-28',
    todo: {
        path: '/preview/Todo/2026-08-28.jmtodo.md',
        name: '2026-08-28.jmtodo.md',
        exists: true,
        streamIndex: 0,
        content: '[2026-08-28] Review the day\n\n# Work\n\n[2026-08-28] Finish the desktop layout\n[2026-08-27] Reply to the team\n\n# Personal\n\n[2026-08-28] Book train tickets',
    },
    doing: [
        {
            path: '/preview/Doing/2026-08-28.jm.md',
            name: '2026-08-28.jm.md',
            exists: true,
            streamIndex: 1,
            content: '(2026-08-28 10:46) Build the Journalist Mode desktop app\n\t(2026-08-28 10:48) Shape the day workspace\n\t\t~~(2026-08-28 10:52) Decide on a readable type system (2026-08-28 11:03)~~',
        },
        {
            path: '/preview/Doing/2026-08-28_2.jm.md',
            name: '2026-08-28_2.jm.md',
            exists: true,
            streamIndex: 2,
            content: '(2026-08-28 10:46) Work stream two\n\t(2026-08-28 10:55) Review customer notes',
        },
        {
            path: '/preview/Doing/2026-08-28_3.jm.md',
            name: '2026-08-28_3.jm.md',
            exists: true,
            streamIndex: 3,
            content: '(2026-08-28 10:46) Personal admin\n\t(2026-08-28 11:02) Sort travel plans',
        },
    ],
});

const mockDisk = new Map<string, string>([
    [mockDay.todo.path, mockDay.todo.content],
    ...mockDay.doing.map(file => [file.path, file.content] as [string, string]),
]);

const mockDays = [
    new main.DaySummary({date: '2026-08-28', doingCount: 3, hasTodo: true}),
    new main.DaySummary({date: '2026-08-26', doingCount: 1, hasTodo: true}),
    new main.DaySummary({date: '2026-08-16', doingCount: 4, hasTodo: true}),
    new main.DaySummary({date: '2026-08-13', doingCount: 4, hasTodo: true}),
];

export const appAPI = {
    isNative,

    isSettingsWindow(): boolean {
        return new URLSearchParams(window.location.search).get('settings') === '1';
    },

    async getLaunchDate(): Promise<string> {
        return new URLSearchParams(window.location.search).get('day') ?? '';
    },

    async closeWindow(): Promise<void> {
        if (isNative()) {
            await nativeConfirmWindowClose();
        }
    },

    async getSettings(): Promise<Settings> {
        return isNative() ? nativeGetSettings() : mockSettings;
    },

    async saveSettings(settings: Settings): Promise<Settings> {
        if (isNative()) {
            return nativeSaveSettings(settings);
        }
        mockSettings = new main.Settings(settings);
        return mockSettings;
    },

    async chooseStorageDirectory(): Promise<string> {
        return isNative() ? nativeChooseStorageDirectory() : '/Users/example/Documents/JM';
    },

    async listDays(): Promise<DaySummary[]> {
        return isNative() ? nativeListDays() : mockDays;
    },

    async createToday(): Promise<DayData> {
        return isNative() ? nativeCreateToday() : mockDaySnapshot(mockDay.date);
    },

    async openDay(date: string): Promise<DayData> {
        if (isNative()) {
            return nativeOpenDay(date);
        }
        return mockDaySnapshot(date);
    },

    async openDayWindow(date: string): Promise<string> {
        return isNative() ? nativeOpenDayWindow(date) : 'opened';
    },

    async openSettingsWindow(): Promise<string> {
        return isNative() ? nativeOpenSettingsWindow() : 'opened';
    },

    async getDebugLogDirectory(): Promise<string> {
        return isNative()
            ? nativeGetDebugLogDirectory()
            : '/Users/example/Library/Application Support/Journalist Mode/debug';
    },

    async openDebugLogFolder(): Promise<void> {
        if (isNative()) {
            await nativeOpenDebugLogFolder();
        }
    },

    async recordDebugEvents(events: DebugEvent[]): Promise<void> {
        if (isNative()) {
            await nativeRecordDebugEvents(events);
        }
    },

    async createDoingStream(date: string): Promise<JournalFile> {
        if (isNative()) {
            return nativeCreateDoingStream(date);
        }
        const highestIndex = mockDay.doing.reduce(
            (highest, file) => Math.max(highest, file.streamIndex),
            0,
        );
        const streamIndex = highestIndex + 1;
        const name = streamIndex === 1
            ? `${date}.jm.md`
            : `${date}_${streamIndex}.jm.md`;
        const file = new main.JournalFile({
            path: `/preview/Doing/${name}`,
            name,
            content: '',
            exists: true,
            streamIndex,
        });
        mockDay.doing.push(file);
        mockDisk.set(file.path, '');
        return new main.JournalFile(file);
    },

    async readJournalFiles(paths: string[]): Promise<JournalFile[]> {
        if (isNative()) {
            return nativeReadJournalFiles(paths);
        }
        return paths.map(path => mockFileSnapshot(path));
    },

    async saveFile(
        path: string,
        content: string,
        expectedContent: string,
        force = false,
    ): Promise<SaveResult> {
        if (isNative()) {
            return nativeSaveFile(path, content, expectedContent, force);
        }

        const exists = mockDisk.has(path);
        const diskContent = mockDisk.get(path) ?? '';
        if (exists && diskContent === content) {
            return new main.SaveResult({saved: true, content, exists: true});
        }
        if (!force && diskContent !== expectedContent) {
            return new main.SaveResult({
                conflict: true,
                content: diskContent,
                exists,
            });
        }
        mockDisk.set(path, content);
        return new main.SaveResult({saved: true, content, exists: true});
    },
};

function mockDaySnapshot(date: string): DayData {
    return new main.DayData({
        date,
        todo: mockFileSnapshot(mockDay.todo.path),
        doing: mockDay.doing.map(file => mockFileSnapshot(file.path)),
    });
}

function mockFileSnapshot(path: string): JournalFile {
    const source = mockDay.todo.path === path
        ? mockDay.todo
        : mockDay.doing.find(file => file.path === path);
    return new main.JournalFile({
        path,
        name: source?.name ?? path.split('/').pop() ?? path,
        content: mockDisk.get(path) ?? '',
        exists: mockDisk.has(path),
        streamIndex: source?.streamIndex ?? 0,
    });
}
