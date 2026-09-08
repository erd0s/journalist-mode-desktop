# macOS reopen verification

[Issue #24](https://github.com/erd0s/journalist-mode-desktop/issues/24) is fixed by routing macOS reopen events and second-instance launch notifications through `Desktop.Reopen`. It unhides the app on the main thread and focuses an existing window, unminimising it if necessary. It uses the current window when available and otherwise the oldest remaining window. It creates Welcome only when no windows remain. Window selection and Welcome creation share the existing window mutex.

## Packaged native test result

Passed on 8 September 2026, macOS 26.6.2 (25G83), Apple Silicon. The complete production package and Developer ID signature were prepared before foreground testing. This was a local test build, without a new notarization submission or version bump.

The old running build reproduced the bug: launching a second instance increased its native window count from one journal to a journal plus Welcome. The fixed build then passed the following checks in one foreground interaction batch:

| Starting state | Launch action | Observed result |
| --- | --- | --- |
| Welcome only | Finder Command-O, `open -a`, `open -n -a` | Same Welcome window; no duplicate |
| One journal | All three launch actions, including three consecutive second-instance launches | Same journal window and process; no Welcome |
| Two journals | All three launch actions | Same two window IDs; an existing journal receives focus |
| Hidden app | `open -a`, `open -n -a` | App becomes visible and active; existing journal receives focus |
| Minimized journal | Finder Command-O, `open -n -a` | Same journal is unminimized and focused |
| Full-screen journal | `open -a`, `open -n -a` | Existing journal receives focus and remains full-screen |
| Settings only | Finder Command-O, `open -n -a` | Same Settings window; no Welcome |
| Unsaved synthetic edit, two journals | `open -n -a` | Same two windows; probe text and unsaved state survive |
| Running app with zero windows | All three launch actions, closing Welcome between cases | Exactly one new Welcome window |

The [native observation record](reopen-results.json) includes the executable hash, process IDs, window IDs, focus, hidden state, and fullscreen/minimized state. The fixed process stayed at PID 21298 throughout the tests. For example, the single-journal window remained 187229 after Finder reopen, repeated second launches, hiding, and minimization; adding another journal produced 187246, and both survived subsequent relaunches and the unsaved-edit check.

Observations came from macOS Accessibility and the Window Server, independently of the app's implementation. Foreground checks used the application's `AXFocusedWindow` and `NSRunningApplication.isActive`; a window's `AXFocused` flag did not identify the key window reliably. Full-screen checks waited for Finder's Space transition to settle before launching, so a pending Finder activation could not steal focus after the reopen. The local harness was corrected for those observer/timing details during the batch; the app was not changed or rebuilt during foreground testing.

The four synthetic journal files were removed after their disk hashes were checked. The unsaved probe was discarded through the app's normal close confirmation. Settings were unchanged, and the user's original saved day was reopened in the fixed build at its original window position and size.

## Automated checks and repeat procedure

`go test -race ./...` passed, including regression coverage for no windows, current-window preference, a stale current window, stable selection across map orders, repeated launches, and unminimising before focus. All 52 frontend tests passed. `bash scripts/package-macos.sh` completed and `codesign --verify --deep --strict` accepted the resulting bundle.

To repeat the native checks, build the complete package first. Use two disposable journal days and announce the foreground test interval before taking over input. Verify existing work is saved, close it through the protected window-close path, and quit the old app before launching the built package:

```sh
open -a "$PWD/build/bin/Journalist Mode.app"
```

For the Finder route, reveal the exact built bundle with `open -R`, then press Command-O in Finder. For normal launch and the second-process notification route, activate another app, wait for any Space transition to finish, then use:

```sh
open -a "$PWD/build/bin/Journalist Mode.app"
open -n -a "$PWD/build/bin/Journalist Mode.app"
```

Repeat the matrix above, checking focus, process count, window count, and window identity after each action. Use Command-H to hide, Command-M to minimize, and the native full-screen control for that case. Confirm unsaved synthetic text survives a relaunch before discarding it through the close prompt. Close all test windows, remove only the disposable fixtures, restore the original day, and announce that input can resume.
