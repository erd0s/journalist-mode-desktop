package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
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
