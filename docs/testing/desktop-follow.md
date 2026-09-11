# Follow macOS desktop validation

[Issue #26](https://github.com/erd0s/journalist-mode-desktop/issues/26) adds the **Follow macOS desktop** setting. The native checks below ran on 11 September 2026 on macOS 26.6.2 with one display and nine desktops, twice: first against an ad-hoc signed build of branch commit 1ddb743, then, after the code-review fixes, against a build of commit dac4dba (executable SHA256 63315288…), with the same 24 results both times. A signed, notarized package of the same commit (executable SHA256 b833fa09…) passed `codesign --verify --deep --strict`, `spctl --assess` and `stapler validate`; it was not installed or released. The shared screen lock used by the concurrent agent sessions on this Mac was held for the batch, and the Mac was returned to Desktop 1 with its original nine desktops, settings, foreground application and journal files.

## What passed

| Requirement | Observed |
| --- | --- |
| Setting defaults to off, persists, takes effect without restart | Setting was off after the fixture launch; switching 1→4→7 changed nothing and delivered no desktop event. Turning it on in the Settings window made the next switch follow; turning it off stopped following; turning it on again resumed, all without relaunching. `settings.json` carried `followDesktop`. |
| Desktop 4 → 7 selects `_7.jm.md` and leaves it zoomed | From the unzoomed six-pane layout, Desktop 4 left only `2026-09-11_4.jm.md` visible and zoomed; Desktop 7 then left only `2026-09-11_7.jm.md`. The flight recorder shows both changes delivered to today's window. |
| Desktop 1 selects the unsuffixed file | Desktop 1 left only `2026-09-11.jm.md` visible. |
| Desktop 10 and gaps in numbering | With streams 1, 2, 4, 7 and 10 on disk and a tenth desktop added, Desktop 10 left only `2026-09-11_10.jm.md` visible; Desktop 9 (no stream) changed nothing while its event was delivered. |
| Unzoomed start, another zoomed pane, already-zoomed target | Covered by 1→4 (unzoomed start), 4→7 (switch zoom) and the two Mission Control open/close and full-screen round trips below (target unchanged). |
| Duplicate events and manual interaction | After a manual Control-Option-Z unzoom on Desktop 7, opening and closing Mission Control left the layout unzoomed; the next actual switch to Desktop 4 zoomed stream 4. A manual unzoom also survived a round trip through a full-screen Space back to the same desktop. |
| Rapid switches settle on the latest destination | 4→7→2 at 0.6 s spacing ended with only `_2.jm.md` visible; the recorder delivered 7 then 2. |
| Foreground application, window order and keyboard | With TextEdit frontmost and both apps on every desktop, every switch left TextEdit frontmost, Journalist Mode inactive, and TextEdit's window above the journal window in the on-screen order. |
| Window visible while working elsewhere | The journal window, assigned to All Desktops as the single-display stand-in for another monitor, changed pane while TextEdit kept the foreground. |
| Hidden or minimised windows stay that way | The minimised window stayed minimised through a switch and showed `_4.jm.md` when unminimised through Accessibility; the hidden app stayed hidden through a switch and showed `_7.jm.md` when unhidden. |
| Unsaved text and files preserved | Text typed into stream 7 survived switching away and back with the pane still marked "Unsaved changes"; the fixture files' hashes were unchanged throughout. |
| Full-screen Spaces ignored | Putting TextEdit into full screen delivered no desktop event; leaving it back to Desktop 1 delivered none either and left stream 1 zoomed. |
| Numbering matches Mission Control labels | With the full-screen TextEdit Space present, the Dock's Spaces bar read Desktop 1 … Desktop 9, TextEdit, matching the computed numbering (full-screen Space unnumbered). |
| Switching through Mission Control | Pressing the Desktop 4 button in Mission Control switched desktops and zoomed `_4.jm.md` with TextEdit still frontmost. |

## Not verified

- Numbering across several displays, and the layout with "Displays have separate Spaces" turned off. One display is attached and the second case needs a logout. The rule (count user desktops in Mission Control order across displays, skipping full-screen Spaces) is checked on one display only.
- Trackpad gestures cannot be synthesised. They post the same Space-change notification that the shortcut and Mission Control paths exercised.
- A window on a physically separate monitor. The All Desktops assignment is the closest stand-in on this hardware.

## Automated coverage

`go test -race ./...` passes with 16 new tests for snapshot parsing, numbering across displays with a full-screen Space, change detection, the follower (baseline, coalescing, disable, wake baseline, same-desktop return by Space identity across reordering and removal, per-display tracking, recovery reporting, a concurrent run loop), the setting, the availability refusal, the status and window routing. 106 frontend tests pass, including the idempotent zoom action, App routing with stale sequences, deferral during the close prompt, immediate application during a file conflict, changes kept while today's window opens, the disabled switch with its reason, and turning a persisted setting off while the monitor is unavailable. The production build and the publisher tests pass.

## Harness notes

Accessibility returns only the menu bar for a window on another Space or while a full-screen Space is active, so pane checks read the tree on the window's own Space or, inside full screen, relied on the flight recorder. macOS activates the only application with a window on an empty destination desktop, so TextEdit had to be present on every desktop before the foreground check meant anything. The Dock exposes Spaces bar buttons with the label in `AXTitle` and an action phrase in `AXDescription`. An Apple Events permission prompt for TextEdit blocked the first run and was left unanswered; the harness uses LaunchServices instead. The tenth desktop was added through Mission Control's add button and removed afterwards by hovering its tile on the expanded Spaces bar and clicking the close control; the Dock exposes no accessibility element for that control.

[Machine-readable results](desktop-follow-results.json) list every case with its observations, the delivered desktop events, and the restore checks. The harness and raw flight-recorder logs stay under the git-ignored `tmp/follow-desktop/`; they contain no private journal content.
