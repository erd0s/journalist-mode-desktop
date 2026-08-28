import {
    ChooseStorageDirectory as nativeChooseStorageDirectory,
    CreateToday as nativeCreateToday,
    GetLaunchDate as nativeGetLaunchDate,
    GetSettings as nativeGetSettings,
    ListDays as nativeListDays,
    OpenDay as nativeOpenDay,
    OpenDayWindow as nativeOpenDayWindow,
    ReadJournalFiles as nativeReadJournalFiles,
    SaveFile as nativeSaveFile,
    SaveSettings as nativeSaveSettings,
} from '../wailsjs/go/main/App';
import {main} from '../wailsjs/go/models';

export type Settings = main.Settings;
export type DaySummary = main.DaySummary;
export type JournalFile = main.JournalFile;
export type DayData = main.DayData;
export type SaveResult = main.SaveResult;

declare global {
    interface Window {
        go?: Record<string, unknown>;
        runtime?: Record<string, unknown>;
    }
}

const isNative = () => Boolean(window.go);

let mockSettings = new main.Settings({
    storageRoot: '~/Documents/JM',
    editorFont: 'avenir-next-condensed',
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

    async getLaunchDate(): Promise<string> {
        return isNative() ? nativeGetLaunchDate() : '';
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
