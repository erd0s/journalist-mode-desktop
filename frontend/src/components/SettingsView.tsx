import {useEffect, useState} from 'react';
import {Settings} from '../api';
import {Icon} from './Icons';

type SettingsProps = {
    settings: Settings;
    debugLogDirectory: string;
    onBack: () => void;
    onBrowse: () => Promise<string>;
    onOpenDebugFolder: () => Promise<void>;
    onSave: (settings: Settings) => Promise<void>;
};

export function SettingsView({
    settings,
    debugLogDirectory,
    onBack,
    onBrowse,
    onOpenDebugFolder,
    onSave,
}: SettingsProps) {
    const [storageRoot, setStorageRoot] = useState(settings.storageRoot);
    const [debugMode, setDebugMode] = useState(settings.debugMode);
    const [saving, setSaving] = useState(false);

    useEffect(() => setStorageRoot(settings.storageRoot), [settings.storageRoot]);
    useEffect(() => setDebugMode(settings.debugMode), [settings.debugMode]);

    const browse = async () => {
        const selected = await onBrowse();
        if (selected) {
            setStorageRoot(selected);
        }
    };

    const save = async () => {
        setSaving(true);
        try {
            await onSave({...settings, storageRoot, debugMode});
        } finally {
            setSaving(false);
        }
    };

    return (
        <main className="settings-shell">
            <div className="window-drag-region" aria-hidden="true"/>
            <section className="settings-content">
                <p className="eyebrow">Preferences</p>
                <h1>Settings</h1>
                <p className="settings-intro">Choose the home for your plain-text journal. Journalist Mode keeps the two file types in separate folders beneath it.</p>

                <div className="settings-card">
                    <div className="setting-label">
                        <span className="setting-icon"><Icon name="folder"/></span>
                        <span><strong>Journal folder</strong><small>Default: ~/Documents/JM</small></span>
                    </div>
                    <div className="folder-control">
                        <input
                            aria-label="Journal folder"
                            value={storageRoot}
                            onChange={event => setStorageRoot(event.target.value)}
                            spellCheck={false}
                        />
                        <button className="secondary-button" onClick={browse}>Choose…</button>
                    </div>

                    <div className="folder-preview" aria-label="Folders created by Journalist Mode">
                        <span>{storageRoot || 'Journal folder'}</span>
                        <span className="folder-child">└─ Doing</span>
                        <span className="folder-child">└─ Todo</span>
                    </div>

                    <p className="setting-note">Changing this location does not move existing files. You can migrate them into these folders at any time.</p>
                </div>

                <div className="settings-card debug-settings-card">
                    <label className="debug-toggle">
                        <span className="setting-label debug-setting-label">
                            <span className="debug-status-dot" aria-hidden="true"/>
                            <span>
                                <strong>Debug flight recorder</strong>
                                <small>Capture interactions and complete file snapshots</small>
                            </span>
                        </span>
                        <span className="switch-control">
                            <input
                                type="checkbox"
                                aria-label="Enable debug mode"
                                checked={debugMode}
                                onChange={event => setDebugMode(event.target.checked)}
                            />
                            <span aria-hidden="true"/>
                        </span>
                    </label>

                    <p className="debug-warning">
                        Debug logs stay on this computer, but they contain the full text of every open journal file and can grow quickly. Turn this off when you finish investigating.
                    </p>
                    <div className="debug-folder-row">
                        <code title={debugLogDirectory}>{debugLogDirectory || 'Debug log folder'}</code>
                        <button type="button" className="secondary-button" onClick={onOpenDebugFolder}>
                            Show logs
                        </button>
                    </div>
                </div>

                <div className="settings-actions">
                    <button className="quiet-button" onClick={onBack}>Cancel</button>
                    <button className="save-button" onClick={save} disabled={!storageRoot.trim() || saving}>
                        {saving ? 'Saving…' : 'Save settings'}
                    </button>
                </div>
            </section>
        </main>
    );
}
