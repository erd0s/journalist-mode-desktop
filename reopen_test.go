package main

import (
	"reflect"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Embed the remaining Window methods so unexpected calls (such as Restore,
// which would exit fullscreen) fail instead of silently succeeding.
type reopenTestWindow struct {
	application.Window
	id        uint
	minimised bool
	calls     []string
}

func (w *reopenTestWindow) ID() uint          { return w.id }
func (w *reopenTestWindow) IsMinimised() bool { return w.minimised }
func (w *reopenTestWindow) UnMinimise() {
	w.calls = append(w.calls, "unminimise")
	w.minimised = false
}
func (w *reopenTestWindow) Show() application.Window {
	w.calls = append(w.calls, "show")
	return w
}
func (w *reopenTestWindow) Focus() { w.calls = append(w.calls, "focus") }

func TestReopenWithoutWindowsNeedsWelcome(t *testing.T) {
	for _, current := range []application.Window{nil, &reopenTestWindow{id: 99}} {
		if focusReopenWindow(nil, current) {
			t.Fatal("reopen claimed to focus a window when none exist")
		}
	}
}

func TestReopenFocusesOneExistingWindow(t *testing.T) {
	for _, test := range []struct {
		name      string
		currentID uint
		wantID    uint
	}{
		{"current window", 7, 7},
		{"no current window", 0, 2},
		{"closed current window", 99, 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, order := range [][]uint{{7, 2, 5}, {5, 7, 2}, {2, 5, 7}} {
				var windows []application.Window
				for _, id := range order {
					windows = append(windows, &reopenTestWindow{id: id})
				}
				var current application.Window
				if test.currentID != 0 {
					current = &reopenTestWindow{id: test.currentID}
				}
				for launch := 0; launch < 3; launch++ {
					if !focusReopenWindow(windows, current) {
						t.Fatal("existing windows must prevent a new welcome window")
					}
				}
				for _, window := range windows {
					w := window.(*reopenTestWindow)
					var want []string
					if w.id == test.wantID {
						want = []string{"show", "focus", "show", "focus", "show", "focus"}
					}
					if !reflect.DeepEqual(w.calls, want) {
						t.Fatalf("order %v: window %d calls = %v, want %v", order, w.id, w.calls, want)
					}
				}
			}
		})
	}
}

func TestReopenUnminimisesBeforeFocusing(t *testing.T) {
	w := &reopenTestWindow{id: 1, minimised: true}
	if !focusReopenWindow([]application.Window{w}, nil) {
		t.Fatal("a minimised window must prevent a new welcome window")
	}
	if want := []string{"unminimise", "show", "focus"}; !reflect.DeepEqual(w.calls, want) {
		t.Fatalf("calls = %v, want %v", w.calls, want)
	}
	if w.minimised {
		t.Fatal("window remains minimised")
	}
}
