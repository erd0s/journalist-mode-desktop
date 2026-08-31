# Journalist Mode

Journalist Mode is a desktop editor for a plain-text work journal. It keeps one Todo file and one or more Doing files for each day.

## Why it exists

A day can contain several unrelated work contexts. One task list records what remains, but it does not show where each context stopped. Journalist Mode separates those roles:

- The Todo file holds work that has not started.
- Each Doing file records the active chain of thought for one work context.

The files remain the source of truth. They can be read, searched, edited, copied, or versioned without Journalist Mode.

## How a day works

The default journal root is `~/Documents/JM`. You can change it in Settings. Journalist Mode stores files in this structure:

```text
JM/
├── Todo/
│   └── 2026-08-28.jmtodo.md
└── Doing/
    ├── 2026-08-28.jm.md
    ├── 2026-08-28_2.jm.md
    └── 2026-08-28_3.jm.md
```

Creating a day creates the Todo file and the first Doing file without truncating files that already exist. Numbered Doing files represent parallel work streams. Each date opens in its own native window, with Todo on the left and Doing streams arranged to its right. Visible panes divide the available window width evenly. You can hide Todo when you only need the journal streams, or zoom the focused pane to fill the workspace without closing or reloading the other editors.

The editors preserve the underlying Markdown. A complete Doing timestamp such as `(2026-08-28 21:47)` appears as the nearest half-hour clock face, while the exact timestamp remains in the file and appears on hover. Click the clock and press Backspace to remove the closing `)` and expose the raw timestamp; type `)` again to restore the clock. Todo dates use compact styling, and completed entries render with strikethrough while remaining editable text.

Journalist Mode does not autosave. `Command-S` saves every pane in the current window. Clean files reload when another program changes them. If a file changes both inside and outside the app, Journalist Mode preserves both versions and asks which one to keep.

The app does not sort Todo entries or provide file synchronization.

## Keyboard controls

| Shortcut | Action |
| --- | --- |
| `Return` | Add the next Todo line or append a child to the active Doing chain |
| `Shift-Return` | Complete the selected Todo entry or deepest active Doing entry |
| `Shift-Escape` | Cancel the selected Todo entry or deepest active Doing entry |
| `Command-Shift-C` | Copy Todo text without its date or completion markers |
| `Command-Shift-H` | Toggle completed history in every Doing pane; a mixed state hides all history |
| `Command-Option-H` | Toggle completed history in the focused Doing pane |
| `Command-S` | Save every pane in the current window |
| `Command-O` or `Command-N` | Show the day picker in the current window |
| `Command-T` | Create and focus the next numbered Doing stream |
| `Command-B` | Focus and reveal Todo; hide it when Todo already has focus |
| `Command-1` … `Command-9` | Focus the open Doing stream with the matching number |
| `Command-Option-Left` or `Command-Option-Right` | Focus the previous or next visible pane, wrapping at either edge |
| `Command-Shift-Z` | Toggle the focused pane between its normal width and the full workspace |
| `Command-,` | Open Settings |
| `Command-W` | Close the current window, prompting if it has unsaved changes |
| <kbd>Command</kbd>-<kbd>&#96;</kbd> | Cycle through open journal windows |

## Install a release

Download the macOS archive from [GitHub Releases](https://github.com/erd0s/journalist-mode-desktop/releases), extract it, and move `Journalist Mode.app` to `/Applications`.

The current binary release targets Apple Silicon. Other platforms are not part of the tested release process.

## Development

The project uses Go 1.25, Wails 3, React, TypeScript, and CodeMirror.

```sh
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.8
npm install --prefix frontend
wails3 task dev
```

Run the checks before submitting a change:

```sh
go test -race ./...
go vet ./...
npm test --prefix frontend
npm run build --prefix frontend
```

## Package for macOS

```sh
./scripts/package-macos.sh
```

The script validates `assets/logo-1024.png`, builds `build/bin/Journalist Mode.app`, signs each Mach-O payload, enables hardened runtime, adds a secure timestamp, and verifies the bundle. It uses the first `Developer ID Application` identity in the keychain. Set `JM_CODESIGN_IDENTITY=-` to make a local ad-hoc build.

For notarization, store credentials once and pass the profile name:

```sh
xcrun notarytool store-credentials "journalist-mode-notary"
JM_NOTARY_PROFILE="journalist-mode-notary" ./scripts/package-macos.sh
```

The script submits a temporary ZIP, waits for Apple, staples the returned ticket, and verifies the result. It does not store credentials in the repository.

## Contributing

Pull requests and issue reports are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening one.

## License

Journalist Mode is available under the [MIT License](LICENSE).
