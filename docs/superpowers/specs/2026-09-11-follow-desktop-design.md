# Follow Mission Control desktops: design

Issue: [#26](https://github.com/erd0s/journalist-mode-desktop/issues/26). Date: 2026-09-11. Status: implemented; revised after an adversarial review (see "Review outcomes" at the end).

## Goal

When the setting **Follow macOS desktop** is on and the active Mission Control desktop changes, today's open journal window selects the Doing pane whose stream number matches the destination desktop number and makes sure that pane is zoomed. Journalist Mode never activates itself, raises or moves a window, or takes keyboard input from the foreground application.

## Facts established on this Mac (macOS 26.6.2)

- The private SkyLight framework exports `SLSMainConnectionID` and `SLSCopyManagedDisplaySpaces`. The call returns an array with one dictionary per display: `Display Identifier` (string), `Current Space` (dictionary) and `Spaces` (ordered array). Each space dictionary has `id64` (number), `ManagedSpaceID`, `type` (0 for a user desktop, 4 for a full-screen or tiled application Space) and `uuid`.
- Array order is the Mission Control order, not the order of space ids. On this Mac Desktop 9 has `id64` 4 while Desktop 2 has `id64` 5.
- `NSWorkspaceActiveSpaceDidChangeNotification` is delivered when an `NSApplication` run loop is running. At delivery time `SLSCopyManagedDisplaySpaces` already reports the destination Space.
- macOS ignores a second Control-number shortcut pressed 50 ms after the first, so "rapid" switching in practice means switches at least a few hundred milliseconds apart.
- One display is attached. Multi-display numbering cannot be verified here.

## Desktop numbering rule

Number only spaces with `type == 0`, in array order, starting at 1 on the first display in the array and continuing on the next display. Full-screen Spaces take no number. The single-display case is checked against the Dock's Mission Control labels in the native test. The cross-display continuation is an assumption about the array order; it is not verified on this Mac (one display) and is recorded as such. Numbering is recomputed from a fresh query on every event, so a topology or ordering change can never leave a stale mapping.

A desktop change is an actual Space switch on one display whose destination desktop number differs from the last numbered desktop seen on that display. Leaving for a full-screen Space and returning to the same desktop is therefore not a change, and a manual unzoom survives it. Reordering desktops without switching is not a change either; the new numbering applies to the next switch.

## Components

### 1. Objective-C observer (`desktop_follow_darwin.m`)

Responsibilities: load the two SkyLight symbols with `dlopen`/`dlsym`, register for `NSWorkspaceActiveSpaceDidChangeNotification`, `NSWorkspaceDidWakeNotification` and `NSWorkspaceScreensDidWakeNotification` on `NSWorkspace.sharedWorkspace.notificationCenter` (they are not posted on the default centre) and for `NSApplicationDidChangeScreenParametersNotification` on `NSNotificationCenter.defaultCenter`, and turn the current managed-display array into JSON. A Space change publishes a snapshot to follow; wake and display-parameter changes publish a baseline snapshot, which replaces the reference state without being followed.

Functions exposed to Go:

- `char *jm_start_desktop_monitor(void)`: returns `NULL` on success or a malloc'd error string naming the missing symbol or library. Registers the observers once.
- `char *jm_desktop_snapshot(void)`: returns a malloc'd JSON string. It is the raw array from `SLSCopyManagedDisplaySpaces` serialised with `NSJSONSerialization`, wrapped as `{"displays": <array>}`. If the call returns nothing or the result is not JSON-serialisable it returns `{"error": "<reason>"}`. Safe to call from any thread; it touches no AppKit state.

The notification handlers call `jm_desktop_snapshot` and hand the string to the Go export `journalistDesktopSnapshot(char *json, int baseline)`, then free it. A followed snapshot is copied, stored and signalled without blocking. A baseline snapshot is applied synchronously under the follower's mutex (a small JSON parse, no webview calls) so that it wins over any snapshot still queued.

### 2. Go follower (`desktop_follow.go`, `desktop_follow_darwin.go`, `desktop_follow_other.go`)

`desktop_follow.go` is platform independent and unit tested:

- `type managedSpace struct { ID uint64; Type int }`, `type displaySpaces struct { ID string; Current uint64; Spaces []managedSpace }`, `type spaceSnapshot struct { Displays []displaySpaces }`.
- `parseSpaceSnapshot(data []byte) (spaceSnapshot, error)`: decodes the raw JSON. It requires `displays` to be a non-empty array, each display to have a string `Display Identifier`, a `Current Space` with numeric `id64`, and a non-empty `Spaces` array whose entries have numeric `id64` and `type`. It reports `{"error": …}` payloads and any shape violation as an error naming the missing key.
- `desktopNumbers(snapshot) map[uint64]int`: the numbering rule above.
- `currentDesktop(display, numbers) (int, error)`: the desktop number of a display's current space, 0 when the current space has no number (full-screen), an error when the current space is not in the display's list.
- `desktopChange(previous, next *spaceSnapshot) (display string, desktop int, changed bool, err error)`: `previous == nil` means baseline (no change). If the set of display identifiers differs the result is baseline (no change). Otherwise exactly one display whose current space id differs yields its identifier and new desktop number; zero such displays means no change; more than one is ambiguous and reported as no change; a destination without a number (full-screen) is no change. Ambiguity and full-screen destinations are the issue's specified behaviour, not failures, so they produce no error. The follower additionally keeps `lastDesktop map[displayID]int` and suppresses a change whose destination equals that display's last numbered desktop.
- `type desktopFollower struct`: holds `mu`, `started`, `wanted` (setting value), `previous *spaceSnapshot`, `sequence uint64`, `latest atomic.Pointer[[]byte]`, `signal chan struct{}` (capacity 1), and two injected functions: `snapshot func() ([]byte, error)` and `dispatch func(desktop int, sequence uint64)`. Methods:
  - `submit(data []byte)`: stores the latest payload and signals without blocking (coalescing, like the command-hint bridge).
  - `submitBaseline(data []byte)`: synchronously parses the payload, replaces `previous` and `lastDesktop`, and drops any queued payload; parse errors go to `report`.
  - `run()`: for each signal, loads the latest payload, parses, computes the change against `previous`, stores the new snapshot as `previous`, and if `wanted` and changed calls `dispatch` with the next sequence number. Parse errors go to `report(err)`.
  - `setEnabled(enabled bool)`: records `wanted`; in both directions it clears `previous`, `lastDesktop` and any queued payload; when it turns on and the monitor has started it takes a fresh baseline through `snapshot`. `run` releases the mutex before calling `dispatch` or `report`, and `setEnabled` calls `snapshot` directly rather than through `application.InvokeSync`, so neither the debug recorder's settings read nor a main-thread caller can deadlock.
  - `start()`: marks started and, if `wanted`, takes the baseline.
- `App.setFollowDesktop(enabled bool)`: called from `GetSettings` and `SaveSettings` beside `setDebugMode`; forwards to the follower only when the value changes. Every `settings.json` read and the enable-then-write sequence in `SaveSettings` run under one `settingsMu`, so the 750 ms file poll cannot apply a stale value between enabling the follower and writing the file. The follower is constructed in `main()` before the first `GetSettings`, records `wanted` before the monitor starts, and `start()` takes the baseline when `wanted` is already true, so a persisted enabled setting survives launch.

`desktop_follow_darwin.go` wires cgo: the `journalistDesktopSnapshot` export calls `follower.submit`; `startNativeDesktopFollow(d *Desktop) error` calls `jm_start_desktop_monitor` through `application.InvokeSync`, records an unavailability reason if it fails, sets `snapshot` to `jm_desktop_snapshot` and `dispatch` to the window router, starts `run()` in a goroutine, then calls `start()`.

The window router in `main.go`/`desktop_follow.go`: `func (d *Desktop) dispatchDesktopChange(desktop int, sequence uint64)` resolves today's local date, looks up `day-<date>` with `Window.GetByName`, and if present calls `dispatchToWindow(window, "desktop:changed", map[string]any{"desktop": desktop, "sequence": sequence})`. It never calls `Show`, `Focus`, `UnMinimise` or `Restore`. It also records a debug event (category `desktop`, action `changed`) through `RecordDebugEvents`, which is a no-op unless the flight recorder is on.

`desktop_follow_other.go` provides the non-darwin stubs: `startNativeDesktopFollow` returns an error saying the feature needs macOS.

### 3. Settings

`Settings` gains `FollowDesktop bool` with JSON key `followDesktop`, default false. `SaveSettings` refuses to turn it on (the false to true transition only) while the native monitor is unavailable, returning `follow macOS desktop is unavailable: <reason>`; the Settings window shows that error in the existing banner and the setting stays off. Saving broadcasts `settings:changed` to every window as today. The generated TypeScript models are regenerated with `wails3 task generate:bindings`.

A bound method `GetFollowDesktopStatus() {available, reason}` reports whether the monitor started. The Settings window reads it on open, disables the switch and shows the reason when it is unavailable. A day window whose settings have the feature on reads it at start-up and shows the reason in the error banner. (A `menu:error` sent from `ApplicationDidFinishLaunching` would be dropped: the webview registers its listeners after the runtime flushes queued scripts.)

`SettingsView` gets a card titled **Follow macOS desktop** with the switch control already used for the flight recorder, the label text "Automatically select and zoom the Doing stream matching the desktop you switch to.", and a note that Desktop 1 uses the first Doing stream and Desktop N uses stream N. Save includes the value.

### 4. Frontend action

`WorkspaceAction` gains `{type: 'focus-doing-zoomed'; streamIndex: number}`. `DayWorkspace.handleWorkspaceAction` maps it to `focusDoingZoomed(streamIndex)`: find the Doing file with that `streamIndex`; if none, return false and change nothing; otherwise set `focusedPath` and `zoomedPath` to that path and bump `editorFocus` for it. Because it assigns rather than toggles, repeating it keeps the pane zoomed. Todo visibility, history visibility, document contents, undo history and each editor's selection are untouched; `EditorView.focus()` does not scroll or change the selection.

`App.tsx` subscribes to `desktop:changed` in the existing native event effect. The handler:

1. Ignores payloads whose `sequence` is not greater than the last one seen for this window (kept in a `useRef`, because the effect re-subscribes on every render).
2. Ignores the event when `settings.followDesktop` is false or the window is not showing a day.
3. If the day picker, a close or quit prompt or the shortcut reference is open, stores the desktop number as the pending target and returns. The workspace is `inert` while these show, so the user cannot make a manual choice that a deferred target could later override.
4. Otherwise requests `{type: 'focus-doing-zoomed', streamIndex: desktop}`. An unresolved file conflict does not defer: the conflict banner stays on its pane and the window's save protection is unchanged, while deferring would let a later application override manual selection made during the conflict.

An effect applies the pending target when all of those conditions clear, revalidating step 2 first, then clears it. `settings:changed` with `followDesktop` false clears the pending target. Hidden or minimised windows need no special handling: the webview state updates immediately and the editor's `requestAnimationFrame` focus runs when the window next paints; nothing calls into the native window.

### 5. Documentation and evidence

README: a paragraph in "How a day works" describing the setting, its default and the mapping (Desktop 1 is the unsuffixed file). `docs/testing/desktop-follow.md` and `desktop-follow-results.json` record the native checks in the same style as `workspace-interactions.md`.

## Error handling summary

| Situation | Behaviour |
| --- | --- |
| SkyLight library or symbol missing | Monitor unavailable. Enabling the setting fails with a visible error; a persisted enabled setting reports the error once to open windows at launch. |
| Snapshot cannot be parsed or has an unexpected shape | Error banner in today's window, or in every open window when today is closed (the key window is normally another application's), reported once per distinct message; the pane is unchanged. |
| Wake from sleep, screen wake, display added or removed | Baseline replaced from a fresh query; no pane change. |
| Destination is a full-screen Space, ambiguous, or the display set changed | No pane change; the new snapshot becomes the baseline. |
| Today's window closed, or the target stream missing | No pane change, no file created, no window opened. |
| Modal or quit in progress | Target deferred, revalidated and applied when the flow ends. |
| Return to the same numbered desktop after a full-screen Space | No pane change; a manual unzoom survives. |
| Setting turned off | Native queue drained, frontend pending target cleared, no further events until re-enabled. |

## Testing

Go (`desktop_follow_test.go`): parsing of the real captured payload and rejection of malformed payloads; numbering with two displays and a full-screen space in the middle; change detection for no change, one display, two displays, full-screen destination, display-set change and a current space missing from its list; follower behaviour with an injected dispatcher: disabled ignores events, enabling takes a baseline without dispatch, a change dispatches with increasing sequence, an identical snapshot does not dispatch, disabling drains a pending signal, re-enabling starts a new baseline. Window routing: today's window receives the event, other dates do not, no window means no dispatch, and no window method other than `Name`, `ID` and `DispatchWailsEvent` is called (embedding `application.Window` in the test double makes any other call panic).

Frontend: `DayWorkspace.follow.test.tsx` for the idempotent action from unzoomed, from another zoomed pane, on the already-zoomed target, twice in a row, with stream gaps and stream 10, with a missing stream, and with document and selection unchanged. `App.follow.test.tsx` for sequence filtering, setting off, welcome screen, deferral during the close prompt and application after Cancel, clearing when the setting turns off. `SettingsView.test.tsx` gains the toggle persistence case.

Native (with the shared screen lock held): a signed test build, a scratch journal root with today's streams 1, 2, 4, 7 and 10 and a temporarily added tenth desktop, a foreground application other than Journalist Mode, switches by Control-number shortcuts and by Mission Control clicks, checks of the visible pane through Accessibility, of the frontmost application and window order through `NSWorkspace` and the window list, and of file hashes before and after. Mission Control labels are read from the Dock's accessibility tree with a full-screen Space present and compared with the computed numbering. Multi-display and trackpad gestures are recorded as not verified.

## Review outcomes

An adversarial review of the first draft produced 17 findings. Accepted and implemented: the same-desktop return rule, wake and display baselines, the settings mutex, the status binding replacing the launch-time error event, error routing to real windows, no deferral during conflicts, the sequence filter in a ref, the notification centres named above, the yabai/Hammerspoon citation removed, and README notes on midnight and the "Automatically rearrange Spaces" option. Not resolvable on this machine: verification of desktop numbering across several displays and with "Displays have separate Spaces" turned off; both need a second display and a logout, and the results record them as unverified. The browser preview disables the switch with an explanation because following cannot work outside the desktop app.
