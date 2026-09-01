package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestDebugRecorderIsOptInAndCapturesSnapshots(t *testing.T) {
	configDir := t.TempDir()
	app := newAppForPaths(t.TempDir(), filepath.Join(configDir, "settings.json"))
	root := filepath.Join(t.TempDir(), "journal")

	if _, err := app.SaveSettings(Settings{StorageRoot: root}); err != nil {
		t.Fatal(err)
	}
	event := DebugEvent{
		ClientTimestamp: "2026-09-01T12:00:00Z",
		Sequence:        1,
		Window:          "day:2026-09-01",
		Category:        "editor",
		Action:          "transaction",
		Details:         map[string]string{"userEvents": "input.type"},
		Files: []DebugFileSnapshot{{
			Path:        filepath.Join(root, "Doing", "2026-09-01.jm.md"),
			Name:        "2026-09-01.jm.md",
			Kind:        "doing",
			Content:     "(2026-09-01 12:00) captured",
			DiskContent: "",
			SaveState:   "dirty",
			Focused:     true,
			Visible:     true,
		}},
	}
	if err := app.RecordDebugEvents([]DebugEvent{event}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(app.GetDebugLogDirectory()); !os.IsNotExist(err) {
		t.Fatalf("debug folder exists while disabled: %v", err)
	}

	if _, err := app.SaveSettings(Settings{StorageRoot: root, DebugMode: true}); err != nil {
		t.Fatal(err)
	}
	checkpoint := event
	checkpoint.Sequence = 2
	checkpoint.Category = "checkpoint"
	checkpoint.Action = "user_checkpoint"
	if err := app.RecordDebugEvents([]DebugEvent{event, checkpoint}); err != nil {
		t.Fatal(err)
	}

	entries, path := readDebugEntries(t, app.GetDebugLogDirectory())
	if len(entries) != 2 {
		t.Fatalf("got %d debug entries, want 2", len(entries))
	}
	if entries[0].Version != debugLogVersion || entries[0].SessionID == "" {
		t.Fatalf("missing log metadata: %#v", entries[0])
	}
	if entries[0].SessionID != entries[1].SessionID {
		t.Fatalf("batch used two sessions: %q and %q", entries[0].SessionID, entries[1].SessionID)
	}
	if entries[0].Files[0].Content != "(2026-09-01 12:00) captured" ||
		entries[0].Files[0].SaveState != "dirty" {
		t.Fatalf("snapshot was not preserved: %#v", entries[0].Files[0])
	}
	if entries[1].Category != "checkpoint" {
		t.Fatalf("checkpoint category = %q", entries[1].Category)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if permissions := info.Mode().Perm(); permissions != 0o600 {
		t.Fatalf("debug log permissions = %o, want 600", permissions)
	}

	if _, err := app.SaveSettings(Settings{StorageRoot: root, DebugMode: false}); err != nil {
		t.Fatal(err)
	}
	if err := app.RecordDebugEvents([]DebugEvent{{Sequence: 3, Category: "editor"}}); err != nil {
		t.Fatal(err)
	}
	entries, _ = readDebugEntries(t, app.GetDebugLogDirectory())
	if len(entries) != 2 {
		t.Fatalf("disabled recorder appended an event; got %d entries", len(entries))
	}
}

func TestConcurrentDebugBatchesRemainValidJSON(t *testing.T) {
	app := newAppForPaths(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"))
	root := filepath.Join(t.TempDir(), "journal")
	if _, err := app.SaveSettings(Settings{StorageRoot: root, DebugMode: true}); err != nil {
		t.Fatal(err)
	}

	const count = 24
	var group sync.WaitGroup
	for sequence := 1; sequence <= count; sequence++ {
		group.Add(1)
		go func(sequence int) {
			defer group.Done()
			if err := app.RecordDebugEvents([]DebugEvent{{
				Sequence: uint64(sequence),
				Window:   "day:2026-09-01",
				Category: "input",
				Action:   "keydown",
			}}); err != nil {
				t.Errorf("RecordDebugEvents(%d): %v", sequence, err)
			}
		}(sequence)
	}
	group.Wait()

	entries, _ := readDebugEntries(t, app.GetDebugLogDirectory())
	if len(entries) != count {
		t.Fatalf("got %d entries, want %d", len(entries), count)
	}
}

func readDebugEntries(t *testing.T, directory string) ([]debugLogEntry, string) {
	t.Helper()
	files, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("got %d debug files, want 1", len(files))
	}
	path := filepath.Join(directory, files[0].Name())
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	var entries []debugLogEntry
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var entry debugLogEntry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			t.Fatalf("invalid JSONL entry: %v\n%s", err, scanner.Text())
		}
		entries = append(entries, entry)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return entries, path
}
