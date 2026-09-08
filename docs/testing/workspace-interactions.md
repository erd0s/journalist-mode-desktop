# Workspace interaction test

Run this checklist on macOS using the PR build. Allow about 20 minutes. These checks cover #14, #15, #16 and #18-#22; the updater (#17) is outside this PR. A browser preview cannot establish whether native window cycling works.

## Prepare a scratch journal

1. Save any real journal work, close its windows, and quit the installed app. Keep a note of your current journal folder and debug setting so you can restore them afterward. The installed app and a source build share settings and single-instance handling, so only run the PR build during this test.
2. From the PR checkout, run the following in Terminal. It creates disposable files, including enough previous days to exercise scrolling and Doing stream numbers with deliberate gaps. Keep this terminal open for the file checks later.

   ```sh
   JM_REVIEW_ROOT="$(mktemp -d /tmp/jm-workspace-review.XXXXXX)"
   export JM_REVIEW_ROOT
   python3 - <<'PY'
   import os
   from pathlib import Path
   root = Path(os.environ['JM_REVIEW_ROOT'])
   (root / 'Todo').mkdir()
   (root / 'Doing').mkdir()
   for number in range(1, 21):
       date = f'2000-01-{number:02d}'
       (root / 'Todo' / f'{date}.jmtodo.md').write_text(
           '# Work\n'
           '[2000-01-01] A long task that wraps across several display lines when the pane becomes narrow, with enough detail to make its boundary matter\n'
           '    [2000-01-02] An indented child task that also wraps onto multiple display lines\n'
           '[2000-01-03] The next separate task should remain easy to distinguish\n'
           '---\n'
           '~~[2000-01-04] A completed task~~\n')
       for stream in ([1, 3, 9, 10] if number == 20 else [1]):
           suffix = '' if stream == 1 else f'_{stream}'
           (root / 'Doing' / f'{date}{suffix}.jm.md').write_text(
               '(2000-01-20 10:00) A Doing chain\n'
               '\t(2000-01-20 10:15) A child entry\n')
   print(root)
   PY
   wails3 task package
   open "build/bin/Journalist Mode.app"
   ```

3. Open Settings with Command-comma. Select the printed scratch folder and save. Open **20 January 2000** from the welcome screen. Confirm you see Todo and Doing streams 1, 3, 9 and 10.

## Day picker: selection and activation (#14)

- [ ] Press Command-O. **Start today** has visible focus. Press Down once: the first previous day is selected. Continue Down: focus moves one row at a time and the list scrolls to keep it visible. At the bottom, another Down stays there.
- [ ] Press Up repeatedly. Focus returns through the same rows to Today. Another Up stays on Today. Press Return: today's new window opens. Close that window, return to the fixture day, and reopen the picker. It now says **Open today**; Return opens the existing Today window. Close Today again.
- [ ] In the fixture window, open the picker, press Down twice, then Return. **19 January 2000** opens, rather than Today or 20 January. Return to the 20 January window.
- [ ] Open the picker with Command-N. Press Escape to dismiss it. Reopen it, navigate with Tab to a day row, and press Return: that row opens. While the picker is open, arrows must not move the caret or scroll an editor behind it. Once dismissed, arrows work normally in the editor.

## Todo paste and undo (#15, #16)

- [ ] In Todo, place the caret on a new blank line. Paste `A single pasted task`. It gains `[TODAY'S LOCAL DATE] ` exactly once, even though the journal day is in 2000. Type a task on another blank line: it receives the same prefix.
- [ ] Paste the following block into a blank Todo line. Both task lines gain today's date; the four-space indentation, heading, blank line, divider, completed entry and old date remain intact. Visual decoration may hide Markdown markers; inspect the saved file below to check the actual text.

  ```text
  First pasted task
      An indented pasted child
  # Pasted heading

  ---
  ~~Already completed~~
  [2000-01-01] Already dated
  ```

- [ ] Press Command-Z once: the entire block and its new dates disappear together. Command-Shift-Z restores it in one step. The caret remains at the end of the paste, ready for further editing.
- [ ] Select all the text of one task line and paste two undated task lines over it. Both replacements receive today's date; the lines above and below remain intact. Undo once restores the selected original text.
- [ ] Paste `inserted ` into the middle of an existing dated task: only that text is inserted, with no extra date. Paste two lines into the middle of a task: the first joins the existing text, the new second task is dated, and the original suffix stays after the pasted text.
- [ ] Paste a multiline block into Doing: it must not acquire Todo date tags. Confirm Doing clocks still display, and clicking a clock then pressing Backspace exposes its timestamp for editing; restoring the closing `)` restores the clock.
- [ ] Press Command-S. Open `Todo/2000-01-20.jmtodo.md` in a plain-text viewer. Confirm the pasted line order, indentation and exemption markers, with no duplicated date prefixes.

## Pane width and task hierarchy (#19, #22)

Before changing only the presentation, save and record the two existing files in Terminal:

```sh
shasum -a 256 "$JM_REVIEW_ROOT/Todo/2000-01-20.jmtodo.md" "$JM_REVIEW_ROOT/Doing/2000-01-20.jm.md" > "$JM_REVIEW_ROOT/before-layout.sha"
```

- [ ] Narrow and widen the window. Every visible pane stays the same width as its neighbours. The top and side editor gutters gradually shrink as each pane narrows, in both Todo and Doing; roomy panes retain the familiar maximum spacing.
- [ ] Focus Todo, press Command-B to hide it, then Command-B to reveal it. Press Command-T to add a stream. Focus a pane and press Control-Option-Z to zoom it, then again to unzoom. Gutters recalculate on every change without reopening the day. The same editors retain their content, caret and scroll positions except where the action deliberately moves focus.
- [ ] At a narrow width, read the long consecutive Todo tasks. Dates should be clearly distinguishable, and spacing plus a fine separator should distinguish tasks spanning several display lines. Indented tasks remain indented, headings remain headings, completed entries remain muted and struck through, and `---` remains a divider. Click near both text edges and edit/undo a character: there is no clipping or misplaced caret. Doing clocks retain their appearance.
- [ ] Save, then run the following. No output means the two existing files are byte-for-byte unchanged by the layout and display checks. The intentionally created new Doing file is excluded.

  ```sh
  shasum -a 256 "$JM_REVIEW_ROOT/Todo/2000-01-20.jmtodo.md" "$JM_REVIEW_ROOT/Doing/2000-01-20.jm.md" > "$JM_REVIEW_ROOT/after-layout.sha"
  diff "$JM_REVIEW_ROOT/before-layout.sha" "$JM_REVIEW_ROOT/after-layout.sha"
  ```

## Command-hold hints (#20)

- [ ] Hold the left Command key for about half a second. Hints appear: Command-B on visible Todo; Command-1, Command-3 and Command-9 on their corresponding streams; none numbered on stream 10 or higher. Only the focused pane gets the Control-Option-Z zoom hint. Release Command: hints disappear immediately. Repeat with the right Command key.
- [ ] Press a quick Command-S or Command-3 and release promptly. The command runs normally and there is no hint flash. Hold both Command keys, release one, then the other: hints stay while one is held and disappear after the last release.
- [ ] Focus Todo and hide it with Command-B. Hold Command: **Show Todo** is discoverable. Reveal Todo, zoom a Doing pane, and hold Command again: the visible pane shows **Control-Option-Z Unzoom**, even though that action does not use Command.
- [ ] With hints visible, switch to another app and release Command there. Return: no hints remain stuck. Repeat by switching away before the half-second reveal delay. Minimize and restore the window; hints must not linger. These checks deliberately change foreground focus and belong in this uninterrupted native test batch.

## Shortcut reference and debug controls (#18)

- [ ] Click the Command symbol at the upper-right. The keyboard reference opens with a focused close button. Scroll to read all three groups. Press Tab and Shift-Tab: focus remains in the reference. Escape dismisses it and returns focus to its opener. Repeat dismissal with the close button and with a click outside the sheet.
- [ ] Before opening the reference, leave an unsaved edit and zoom a pane. While it is open, try Command-T, Command-B and Control-Option-Z. No stream is created and the workspace layout stays put. Dismiss it: the edit, unsaved indicator, zoom state and editor selection remain. Command-W while the reference is open dismisses the reference first.
- [ ] Enable debug mode in Settings. The Command symbol and checkpoint button remain separately visible and clickable. Mark a checkpoint and open the reference. Drag an empty part of the surrounding title band: it moves the window. Clicking either control activates the control without dragging the window.
- [ ] Create a conflict in the scratch Todo: leave an unsaved edit, then append an external line from the setup terminal:

  ```sh
  printf '\n[2000-01-01] External test change\n' >> "$JM_REVIEW_ROOT/Todo/2000-01-20.jmtodo.md"
  ```

  Wait for **Changed outside the app**. Open and dismiss the reference and hold Command: filenames, save state and **Use disk / Overwrite** remain legible. After dismissal, resolve the scratch conflict with **Use disk**. The external version appears and normal editing resumes.

## Native window cycling (#21)

- [ ] Save scratch edits and close all journal windows. Reopen exactly three days in this order: **20 January**, **19 January**, **18 January 2000**. Focus the 20 January window by clicking it.
- [ ] Press Command-backtick six times, pausing after each. Expected focused dates: **19, 18, 20, 19, 18, 20**. Every press moves exactly one window; the endpoint wraps.
- [ ] From 20 January, press Command-Shift-backtick six times. Expected dates: **18, 19, 20, 18, 19, 20**. Reverse cycling also wraps without skipping or firing twice. Repeat a full forward and reverse cycle with the caret inside Todo, then inside Doing.
- [ ] Open Settings. Cycling from a journal window still visits only journal days. Minimize one journal window: the cycle restores and focuses it when its turn arrives. Close one journal window and cycle again: no stale entry or dead end remains. With only one journal window, either direction leaves that window focused.

## Finish

Save or discard the scratch edits, close the test windows, restore your original journal folder and debug setting, then quit the test build before reopening your usual app. Record the PR commit, macOS version, keyboard layout, and any failed step with its actual result. Leave unchecked steps explicitly unverified.
