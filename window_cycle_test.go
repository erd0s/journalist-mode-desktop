package main

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"reflect"
	"testing"
)

type testJournalWindow struct {
	id      uint
	name    string
	actions *[]string
	focused *uint
}

func (w *testJournalWindow) ID() uint     { return w.id }
func (w *testJournalWindow) Name() string { return w.name }
func (w *testJournalWindow) Show() application.Window {
	*w.actions = append(*w.actions, "show")
	return nil
}
func (w *testJournalWindow) Restore() { *w.actions = append(*w.actions, "restore") }
func (w *testJournalWindow) Focus()   { *w.actions = append(*w.actions, "focus"); *w.focused = w.id }

func TestJournalWindowCycle(t *testing.T) {
	var actions []string
	var focused uint = 2
	windows := []journalWindow{
		&testJournalWindow{8, "day-third", &actions, &focused},
		&testJournalWindow{1, "welcome", &actions, &focused},
		&testJournalWindow{2, "day-first", &actions, &focused},
		&testJournalWindow{4, "settings", &actions, &focused},
		&testJournalWindow{5, "day-second", &actions, &focused},
	}
	for _, delta := range []int{1, -1} {
		focused = 2
		want := []uint{5, 8, 2, 5, 8, 2}
		if delta < 0 {
			want = []uint{8, 5, 2, 8, 5, 2}
		}
		for _, id := range want {
			actions = nil
			cycleJournalWindow(windows, focused, delta)
			if focused != id {
				t.Fatalf("delta %d: focused %d, want %d", delta, focused, id)
			}
			if !reflect.DeepEqual(actions, []string{"show", "restore", "focus"}) {
				t.Fatalf("must focus exactly one target: %v", actions)
			}
		}
	}
	// Removing a window does not leave a stale entry in the cycle.
	cycleJournalWindow(windows[:3], 2, 1)
	if focused != 8 {
		t.Fatalf("closed window was retained: %d", focused)
	}
	cycleJournalWindow(windows, 4, -1)
	if focused != 8 {
		t.Fatalf("reverse from settings must select last journal: %d", focused)
	}
	cycleJournalWindow(windows[1:2], 1, 1) // No days.
	if focused != 8 {
		t.Fatal("cycled a non-journal window")
	}
	cycleJournalWindow(windows[2:3], 2, 1) // One day.
	if focused != 2 {
		t.Fatal("single journal cycle did not stay on that journal")
	}
}

func TestWindowCycleMenuAccelerators(t *testing.T) {
	menu := application.NewMenu()
	addWindowCycleItems(menu, func(int) {})
	for _, spec := range []menuShortcut{
		{"Next Journal Window", "CmdOrCtrl+`"},
		{"Previous Journal Window", "CmdOrCtrl+Shift+`"},
	} {
		item := menu.FindByLabel(spec.label)
		if item == nil || item.Hidden() {
			t.Fatalf("missing visible menu item %s", spec.label)
		}
		expected := application.NewMenuItem("reference").SetAccelerator(spec.accelerator).GetAccelerator()
		if !reflect.DeepEqual(item.GetAccelerator(), expected) {
			t.Fatalf("wrong shortcut for %s", spec.label)
		}
	}
}
