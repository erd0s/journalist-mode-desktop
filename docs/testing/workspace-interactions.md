# Workspace and updater validation

The combined fixes for #14-#22 were exercised on Dirk's Mac on 8 September 2026. The earlier reopen fix (#24 / PR #25) remains included. Full signed, notarized packages were prepared before each foreground test batch. Speech announced every keyboard/mouse handover and release.

## Results

| Issues | Result and evidence |
| --- | --- |
| #14 | Native standalone Welcome and modal picker both navigated with arrows and opened the selected previous day with Return. Selection uses the requested subtle red fill. |
| #15-#16 | Native paste added today's date to single and multiple new Todo tasks, preserved exemptions, kept one existing Done boundary, and supported one-step undo/redo. Whole-document replacement and exact saved-file contents passed. Doing paste remained independent. |
| #19, #22 | Native wide/narrow layouts, pane zoom/unzoom, Todo hide/reveal and history toggling passed. File hashes stayed unchanged during presentation changes. Date badges and wrapped-task separators were visually checked. |
| #18 | The reference opened and dismissed with Escape and Command-W. Native editing commands were blocked while it was open. Focus returns to the opener; its help text may remain selectable, as Dirk requested. Debug controls appeared only with debug mode enabled, and the checkpoint button worked. |
| #20 | Holding Command displayed the expected pane hints in the running app; release cleared them. Native and frontend traces showed the 500 ms reveal and the state transitions for either Command key. Mounted tests additionally cover simultaneous keys, quick shortcuts, stream-number gaps, modal suppression, blur and stale events. |
| #21 | Three native journal windows cycled and wrapped in both directions, excluding Settings. Cycling away from and back to a full-screen journal preserved full screen. Reopening preserved the process/window count and full-screen state. |
| #17 | A signed 0.7.0 test app installed a signed, notarized 0.7.1 app at the same location. The new PID, changed executable hash, running version, saved contents and three restored journals independently confirmed replacement and relaunch. Cancellation preserved all unsaved edits, including after another window had approved discarding. |

The focused-history shortcut uses **Control-Option-H**. Command-Option-H belongs to macOS Hide Others. Native testing also found that a focused WKWebView may receive the Control-Option shortcut before the menu, so the editor handles and consumes it when delivered there. Toggling history was then verified without changing the document.

## Update failure and cancellation checks

- Empty feeds, older versions and beta-only feeds reported no applicable update.
- An incompatible minimum macOS version was refused.
- An unavailable server and malformed XML produced recoverable errors.
- Invalid signatures, missing signatures and interrupted downloads were rejected; the installed executable remained unchanged.
- Remind Me Later returned to editing.
- Cancel during Save/Discard kept both dirty journals open and unchanged.
- Discard in one journal followed by Cancel in another preserved both journals' unsaved text.
- Save and Continue in both dirty journals installed the update and reopened all three journal days with the saved text.

The upgrade used a localhost appcast and disposable signed app bundles. The production bundle retains the GitHub-hosted feed URL and pinned public key. The test did not publish a GitHub release. Versions before 0.7.0 require one manual upgrade; subsequent releases use the procedure in [Updating Journalist Mode](../updating.md).

## Automated coverage and inspection limits

All 95 frontend tests, Go race tests, and the two publisher tests passed. The full production TypeScript/Vite build and signed/notarized macOS package passed. Publisher preparation was also exercised with an actual notarized archive, and a modified archive was rejected using its original signature.

The automated suite covers save conflicts, failed/in-flight saves during quit, keyboard combinations and focus/visibility transitions beyond the native scenarios above. These are automated assertions, not claims that every combination was manually repeated on the Mac.

Some initial harness failures were measurement problems: accessibility hashes are not unique element identities; hidden accessibility text cannot prove visible hints; OCR missed the small hint labels; and a screenshot can lag a state transition. Hint evidence therefore includes direct visual inspection and the opt-in native/frontend event trace. One earlier batch stopped when the Mac locked; checks after that interruption were not counted as passes.

The scratch dates were 28-30 December 2099. Cleanup removed those journals and restored settings, clipboard and the original journal. Final batches matched every pre-batch original-file hash. The first batch observed one existing journal change while the old app was closing, before the fixture app started; its current contents were preserved.

## Evidence

[Machine-readable results](workspace-results.json) contain native case names, process IDs, upgrade hashes and the distinction between native and automated coverage. Screenshots contain synthetic journal content:

- [Narrow panes](workspace-evidence/narrow-panes.png) and [wide panes](workspace-evidence/wide-panes.png).
- [Command hints visible](workspace-evidence/command-hints.png) and [Command released](workspace-evidence/command-released.png).
- [Signed update ready](workspace-evidence/update-ready.png); the result manifest records the new version, PID and executable hash after relaunch.

The local raw harness and captures remain under `tmp/workspace-native/`; they are ignored by Git. Private journal paths, original-file hashes and clipboard backups are excluded from the committed evidence.
