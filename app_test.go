package main

import (
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestDefaultSettingsUseDocumentsJM(t *testing.T) {
	home := t.TempDir()
	app := newAppForPaths(home, filepath.Join(t.TempDir(), "settings.json"))

	settings, err := app.GetSettings()
	if err != nil {
		t.Fatal(err)
	}

	want := filepath.Join(home, "Documents", "JM")
	if settings.StorageRoot != want {
		t.Fatalf("StorageRoot = %q, want %q", settings.StorageRoot, want)
	}
	if settings.EditorFont != defaultEditorFont {
		t.Fatalf("EditorFont = %q, want %q", settings.EditorFont, defaultEditorFont)
	}
	if settings.DebugMode {
		t.Fatal("DebugMode defaults to true")
	}
}

func TestCreateListOpenAndSaveDay(t *testing.T) {
	home := t.TempDir()
	config := filepath.Join(t.TempDir(), "settings.json")
	root := filepath.Join(t.TempDir(), "journal")
	app := newAppForPaths(home, config)

	if _, err := app.SaveSettings(Settings{StorageRoot: root}); err != nil {
		t.Fatal(err)
	}

	day, err := app.CreateDay("2026-08-28")
	if err != nil {
		t.Fatal(err)
	}
	if !day.Todo.Exists || len(day.Doing) != 1 || !day.Doing[0].Exists {
		t.Fatalf("unexpected created day: %#v", day)
	}

	secondPath := filepath.Join(root, "Doing", "2026-08-28_2.jm.md")
	thirdPath := filepath.Join(root, "Doing", "2026-08-28_3.jm.md")
	if err := os.WriteFile(thirdPath, []byte("third"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secondPath, []byte("second"), 0o644); err != nil {
		t.Fatal(err)
	}

	days, err := app.ListDays()
	if err != nil {
		t.Fatal(err)
	}
	if len(days) != 1 || days[0].Date != "2026-08-28" || days[0].DoingCount != 3 || !days[0].HasTodo {
		t.Fatalf("unexpected day summaries: %#v", days)
	}

	day, err = app.OpenDay("2026-08-28")
	if err != nil {
		t.Fatal(err)
	}
	if len(day.Doing) != 3 || day.Doing[1].StreamIndex != 2 || day.Doing[1].Content != "second" || day.Doing[2].StreamIndex != 3 {
		t.Fatalf("Doing streams not ordered by suffix: %#v", day.Doing)
	}

	result, err := app.SaveFile(day.Doing[0].Path, "updated", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Saved || result.Conflict {
		t.Fatalf("unexpected save result: %#v", result)
	}
	data, err := os.ReadFile(day.Doing[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "updated" {
		t.Fatalf("saved content = %q", data)
	}
}

func TestCreateDoingStreamUsesNextSuffixWithoutChangingExistingFiles(t *testing.T) {
	app := newAppForPaths(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"))
	root := filepath.Join(t.TempDir(), "journal")
	if _, err := app.SaveSettings(Settings{StorageRoot: root}); err != nil {
		t.Fatal(err)
	}
	day, err := app.CreateDay("2026-08-28")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(day.Doing[0].Path, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}

	second, err := app.CreateDoingStream(day.Date)
	if err != nil {
		t.Fatal(err)
	}
	third, err := app.CreateDoingStream(day.Date)
	if err != nil {
		t.Fatal(err)
	}
	if second.Name != "2026-08-28_2.jm.md" || second.StreamIndex != 2 || !second.Exists {
		t.Fatalf("unexpected second stream: %#v", second)
	}
	if third.Name != "2026-08-28_3.jm.md" || third.StreamIndex != 3 || !third.Exists {
		t.Fatalf("unexpected third stream: %#v", third)
	}
	content, err := os.ReadFile(day.Doing[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "keep me" {
		t.Fatalf("base stream changed to %q", content)
	}
	if _, err := app.CreateDoingStream("not-a-date"); err == nil {
		t.Fatal("CreateDoingStream accepted an invalid date")
	}
}

func TestOpenTodoOnlyDayDoesNotCreateDoingStream(t *testing.T) {
	app := newAppForPaths(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"))
	root := filepath.Join(t.TempDir(), "journal")
	if _, err := app.SaveSettings(Settings{StorageRoot: root}); err != nil {
		t.Fatal(err)
	}

	date := "2025-05-20"
	todoPath := filepath.Join(root, "Todo", date+".jmtodo.md")
	if err := os.WriteFile(todoPath, []byte("[2025-05-20] existing\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	day, err := app.OpenDay(date)
	if err != nil {
		t.Fatal(err)
	}
	if len(day.Doing) != 0 {
		t.Fatalf("OpenDay returned %d Doing streams, want none", len(day.Doing))
	}
	entries, err := os.ReadDir(filepath.Join(root, "Doing"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("OpenDay created %d Doing files, want none", len(entries))
	}
}

func TestConcurrentDoingStreamCreationChoosesUniqueFiles(t *testing.T) {
	app := newAppForPaths(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"))
	root := filepath.Join(t.TempDir(), "journal")
	if _, err := app.SaveSettings(Settings{StorageRoot: root}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.CreateDay("2026-08-28"); err != nil {
		t.Fatal(err)
	}

	const creations = 12
	files := make(chan JournalFile, creations)
	errors := make(chan error, creations)
	var group sync.WaitGroup
	for range creations {
		group.Add(1)
		go func() {
			defer group.Done()
			file, err := app.CreateDoingStream("2026-08-28")
			if err != nil {
				errors <- err
				return
			}
			files <- file
		}()
	}
	group.Wait()
	close(files)
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}

	seen := make(map[string]bool, creations)
	for file := range files {
		if seen[file.Name] {
			t.Fatalf("duplicate stream %q", file.Name)
		}
		seen[file.Name] = true
	}
	if len(seen) != creations {
		t.Fatalf("created %d unique files, want %d", len(seen), creations)
	}
	day, err := app.OpenDay("2026-08-28")
	if err != nil {
		t.Fatal(err)
	}
	if len(day.Doing) != creations+1 {
		t.Fatalf("OpenDay found %d streams, want %d", len(day.Doing), creations+1)
	}
}

func TestPaneFocusMenuUsesTodoAndMatchingDoingShortcuts(t *testing.T) {
	items := paneFocusMenuItems()
	if len(items) != 10 {
		t.Fatalf("paneFocusMenuItems() has %d items, want 10", len(items))
	}
	if got := items[0]; got.label != "Todo" || got.accelerator != "CmdOrCtrl+B" || got.position != 0 {
		t.Fatalf("Todo menu item = %#v", got)
	}
	for streamIndex := 1; streamIndex <= 9; streamIndex++ {
		got := items[streamIndex]
		if got.label != "Doing "+string(rune('0'+streamIndex)) ||
			got.accelerator != "CmdOrCtrl+"+string(rune('0'+streamIndex)) ||
			got.position != streamIndex {
			t.Fatalf("Doing %d menu item = %#v", streamIndex, got)
		}
	}
}

func TestDayPickerMenuBindsOpenAndNewShortcuts(t *testing.T) {
	items := dayPickerMenuItems()
	if len(items) != 2 {
		t.Fatalf("dayPickerMenuItems() has %d items, want 2", len(items))
	}
	if got := items[0]; got.label != "Open Journal Day…" || got.accelerator != "CmdOrCtrl+O" {
		t.Fatalf("Open menu item = %#v", got)
	}
	if got := items[1]; got.label != "New Journal Day…" || got.accelerator != "CmdOrCtrl+N" {
		t.Fatalf("New menu item = %#v", got)
	}
}

func TestDayPickerMenuAddsEveryShortcutToTheMenu(t *testing.T) {
	menu := application.NewMenu()
	addDayPickerItems(menu, func(*application.Context) {})
	for _, want := range dayPickerMenuItems() {
		item := menu.FindByLabel(want.label)
		if item == nil {
			t.Fatalf("menu has no %q item", want.label)
		}
		// Wails normalises accelerators per platform, so compare against a
		// reference item built from the same string.
		reference := application.NewMenuItem("reference").SetAccelerator(want.accelerator)
		if got := item.GetAccelerator(); got != reference.GetAccelerator() {
			t.Fatalf("%q accelerator = %q, want %q", want.label, got, reference.GetAccelerator())
		}
		if item.Hidden() {
			t.Fatalf("%q is hidden; hidden items do not match key equivalents on macOS", want.label)
		}
	}
}

func TestSaveFileRejectsOutsideStorageRoot(t *testing.T) {
	app := newAppForPaths(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"))
	root := filepath.Join(t.TempDir(), "journal")
	if _, err := app.SaveSettings(Settings{StorageRoot: root}); err != nil {
		t.Fatal(err)
	}

	outside := filepath.Join(t.TempDir(), "outside.jm.md")
	if _, err := app.SaveFile(outside, "nope", "", false); err == nil {
		t.Fatal("SaveFile accepted a path outside the configured journal folders")
	}
}

func TestExternalChangesAreReadAndNeverSilentlyOverwritten(t *testing.T) {
	app := newAppForPaths(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"))
	root := filepath.Join(t.TempDir(), "journal")
	if _, err := app.SaveSettings(Settings{StorageRoot: root}); err != nil {
		t.Fatal(err)
	}

	day, err := app.CreateDay("2026-08-28")
	if err != nil {
		t.Fatal(err)
	}
	path := day.Doing[0].Path
	if _, err := app.SaveFile(path, "original", "", false); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("changed elsewhere"), 0o644); err != nil {
		t.Fatal(err)
	}

	snapshots, err := app.ReadJournalFiles([]string{path})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 || snapshots[0].Content != "changed elsewhere" {
		t.Fatalf("external change not re-read: %#v", snapshots)
	}

	result, err := app.SaveFile(path, "local edit", "original", false)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Conflict || result.Saved || result.Content != "changed elsewhere" {
		t.Fatalf("external edit was not preserved as a conflict: %#v", result)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "changed elsewhere" {
		t.Fatalf("conflicting save overwrote disk with %q", data)
	}

	result, err = app.SaveFile(path, "local edit", "original", true)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Saved || result.Conflict {
		t.Fatalf("explicit overwrite failed: %#v", result)
	}

	if err := os.WriteFile(path, []byte("same result"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err = app.SaveFile(path, "same result", "stale baseline", false)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Saved || result.Conflict {
		t.Fatalf("identical edits did not converge safely: %#v", result)
	}

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	result, err = app.SaveFile(path, "local after deletion", "same result", false)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Conflict || result.Exists {
		t.Fatalf("external deletion was not preserved: %#v", result)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("conflicting save recreated deleted file: %v", err)
	}

	result, err = app.SaveFile(path, "local after deletion", "same result", true)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Saved || !result.Exists {
		t.Fatalf("explicit recreation failed: %#v", result)
	}
}

func TestReadJournalFilesRejectsOutsideStorageRoot(t *testing.T) {
	app := newAppForPaths(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"))
	root := filepath.Join(t.TempDir(), "journal")
	if _, err := app.SaveSettings(Settings{StorageRoot: root}); err != nil {
		t.Fatal(err)
	}

	if _, err := app.ReadJournalFiles([]string{filepath.Join(t.TempDir(), "outside.jm.md")}); err == nil {
		t.Fatal("ReadJournalFiles accepted a path outside the configured journal folders")
	}
}

func TestWindowIdentityAndCloseApproval(t *testing.T) {
	if got := dayWindowName("2026-08-28"); got != "day-2026-08-28" {
		t.Fatalf("dayWindowName() = %q", got)
	}
	desktop := &Desktop{approvedClose: map[uint]bool{42: true}}
	if !desktop.consumeApprovedClose(42) {
		t.Fatal("first approved close was rejected")
	}
	if desktop.consumeApprovedClose(42) {
		t.Fatal("close approval was not one-shot")
	}
}

func TestEditorFontValidation(t *testing.T) {
	app := newAppForPaths(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"))
	if _, err := app.SetEditorFont("comic-sans"); err == nil {
		t.Fatal("SetEditorFont accepted an unknown font")
	}
}
