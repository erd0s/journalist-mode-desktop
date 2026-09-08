# Consolidated issue plan

This plan covers the nine open issues (#14-#22), the attempt in PR #23, and its interaction with the merged reopen fix (#24 / PR #25). PR #23 is the only open PR. The earlier Doing input fix (PR #7) and welcome fixes (PR #13) are already on main and remain regression requirements.

## Evidence and gaps

The [review on PR #23](https://github.com/erd0s/journalist-mode-desktop/pull/23#issuecomment-5582823996) reports that modal arrow navigation works but standalone Welcome navigation does not, requests a subtle red selection background, and identifies a duplicate Done divider on paste. The reviewer checked single-line paste, undo/redo, selection replacement, partial-line paste, Doing paste, saved-file contents, responsive gutters, pane visibility/zoom, task hierarchy, and unchanged files after layout changes. Command hints, the reference sheet, and native window cycling were explicitly untested. The combined menu audit also found that focused-history used macOS Hide Others (Command-Option-H); it now uses Control-Option-H, matching the Control-Option-Z pane command family. Selecting an existing day now preserves full-screen state like reopening and cycling.

Source review confirms that PR #23 deliberately gated arrows and initial focus on `embedded`, and its tests asserted no standalone navigation. Return on previous days relied on the browser's default button activation; the tests manually clicked the row. Both presentations need the same explicit keyboard behavior. Paste dates were transformed in one CodeMirror transaction, but incoming dividers were preserved even with an existing Done boundary. Window cycling called `Restore`, which would undo full-screen or maximized state and conflict with the new reopen rule.

## Combined behavior

| Issues | Contract |
| --- | --- |
| #14 | Both pickers select Today initially, navigate and scroll through days with arrows, and activate the selected day with Return. Day rows use a subtle red selection fill. Modal input stays out of the background editor. |
| #15-#16 | Dates belong to newly pasted Todo tasks, once per task, using the current local date. Indentation, existing dates and exempt content survive, with one-step undo. Provisional divider rule: retain an existing Done boundary and omit another pasted divider without moving tasks; replacing the existing boundary allows its replacement. |
| #19, #22 | Retain the reviewed responsive gutters and task/date hierarchy. Layout changes remain independent of file content, undo, selection and scroll state. |
| #18, #20 | Reference text, native commands and contextual hints agree on stream numbers and actions. Modals block background actions; quick shortcuts do not flash hints; release, blur and minimization clear them. |
| #21 | Cycle one adjacent journal window per command in stable creation order, wrapping in both directions. Exclude Settings and Welcome; unminimize targets without undoing full-screen or maximized state. |
| #17 | Background checks and manual checking lead to an optional verified update. Downloading does not interrupt editing. Every open journal must resolve saves/conflicts before restart; cancellation returns to editing. The update replaces the actual running bundle and reopens its previous days. |

The shared rules are consistent: one picker behavior, one Todo paste transaction, presentation separate from content, one owner per shortcut, and one coordinated window lifecycle. The updater needs a separate implementation and release procedure, but it remains in scope and must be tested with the workspace changes.

## Delivery and native validation

1. Bring PR #23 onto current main, preserving the reopen fix. Correct the confirmed picker/paste gaps and review the remaining shortcut and focus interactions. Add regression tests that fail on the reported behavior.
2. Complete the updater integration assessment, including Sparkle 2, signed packaging and save/close coordination. Prepare its release/feed procedure and failure tests.
3. Run the automated checks and headless browser checks. Prepare scratch fixtures, the full signed native package, and both signed versions needed for a real upgrade before requesting keyboard/mouse time.
4. Announce the foreground batch using speech after checking volume. Validate both pickers, paste/undo and on-disk content, pane layout, hints/reference, three-window cycling, reopen, and a real update with multiple unsaved windows. Record independent native focus/window observations, file checks and screenshots where appearance matters.
5. If a native failure requires rebuilding, announce that input can resume, do the repair in the background, and prepare the next bounded batch. Keep AFK time for interaction, not compilation or open-ended investigation.
6. Remove scratch fixtures, restore settings and the original journal day, and announce that input can resume. Leave the tested build available with evidence and clear review status. Do not treat untested steps as passed.
