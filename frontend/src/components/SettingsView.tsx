import {useEffect, useState} from 'react';
import {Settings} from '../api';
import {Icon} from './Icons';

type SettingsProps = {
    settings: Settings;
    onBack: () => void;
    onBrowse: () => Promise<string>;
    onSave: (settings: Settings) => Promise<void>;
};

export function SettingsView({settings, onBack, onBrowse, onSave}: SettingsProps) {
    const [storageRoot, setStorageRoot] = useState(settings.storageRoot);
    const [saving, setSaving] = useState(false);

    useEffect(() => setStorageRoot(settings.storageRoot), [settings.storageRoot]);

    const browse = async () => {
        const selected = await onBrowse();
        if (selected) {
            setStorageRoot(selected);
        }
    };

    const save = async () => {
        setSaving(true);
        try {
            await onSave({...settings, storageRoot});
        } finally {
            setSaving(false);
        }
    };

    return (
        <main className="settings-shell">
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
