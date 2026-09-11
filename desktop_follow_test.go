package main

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Captured from SLSCopyManagedDisplaySpaces on macOS 26.6.2 with nine desktops.
// Array order is Mission Control order: Desktop 9 has the lowest id.
const capturedSnapshot = `{"displays":[{"Current Space":{"ManagedSpaceID":3,"id64":3,"type":0,"uuid":"A"},
"Display Identifier":"7C504783-1A60-4DB4-907C-AB0C62316570",
"Spaces":[{"ManagedSpaceID":3,"id64":3,"type":0,"uuid":"A"},{"ManagedSpaceID":5,"id64":5,"type":0,"uuid":"B"},
{"ManagedSpaceID":6,"id64":6,"type":0,"uuid":"C"},{"ManagedSpaceID":7,"id64":7,"type":0,"uuid":"D"},
{"ManagedSpaceID":8,"id64":8,"type":0,"uuid":"E"},{"ManagedSpaceID":9,"id64":9,"type":0,"uuid":"F"},
{"ManagedSpaceID":10,"id64":10,"type":0,"uuid":"G"},{"ManagedSpaceID":11,"id64":11,"type":0,"uuid":"H"},
{"ManagedSpaceID":4,"id64":4,"type":0,"uuid":"I"}]}]}`

func TestParseSpaceSnapshotReadsCapturedShape(t *testing.T) {
	snapshot, err := parseSpaceSnapshot([]byte(capturedSnapshot))
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Displays) != 1 || snapshot.Displays[0].Current != 3 || len(snapshot.Displays[0].Spaces) != 9 {
		t.Fatalf("unexpected snapshot: %#v", snapshot)
	}
	numbers := desktopNumbers(snapshot)
	if numbers[3] != 1 || numbers[10] != 7 || numbers[4] != 9 {
		t.Fatalf("desktop numbers must follow array order: %v", numbers)
	}
}

func TestParseSpaceSnapshotRejectsBadShapes(t *testing.T) {
	for name, payload := range map[string]string{
		"not json":           `{`,
		"reported error":     `{"error":"SLSCopyManagedDisplaySpaces returned no data"}`,
		"no displays":        `{"displays":[]}`,
		"no identifier":      `{"displays":[{"Current Space":{"id64":1},"Spaces":[{"id64":1,"type":0}]}]}`,
		"no current":         `{"displays":[{"Display Identifier":"D","Spaces":[{"id64":1,"type":0}]}]}`,
		"no spaces":          `{"displays":[{"Display Identifier":"D","Current Space":{"id64":1}}]}`,
		"space without type": `{"displays":[{"Display Identifier":"D","Current Space":{"id64":1},"Spaces":[{"id64":1}]}]}`,
		"only collapsed":     `{"displays":[{"Display Identifier":"D","Collapsed Space":{"id64":1,"type":0}}]}`,
	} {
		if _, err := parseSpaceSnapshot([]byte(payload)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	if _, err := parseSpaceSnapshot([]byte(`{"error":"custom reason"}`)); err == nil || !strings.Contains(err.Error(), "custom reason") {
		t.Fatalf("reported error must be preserved: %v", err)
	}
}

func TestParseSpaceSnapshotSkipsCollapsedDisplays(t *testing.T) {
	payload := `{"displays":[{"Display Identifier":"D","Current Space":{"id64":1},"Spaces":[{"id64":1,"type":0}]},
{"Display Identifier":"Gone","Collapsed Space":{"id64":9,"type":0}}]}`
	snapshot, err := parseSpaceSnapshot([]byte(payload))
	if err != nil || len(snapshot.Displays) != 1 || snapshot.Displays[0].ID != "D" {
		t.Fatalf("disconnected display must not take part: %#v %v", snapshot, err)
	}
}

func twoDisplays(currentA, currentB uint64) *spaceSnapshot {
	return &spaceSnapshot{Displays: []displaySpaces{
		{ID: "A", Current: currentA, Spaces: []managedSpace{{1, 0}, {2, 0}, {100, 4}, {3, 0}}},
		{ID: "B", Current: currentB, Spaces: []managedSpace{{4, 0}, {5, 0}}},
	}}
}

func TestDesktopNumbersSkipFullScreenAndContinueAcrossDisplays(t *testing.T) {
	numbers := desktopNumbers(*twoDisplays(1, 4))
	want := map[uint64]int{1: 1, 2: 2, 3: 3, 4: 4, 5: 5}
	if len(numbers) != len(want) {
		t.Fatalf("full-screen space must take no number: %v", numbers)
	}
	for id, desktop := range want {
		if numbers[id] != desktop {
			t.Fatalf("space %d numbered %d, want %d", id, numbers[id], desktop)
		}
	}
	if _, err := currentDesktop(displaySpaces{ID: "A", Current: 42, Spaces: []managedSpace{{1, 0}}}, numbers); err == nil {
		t.Fatal("a current space missing from its list must be an error")
	}
}

func TestDesktopChangeDetection(t *testing.T) {
	for name, test := range map[string]struct {
		previous, next *spaceSnapshot
		desktop        int
		changed        bool
	}{
		"baseline":                {nil, twoDisplays(1, 4), 0, false},
		"no change":               {twoDisplays(1, 4), twoDisplays(1, 4), 0, false},
		"first display switches":  {twoDisplays(1, 4), twoDisplays(3, 4), 3, true},
		"second display switches": {twoDisplays(1, 4), twoDisplays(1, 5), 5, true},
		"full-screen destination": {twoDisplays(1, 4), twoDisplays(100, 4), 0, false},
		"back from full screen":   {twoDisplays(100, 4), twoDisplays(1, 4), 1, true},
		"two displays switch":     {twoDisplays(1, 4), twoDisplays(2, 5), 0, false},
		"display set changed": {twoDisplays(1, 4), &spaceSnapshot{Displays: []displaySpaces{
			{ID: "A", Current: 2, Spaces: []managedSpace{{1, 0}, {2, 0}}}}}, 0, false},
		"renumbered without switching": {twoDisplays(2, 4), &spaceSnapshot{Displays: []displaySpaces{
			{ID: "A", Current: 2, Spaces: []managedSpace{{7, 0}, {1, 0}, {2, 0}, {3, 0}}},
			{ID: "B", Current: 4, Spaces: []managedSpace{{4, 0}, {5, 0}}}}}, 0, false},
	} {
		display, desktop, changed, err := desktopChange(test.previous, test.next)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if desktop != test.desktop || changed != test.changed {
			t.Fatalf("%s: got desktop %d changed %v, want %d %v", name, desktop, changed, test.desktop, test.changed)
		}
		if changed && display != map[int]string{3: "A", 5: "B", 1: "A"}[desktop] {
			t.Fatalf("%s: changed display %q", name, display)
		}
	}
	if _, _, _, err := desktopChange(twoDisplays(1, 4), twoDisplays(77, 4)); err == nil {
		t.Fatal("switching to a space missing from the list must be an error")
	}
}

type followerHarness struct {
	snapshots  []string
	dispatched []string
	reported   []string
	follower   *desktopFollower
}

func newFollowerHarness() *followerHarness {
	h := &followerHarness{}
	h.follower = newDesktopFollower(
		func() ([]byte, error) {
			if len(h.snapshots) == 0 {
				return nil, errors.New("no snapshot available")
			}
			return []byte(h.snapshots[len(h.snapshots)-1]), nil
		},
		func(desktop int, sequence uint64) {
			h.dispatched = append(h.dispatched, fmt.Sprintf("%d@%d", desktop, sequence))
		},
		func(err error) {
			if err == nil {
				h.reported = append(h.reported, "recovered")
				return
			}
			h.reported = append(h.reported, err.Error())
		},
	)
	return h
}

func display(current uint64, order ...uint64) string {
	spaces := ""
	for i, id := range order {
		if i > 0 {
			spaces += ","
		}
		spaces += fmt.Sprintf(`{"id64":%d,"type":0}`, id)
	}
	return fmt.Sprintf(`{"displays":[{"Display Identifier":"D","Current Space":{"id64":%d},"Spaces":[%s]}]}`, current, spaces)
}

func TestDesktopFollowerFollowsRenumberedDesktops(t *testing.T) {
	// Reordering or removing desktops posts no Space change, so the next real
	// switch must use the new numbering even when the number repeats.
	h := newFollowerHarness()
	h.snapshots = append(h.snapshots, display(3, 1, 2, 3))
	if err := h.follower.start(); err != nil {
		t.Fatal(err)
	}
	if err := h.follower.setEnabled(true); err != nil {
		t.Fatal(err)
	}
	h.follower.submit([]byte(display(3, 3, 1, 2))) // Dragged to the front: still on the same space, now Desktop 1.
	h.follower.process()
	h.follower.submit([]byte(display(2, 3, 1, 2))) // Switch to id 2, which Mission Control now labels Desktop 3.
	h.follower.process()
	if want := []string{"3@1"}; !reflect.DeepEqual(h.dispatched, want) {
		t.Fatalf("reorder: dispatched %v, want %v", h.dispatched, want)
	}
	h.follower.submit([]byte(display(2, 3, 2))) // Desktop id 1 removed while on id 2 (now Desktop 2).
	h.follower.process()
	h.follower.submit([]byte(display(3, 3, 2))) // Switch to id 3, now Desktop 1.
	h.follower.process()
	if want := []string{"3@1", "1@2"}; !reflect.DeepEqual(h.dispatched, want) {
		t.Fatalf("removal: dispatched %v, want %v", h.dispatched, want)
	}
}

func TestDesktopFollowerReportsRecovery(t *testing.T) {
	h := newFollowerHarness()
	h.snapshots = append(h.snapshots, oneDisplay(1))
	if err := h.follower.start(); err != nil {
		t.Fatal(err)
	}
	if err := h.follower.setEnabled(true); err != nil {
		t.Fatal(err)
	}
	h.follower.submit([]byte(oneDisplay(2)))
	h.follower.process()
	h.follower.submit([]byte(`{"error":"broken"}`))
	h.follower.process()
	h.follower.submit([]byte(oneDisplay(3)))
	h.follower.process()
	h.follower.submit([]byte(oneDisplay(1)))
	h.follower.process()
	if want := []string{"broken", "recovered"}; !reflect.DeepEqual(h.reported, want) {
		t.Fatalf("recovery must be reported once after a failure: %v", h.reported)
	}
	if want := []string{"2@1", "3@2", "1@3"}; !reflect.DeepEqual(h.dispatched, want) {
		t.Fatalf("dispatched %v, want %v", h.dispatched, want)
	}
}

func TestDesktopFollowerRunDeliversConcurrentSubmissions(t *testing.T) {
	h := newFollowerHarness()
	h.snapshots = append(h.snapshots, oneDisplay(1))
	var mu sync.Mutex
	dispatched := make(chan string, 16)
	h.follower.dispatch = func(desktop int, sequence uint64) {
		mu.Lock()
		defer mu.Unlock()
		dispatched <- fmt.Sprintf("%d@%d", desktop, sequence)
	}
	if err := h.follower.start(); err != nil {
		t.Fatal(err)
	}
	if err := h.follower.setEnabled(true); err != nil {
		t.Fatal(err)
	}
	go h.follower.run()
	h.follower.submit([]byte(oneDisplay(2)))
	first := <-dispatched
	h.follower.submit([]byte(oneDisplay(3)))
	second := <-dispatched
	if first != "2@1" || second != "3@2" {
		t.Fatalf("run delivered %s then %s", first, second)
	}
	close(h.follower.signal)
}

func oneDisplay(current uint64) string {
	return fmt.Sprintf(`{"displays":[{"Display Identifier":"D","Current Space":{"id64":%d},"Spaces":[{"id64":1,"type":0},{"id64":2,"type":0},{"id64":3,"type":0},{"id64":9,"type":4}]}]}`, current)
}

func TestDesktopFollowerDispatchesOnlyWhileEnabled(t *testing.T) {
	h := newFollowerHarness()
	h.snapshots = append(h.snapshots, oneDisplay(1))
	if err := h.follower.start(); err != nil {
		t.Fatal(err)
	}
	h.follower.submit([]byte(oneDisplay(2)))
	h.follower.process()
	if len(h.dispatched) != 0 {
		t.Fatalf("disabled follower dispatched %v", h.dispatched)
	}
	h.snapshots = append(h.snapshots, oneDisplay(2))
	if err := h.follower.setEnabled(true); err != nil {
		t.Fatal(err)
	}
	h.follower.submit([]byte(oneDisplay(2))) // Same desktop as the baseline.
	h.follower.process()
	if len(h.dispatched) != 0 {
		t.Fatalf("baseline must not dispatch: %v", h.dispatched)
	}
	h.follower.submit([]byte(oneDisplay(3)))
	h.follower.process()
	h.follower.submit([]byte(oneDisplay(3)))
	h.follower.process()
	h.follower.submit([]byte(oneDisplay(9))) // Full screen: no numbered desktop.
	h.follower.process()
	h.follower.submit([]byte(oneDisplay(3))) // Back to the same desktop is not a desktop change.
	h.follower.process()
	h.follower.submit([]byte(oneDisplay(9)))
	h.follower.process()
	h.follower.submit([]byte(oneDisplay(1))) // Full screen to a different desktop is.
	h.follower.process()
	if want := []string{"3@1", "1@2"}; !reflect.DeepEqual(h.dispatched, want) {
		t.Fatalf("dispatched %v, want %v", h.dispatched, want)
	}
	if len(h.reported) != 0 {
		t.Fatalf("unexpected errors: %v", h.reported)
	}
}

func TestDesktopFollowerCoalescesAndDrainsOnDisable(t *testing.T) {
	h := newFollowerHarness()
	h.snapshots = append(h.snapshots, oneDisplay(1))
	if err := h.follower.start(); err != nil {
		t.Fatal(err)
	}
	if err := h.follower.setEnabled(true); err != nil {
		t.Fatal(err)
	}
	h.follower.submit([]byte(oneDisplay(2)))
	h.follower.submit([]byte(oneDisplay(3))) // Rapid: only the latest is delivered.
	if !h.follower.process() {
		t.Fatal("a pending signal must be processed")
	}
	if want := []string{"3@1"}; !reflect.DeepEqual(h.dispatched, want) {
		t.Fatalf("dispatched %v, want %v", h.dispatched, want)
	}
	h.follower.submit([]byte(oneDisplay(1)))
	if err := h.follower.setEnabled(false); err != nil {
		t.Fatal(err)
	}
	if h.follower.process() {
		t.Fatal("disabling must drain the pending change")
	}
	if len(h.dispatched) != 1 {
		t.Fatalf("queued change delivered after disable: %v", h.dispatched)
	}
	h.snapshots = append(h.snapshots, oneDisplay(1))
	if err := h.follower.setEnabled(true); err != nil {
		t.Fatal(err)
	}
	h.follower.submit([]byte(oneDisplay(2)))
	h.follower.process()
	if want := []string{"3@1", "2@2"}; !reflect.DeepEqual(h.dispatched, want) {
		t.Fatalf("re-enabled follower must continue the sequence: %v", h.dispatched)
	}
}

func TestDesktopFollowerReportsErrors(t *testing.T) {
	h := newFollowerHarness()
	if err := h.follower.setEnabled(true); err != nil {
		t.Fatalf("enabling before the monitor starts must wait for start: %v", err)
	}
	if err := h.follower.start(); err == nil {
		t.Fatal("start with an unavailable snapshot must fail")
	}
	h.snapshots = append(h.snapshots, oneDisplay(1))
	if err := h.follower.setEnabled(false); err != nil {
		t.Fatal(err)
	}
	if err := h.follower.setEnabled(true); err != nil {
		t.Fatal(err)
	}
	// The failed start was returned to its caller; a later good baseline
	// reports recovery so the caller can clear what it showed.
	if want := []string{"recovered"}; !reflect.DeepEqual(h.reported, want) {
		t.Fatalf("recovery after a failed start must be reported: %v", h.reported)
	}
	h.follower.submit([]byte(`{"error":"SLSCopyManagedDisplaySpaces returned no data"}`))
	h.follower.process()
	if len(h.reported) != 2 || !strings.Contains(h.reported[1], "returned no data") {
		t.Fatalf("parse errors must be reported: %v", h.reported)
	}
	h.follower.submit([]byte(oneDisplay(2)))
	h.follower.process()
	if want := []string{"2@1"}; !reflect.DeepEqual(h.dispatched, want) {
		t.Fatalf("a reported error must not stop later changes: %v", h.dispatched)
	}
}

// Any window method other than Name, ID and DispatchWailsEvent panics through
// the nil embedded interface, so a Show or Focus call fails the test.
type followTestWindow struct {
	application.Window
	name   string
	events []*application.CustomEvent
}

func (w *followTestWindow) Name() string { return w.name }
func (w *followTestWindow) ID() uint     { return 1 }
func (w *followTestWindow) DispatchWailsEvent(event *application.CustomEvent) {
	w.events = append(w.events, event)
}

func TestDesktopChangeTargetsOnlyTodaysWindow(t *testing.T) {
	today := &followTestWindow{name: "day-2026-09-11"}
	windows := []application.Window{
		&followTestWindow{name: "welcome"},
		&followTestWindow{name: "day-2026-09-10"},
		today,
		&followTestWindow{name: "settings"},
	}
	if desktopChangeTarget(windows, "2026-09-11") != today {
		t.Fatal("today's window must be the target")
	}
	if desktopChangeTarget(windows, "2026-09-12") != nil {
		t.Fatal("a missing day window must yield no target")
	}
	dispatchToWindow(today, "desktop:changed", map[string]any{"desktop": 7, "sequence": uint64(3)})
	if len(today.events) != 1 || today.events[0].Name != "desktop:changed" {
		t.Fatalf("unexpected events: %#v", today.events)
	}
}

func TestDesktopFollowerBaselineResetsWithoutDispatch(t *testing.T) {
	h := newFollowerHarness()
	h.snapshots = append(h.snapshots, oneDisplay(1))
	if err := h.follower.start(); err != nil {
		t.Fatal(err)
	}
	if err := h.follower.setEnabled(true); err != nil {
		t.Fatal(err)
	}
	// Waking from sleep on another desktop re-baselines instead of following.
	h.follower.submitBaseline([]byte(oneDisplay(3)))
	h.follower.submit([]byte(oneDisplay(3)))
	h.follower.process()
	if len(h.dispatched) != 0 {
		t.Fatalf("baseline must not dispatch: %v", h.dispatched)
	}
	h.follower.submit([]byte(oneDisplay(2)))
	h.follower.process()
	if want := []string{"2@1"}; !reflect.DeepEqual(h.dispatched, want) {
		t.Fatalf("dispatched %v, want %v", h.dispatched, want)
	}
	// A queued change is dropped by a later baseline.
	h.follower.submit([]byte(oneDisplay(1)))
	h.follower.submitBaseline([]byte(oneDisplay(1)))
	if h.follower.process() {
		t.Fatal("baseline must drain the queued change")
	}
	if len(h.dispatched) != 1 {
		t.Fatalf("queued change delivered after baseline: %v", h.dispatched)
	}
	h.follower.submitBaseline([]byte(`{"error":"broken"}`))
	if len(h.reported) != 1 || !strings.Contains(h.reported[0], "broken") {
		t.Fatalf("a bad baseline must be reported: %v", h.reported)
	}
}

func TestDesktopFollowerTracksLastNumberedDesktopPerDisplay(t *testing.T) {
	h := newFollowerHarness()
	two := func(a, b uint64) string {
		return fmt.Sprintf(`{"displays":[{"Display Identifier":"A","Current Space":{"id64":%d},"Spaces":[{"id64":1,"type":0},{"id64":2,"type":0},{"id64":100,"type":4}]},{"Display Identifier":"B","Current Space":{"id64":%d},"Spaces":[{"id64":4,"type":0},{"id64":5,"type":0}]}]}`, a, b)
	}
	h.snapshots = append(h.snapshots, two(1, 4))
	if err := h.follower.start(); err != nil {
		t.Fatal(err)
	}
	if err := h.follower.setEnabled(true); err != nil {
		t.Fatal(err)
	}
	for _, payload := range []string{two(100, 4), two(100, 5), two(1, 5), two(2, 5)} {
		h.follower.submit([]byte(payload))
		h.follower.process()
	}
	// Display A: 1 -> full screen (ignored) -> back to 1 (same) -> 2. Display B: 4 -> 5.
	if want := []string{"4@1", "2@2"}; !reflect.DeepEqual(h.dispatched, want) {
		t.Fatalf("dispatched %v, want %v", h.dispatched, want)
	}
}
