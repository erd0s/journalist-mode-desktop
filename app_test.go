package main

import (
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
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

func TestDayMenuContainsOnlyCurrentWindowActions(t *testing.T) {
	app := newAppForPaths(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"))
	root := filepath.Join(t.TempDir(), "journal")
	if _, err := app.SaveSettings(Settings{StorageRoot: root}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.CreateDay("2026-08-28"); err != nil {
		t.Fatal(err)
	}
	app.launchDate = "2026-08-28"
	application := applicationMenu(app)

	if menuContainsLabel(application, "New Window") {
		t.Fatal("day menu retained the defunct New Window action")
	}
	for _, label := range []string{
		"Open Journal Day…",
		"New Doing Stream",
		"Toggle Todo Pane",
		"Toggle Focused Pane Zoom",
		"Toggle All Doing History",
		"Toggle Focused Doing History",
		"Focus Pane Left",
		"Focus Pane Right",
		"Todo",
		"Doing 1",
	} {
		if !menuContainsLabel(application, label) {
			t.Fatalf("day menu is missing %q", label)
		}
	}

	accelerators := map[string]string{
		"Toggle Todo Pane":             "Cmd+B",
		"Toggle Focused Pane Zoom":     "Cmd+Shift+Z",
		"Toggle All Doing History":     "Cmd+Shift+H",
		"Toggle Focused Doing History": "Cmd+Option+H",
		"Focus Pane Left":              "Cmd+Option+LEFT",
		"Focus Pane Right":             "Cmd+Option+RIGHT",
	}
	for label, want := range accelerators {
		item := menuItemByLabel(application, label)
		if item == nil || item.Accelerator == nil {
			t.Fatalf("menu item %q has no accelerator", label)
		}
		if got := keys.Stringify(item.Accelerator, "darwin"); got != want {
			t.Fatalf("accelerator for %q = %q, want %q", label, got, want)
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

func TestWindowLaunchArguments(t *testing.T) {
	if got := launchDateFromArgs([]string{"--day", "2026-08-28"}); got != "2026-08-28" {
		t.Fatalf("launchDateFromArgs() = %q", got)
	}
	if got := launchDateFromArgs([]string{"--day=not-a-date"}); got != "" {
		t.Fatalf("invalid launch date = %q", got)
	}

	filtered := withoutLaunchDay([]string{"--devserver", "http://localhost:34115", "--day", "2026-08-28"})
	if !reflect.DeepEqual(filtered, []string{"--devserver", "http://localhost:34115"}) {
		t.Fatalf("withoutLaunchDay() = %#v", filtered)
	}
}

func TestDayWindowRegistration(t *testing.T) {
	app := newAppForPaths(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"))
	app.launchDate = "2026-08-28"

	if err := app.registerDayWindow(); err != nil {
		t.Fatal(err)
	}
	pid, open, err := app.registeredDayPID(app.launchDate)
	if err != nil {
		t.Fatal(err)
	}
	if !open || pid != os.Getpid() {
		t.Fatalf("registeredDayPID() = (%d, %v), want (%d, true)", pid, open, os.Getpid())
	}
	if err := app.unregisterDayWindow(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(app.dayWindowPath(app.launchDate)); !os.IsNotExist(err) {
		t.Fatalf("window registration still exists: %v", err)
	}
}

func TestEditorFontValidation(t *testing.T) {
	app := newAppForPaths(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"))
	if _, err := app.SetEditorFont("comic-sans"); err == nil {
		t.Fatal("SetEditorFont accepted an unknown font")
	}
}

func menuContainsLabel(parent *menu.Menu, label string) bool {
	return menuItemByLabel(parent, label) != nil
}

func menuItemByLabel(parent *menu.Menu, label string) *menu.MenuItem {
	for _, item := range parent.Items {
		if item.Label == label {
			return item
		}
		if item.SubMenu != nil {
			if child := menuItemByLabel(item.SubMenu, label); child != nil {
				return child
			}
		}
	}
	return nil
}
