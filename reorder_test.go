package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func shuffleFixture(t *testing.T) (*App, DayData, string) {
	t.Helper()
	app := newAppForPaths(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"))
	day, err := app.CreateDay("2026-09-29")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := app.CreateDoingStream(day.Date); err != nil {
			t.Fatal(err)
		}
	}
	day, err = app.OpenDay(day.Date)
	if err != nil {
		t.Fatal(err)
	}
	for i, content := range []string{"first\n\tchild\n", "second\r\n", "第三 🕙\n"} {
		if err := os.WriteFile(day.Doing[i].Path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(day.Doing[i].Path, 0o600); err != nil {
			t.Fatal(err)
		}
		day.Doing[i].Content = content
	}
	if err := os.WriteFile(day.Todo.Path, []byte("todo stays"), 0o644); err != nil {
		t.Fatal(err)
	}
	return app, day, filepath.Dir(filepath.Dir(day.Todo.Path))
}

func assertShuffleDisk(t *testing.T, day DayData, want []string) {
	t.Helper()
	for i, file := range day.Doing {
		got, err := os.ReadFile(file.Path)
		if err != nil || string(got) != want[i] {
			t.Fatalf("%s = %q, %v; want %q", file.Name, got, err, want[i])
		}
	}
	got, err := os.ReadFile(day.Todo.Path)
	if err != nil || string(got) != "todo stays" {
		t.Fatalf("Todo changed: %q %v", got, err)
	}
}

func doingContents(day DayData) []string {
	var contents []string
	for _, file := range day.Doing {
		contents = append(contents, file.Content)
	}
	return contents
}

func TestMoveDoingContentsPreservesPositionsAndBytes(t *testing.T) {
	for _, test := range []struct {
		from, to int
		order    []int
	}{
		{3, 1, []int{2, 0, 1}}, {3, 2, []int{0, 2, 1}}, {1, 3, []int{1, 2, 0}}, {1, 1, []int{0, 1, 2}},
	} {
		t.Run(string(rune('0'+test.from))+"to"+string(rune('0'+test.to)), func(t *testing.T) {
			app, day, root := shuffleFixture(t)
			moved, err := app.MoveDoingContents(day.Date, test.from, test.to, day.Doing)
			if err != nil {
				t.Fatal(err)
			}
			var want []string
			for i, original := range test.order {
				want = append(want, day.Doing[original].Content)
				if moved[i].Path != day.Doing[i].Path || moved[i].StreamIndex != day.Doing[i].StreamIndex || moved[i].Name != day.Doing[i].Name {
					t.Fatal("file positions changed")
				}
				if moved[i].Content != want[i] {
					t.Fatal("returned contents differ")
				}
				info, err := os.Stat(moved[i].Path)
				if err != nil || info.Mode().Perm() != 0o600 {
					t.Fatalf("permissions changed: %v", err)
				}
			}
			assertShuffleDisk(t, day, want)
			if _, err := os.Stat(filepath.Join(root, reorderRecoveryName)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("recovery record left: %v", err)
			}
		})
	}
}

func TestMoveDoingRejectsChangedMissingAndInvalidSnapshots(t *testing.T) {
	for _, kind := range []string{"stale", "missing", "extra", "outside", "wrong-date", "unknown-stream", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			app, day, root := shuffleFixture(t)
			want := doingContents(day)
			expected := append([]JournalFile(nil), day.Doing...)
			date, from := day.Date, 3
			switch kind {
			case "stale":
				expected[1].Content = "old content"
			case "missing":
				expected = expected[:2]
			case "extra":
				expected = append(expected, expected[0])
			case "outside":
				expected[0].Path = "/tmp/unrelated.jm.md"
			case "wrong-date":
				date = "2026-09-28"
			case "unknown-stream":
				from = 9
			case "symlink":
				target := filepath.Join(root, "outside.md")
				if err := os.WriteFile(target, []byte(want[0]), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(day.Doing[0].Path); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, day.Doing[0].Path); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := app.MoveDoingContents(date, from, 1, expected); err == nil {
				t.Fatal("unsafe shuffle accepted")
			}
			assertShuffleDisk(t, day, want)
		})
	}
}

func TestJournalLocksBlockAllWriters(t *testing.T) {
	app, day, root := shuffleFixture(t)
	lock, err := beginJournalAccess(root)
	if err != nil {
		t.Fatal(err)
	}
	other := newAppForPaths(app.homeDir, app.settingsPath)
	if _, err := other.MoveDoingContents(day.Date, 3, 1, day.Doing); err == nil {
		t.Fatal("move ignored journal lock")
	}
	if _, err := other.SaveFile(day.Doing[0].Path, "overwrite", day.Doing[0].Content, true); err == nil {
		t.Fatal("save ignored journal lock")
	}
	if _, err := other.CreateDoingStream(day.Date); err == nil {
		t.Fatal("create ignored journal lock")
	}
	if _, err := other.ReadJournalFiles([]string{day.Doing[0].Path}); err == nil {
		t.Fatal("read exposed transaction")
	}
	lock()
	assertShuffleDisk(t, day, doingContents(day))
}

// The child holds a real OS lock, independently of App.fileMu and this process.
func TestMoveRespectsExternalFileLock(t *testing.T) {
	if path := os.Getenv("JM_TEST_LOCK_FILE"); path != "" {
		file, err := os.OpenFile(path, os.O_RDWR, 0)
		if err != nil {
			os.Exit(2)
		}
		if err := lockJournalHandle(file); err != nil {
			os.Exit(3)
		}
		os.Stdout.Write([]byte("locked\n"))
		var wait [1]byte
		os.Stdin.Read(wait[:])
		file.Close()
		return
	}
	app, day, _ := shuffleFixture(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestMoveRespectsExternalFileLock$")
	cmd.Env = append(os.Environ(), "JM_TEST_LOCK_FILE="+day.Doing[1].Path)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { in.Close(); cmd.Wait() }()
	ready := make([]byte, 7)
	if n, err := io.ReadFull(out, ready); err != nil || n != 7 || string(ready) != "locked\n" {
		t.Fatalf("lock helper: %q %v", ready, err)
	}
	if _, err := app.MoveDoingContents(day.Date, 3, 1, day.Doing); err == nil || !strings.Contains(err.Error(), "file lock") {
		t.Fatalf("move ignored external lock: %v", err)
	}
	if _, err := app.SaveFile(day.Doing[1].Path, "unsafe", day.Doing[1].Content, true); err == nil {
		t.Fatal("save ignored external lock")
	}
	assertShuffleDisk(t, day, doingContents(day))
	in.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.MoveDoingContents(day.Date, 3, 1, day.Doing); err != nil {
		t.Fatalf("could not retry after releasing lock: %v", err)
	}
}

func interruptedShuffle(t *testing.T, day DayData, root string) {
	t.Helper()
	recovery := doingMoveRecovery{}
	for i, file := range day.Doing {
		recovery.Entries = append(recovery.Entries, doingMoveEntry{file.Name, []byte(file.Content), []byte(day.Doing[(i+2)%3].Content), 0o600})
	}
	calls := 0
	err := commitDoingMove(root, recovery, func(path string, data []byte, mode os.FileMode) (*os.File, error) {
		calls++
		if calls == 2 {
			return nil, errors.New("injected write failure")
		}
		return replaceDoingFile(path, data, mode)
	})
	if err == nil {
		t.Fatal("expected partial write failure")
	}
	data, err := os.ReadFile(filepath.Join(root, reorderRecoveryName))
	if err != nil {
		t.Fatal(err)
	}
	var saved doingMoveRecovery
	if json.Unmarshal(data, &saved) != nil || !reflect.DeepEqual(saved, recovery) {
		t.Fatal("originals not durably preserved")
	}
}

func TestInterruptedMoveRecoversBeforeOpenOrSave(t *testing.T) {
	for _, op := range []string{"open", "read", "save", "create"} {
		t.Run(op, func(t *testing.T) {
			app, day, root := shuffleFixture(t)
			interruptedShuffle(t, day, root)
			restarted := newAppForPaths(app.homeDir, app.settingsPath)
			var err error
			switch op {
			case "open":
				_, err = restarted.OpenDay(day.Date)
			case "read":
				_, err = restarted.ReadJournalFiles([]string{day.Doing[0].Path})
			case "save":
				_, err = restarted.SaveFile(day.Doing[0].Path, day.Doing[0].Content, day.Doing[0].Content, false)
			case "create":
				_, err = restarted.CreateDoingStream(day.Date)
			}
			if err != nil {
				t.Fatal(err)
			}
			assertShuffleDisk(t, day, doingContents(day))
		})
	}
}

func TestRecoveryPreservesUnexpectedExternalEdits(t *testing.T) {
	app, day, root := shuffleFixture(t)
	interruptedShuffle(t, day, root)
	if err := os.WriteFile(day.Doing[1].Path, []byte("external edit"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := app.OpenDay(day.Date); err == nil || !strings.Contains(err.Error(), "originals are preserved") {
		t.Fatalf("unsafe recovery: %v", err)
	}
	assertShuffleDisk(t, day, []string{day.Doing[2].Content, "external edit", day.Doing[2].Content})
	if _, err := os.Stat(filepath.Join(root, reorderRecoveryName)); err != nil {
		t.Fatal("recovery originals lost")
	}
}

func TestMoveDoingSupportsGapsAndRejectsAmbiguousIndices(t *testing.T) {
	for _, ambiguous := range []bool{false, true} {
		app, day, _ := shuffleFixture(t)
		if ambiguous {
			duplicate := filepath.Join(filepath.Dir(day.Doing[0].Path), day.Date+"_1.jm.md")
			if err := os.WriteFile(duplicate, []byte("duplicate"), 0o600); err != nil {
				t.Fatal(err)
			}
		} else {
			if err := os.Rename(day.Doing[2].Path, filepath.Join(filepath.Dir(day.Doing[2].Path), day.Date+"_10.jm.md")); err != nil {
				t.Fatal(err)
			}
		}
		day, err := app.OpenDay(day.Date)
		if err != nil {
			t.Fatal(err)
		}
		moved, err := app.MoveDoingContents(day.Date, day.Doing[len(day.Doing)-1].StreamIndex, 1, day.Doing)
		if ambiguous {
			if err == nil {
				t.Fatal("duplicate stream index accepted")
			}
			assertShuffleDisk(t, day, doingContents(day))
		} else {
			if err != nil {
				t.Fatal(err)
			}
			if moved[2].StreamIndex != 10 {
				t.Fatal("gap was renumbered")
			}
			assertShuffleDisk(t, day, []string{day.Doing[2].Content, day.Doing[0].Content, day.Doing[1].Content})
		}
	}
}
