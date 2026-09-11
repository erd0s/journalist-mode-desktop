# Follow Mission Control desktops: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the new "Follow macOS desktop" setting is on, a Mission Control desktop change selects and zooms the matching Doing pane in today's journal window without touching native window focus.

**Architecture:** An Objective-C observer serialises the private `SLSCopyManagedDisplaySpaces` array to JSON on every Space-change notification. A platform-independent Go follower parses it, numbers desktops, detects which display changed, and dispatches `desktop:changed` to today's day window. The frontend maps that to an idempotent "focus and ensure zoomed" workspace action.

**Tech Stack:** Go 1.25 with cgo, Wails v3.0.0-beta.8, Objective-C (Cocoa, SkyLight via dlopen), React 18, TypeScript, Vitest with jsdom.

**Spec:** `docs/superpowers/specs/2026-09-11-follow-desktop-design.md`

> **Revision after adversarial review (2026-09-11):** the implementation differs from the task text below in these ways: `desktopChange` also returns the changed display and the follower keeps the last numbered desktop per display, so returning from a full-screen Space to the same desktop is not a change; wake and display-parameter notifications publish baselines through `submitBaseline`; `App` guards settings reads and the enable-then-write in `SaveSettings` with `settingsMu`; the launch-time `menu:error` broadcast is replaced by the `GetFollowDesktopStatus` binding shown in Settings and day windows; snapshot errors go to today's window or every window; and an unresolved file conflict no longer defers a change. A second review of the code added Space-identity suppression (`lastSpace`), recovery reporting through `report(nil)`, the last observation error in `GetFollowDesktopStatus`, an autorelease pool in the Objective-C snapshot, a switch that can always be turned off, and pending targets while the day window opens. The spec's "Review outcomes" section lists the reasoning.

## Global Constraints

- Never call `Show`, `Focus`, `UnMinimise`, `Restore` or `SetAlwaysOnTop` from the desktop-follow path. Only `Name`, `ID` and `DispatchWailsEvent` may be called on the target window.
- No silent fallbacks: every failure of the private API is surfaced to the user through the existing error banner (`menu:error`) or a failed settings save.
- Keep the README checks green: `go test -race ./...`, `go vet ./...`, `npm test --prefix frontend`, `npm run build --prefix frontend`.
- Commit after each task on branch `feature/follow-desktop`, message ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Any keyboard, mouse, focus or desktop-switch input on this Mac requires `/private/tmp/claude-501/screen-lock.sh acquire journalist-mode-desktop-82 "<purpose>" <minutes>` first and `release` afterwards.

---

### Task 1: Snapshot parsing, desktop numbering and change detection

**Files:**
- Create: `desktop_follow.go`
- Test: `desktop_follow_test.go`

**Interfaces:**
- Produces: `type managedSpace struct{ID uint64; Type int}`, `type displaySpaces struct{ID string; Current uint64; Spaces []managedSpace}`, `type spaceSnapshot struct{Displays []displaySpaces}`, `parseSpaceSnapshot([]byte) (spaceSnapshot, error)`, `desktopNumbers(spaceSnapshot) map[uint64]int`, `currentDesktop(displaySpaces, map[uint64]int) (int, error)`, `desktopChange(previous, next *spaceSnapshot) (desktop int, changed bool, err error)`.

- [ ] **Step 1: Write the failing tests**

```go
package main

import (
	"strings"
	"testing"
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
		"not json":          `{`,
		"reported error":    `{"error":"SLSCopyManagedDisplaySpaces returned no data"}`,
		"no displays":       `{"displays":[]}`,
		"no identifier":     `{"displays":[{"Current Space":{"id64":1},"Spaces":[{"id64":1,"type":0}]}]}`,
		"no current":        `{"displays":[{"Display Identifier":"D","Spaces":[{"id64":1,"type":0}]}]}`,
		"no spaces":         `{"displays":[{"Display Identifier":"D","Current Space":{"id64":1}}]}`,
		"space without type": `{"displays":[{"Display Identifier":"D","Current Space":{"id64":1},"Spaces":[{"id64":1}]}]}`,
		"only collapsed":    `{"displays":[{"Display Identifier":"D","Collapsed Space":{"id64":1,"type":0}}]}`,
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
		desktop, changed, err := desktopChange(test.previous, test.next)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if desktop != test.desktop || changed != test.changed {
			t.Fatalf("%s: got desktop %d changed %v, want %d %v", name, desktop, changed, test.desktop, test.changed)
		}
	}
	if _, _, err := desktopChange(twoDisplays(1, 4), twoDisplays(77, 4)); err == nil {
		t.Fatal("switching to a space missing from the list must be an error")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/dirk/Dev/journalist-mode-follow-desktop && go test ./... -run 'SpaceSnapshot|DesktopNumbers|DesktopChange' 2>&1 | grep -v "ld: warning" | tail -5`
Expected: build failure, `undefined: parseSpaceSnapshot`.

- [ ] **Step 3: Implement**

```go
package main

import (
	"encoding/json"
	"errors"
	"fmt"
)

// managedSpace is one Mission Control Space. Type 0 is a user desktop; other
// types (4 in practice) are full-screen or tiled application Spaces.
type managedSpace struct {
	ID   uint64
	Type int
}

type displaySpaces struct {
	ID      string
	Current uint64
	Spaces  []managedSpace
}

// spaceSnapshot is the ordered per-display Space list at one moment.
type spaceSnapshot struct {
	Displays []displaySpaces
}

type rawManagedSpace struct {
	ID   *uint64 `json:"id64"`
	Type *int    `json:"type"`
}

type rawManagedDisplay struct {
	Identifier *string           `json:"Display Identifier"`
	Current    *rawManagedSpace  `json:"Current Space"`
	Collapsed  *rawManagedSpace  `json:"Collapsed Space"`
	Spaces     []rawManagedSpace `json:"Spaces"`
}

type rawSpaceSnapshot struct {
	Error    string              `json:"error"`
	Displays []rawManagedDisplay `json:"displays"`
}

// parseSpaceSnapshot decodes the JSON form of the SLSCopyManagedDisplaySpaces
// array. A display that only carries a "Collapsed Space" is disconnected and
// takes no part; every other shape problem is an error naming the gap.
func parseSpaceSnapshot(data []byte) (spaceSnapshot, error) {
	var raw rawSpaceSnapshot
	if err := json.Unmarshal(data, &raw); err != nil {
		return spaceSnapshot{}, fmt.Errorf("decode desktop snapshot: %w", err)
	}
	if raw.Error != "" {
		return spaceSnapshot{}, errors.New(raw.Error)
	}
	if len(raw.Displays) == 0 {
		return spaceSnapshot{}, errors.New("desktop snapshot lists no displays")
	}
	var snapshot spaceSnapshot
	for index, display := range raw.Displays {
		if display.Current == nil && display.Spaces == nil && display.Collapsed != nil {
			continue
		}
		if display.Identifier == nil {
			return spaceSnapshot{}, fmt.Errorf("display %d has no Display Identifier", index)
		}
		if display.Current == nil || display.Current.ID == nil {
			return spaceSnapshot{}, fmt.Errorf("display %s has no Current Space id64", *display.Identifier)
		}
		if len(display.Spaces) == 0 {
			return spaceSnapshot{}, fmt.Errorf("display %s has no Spaces", *display.Identifier)
		}
		entry := displaySpaces{ID: *display.Identifier, Current: *display.Current.ID}
		for position, space := range display.Spaces {
			if space.ID == nil || space.Type == nil {
				return spaceSnapshot{}, fmt.Errorf("display %s space %d lacks id64 or type", entry.ID, position)
			}
			entry.Spaces = append(entry.Spaces, managedSpace{ID: *space.ID, Type: *space.Type})
		}
		snapshot.Displays = append(snapshot.Displays, entry)
	}
	if len(snapshot.Displays) == 0 {
		return spaceSnapshot{}, errors.New("desktop snapshot has no connected display")
	}
	return snapshot, nil
}

// desktopNumbers assigns Mission Control "Desktop N" numbers: user desktops
// only, in array order, continuing from one display to the next.
func desktopNumbers(snapshot spaceSnapshot) map[uint64]int {
	numbers := make(map[uint64]int)
	next := 1
	for _, display := range snapshot.Displays {
		for _, space := range display.Spaces {
			if space.Type == 0 {
				numbers[space.ID] = next
				next++
			}
		}
	}
	return numbers
}

// currentDesktop returns 0 for a full-screen Space, which has no number.
func currentDesktop(display displaySpaces, numbers map[uint64]int) (int, error) {
	for _, space := range display.Spaces {
		if space.ID == display.Current {
			return numbers[space.ID], nil
		}
	}
	return 0, fmt.Errorf("display %s: current space %d is not in its space list", display.ID, display.Current)
}

// desktopChange reports the destination desktop when exactly one display's
// current Space changed. A missing baseline, a changed display set, several
// displays changing at once, or a full-screen destination is not a change.
func desktopChange(previous, next *spaceSnapshot) (int, bool, error) {
	if previous == nil || len(previous.Displays) != len(next.Displays) {
		return 0, false, nil
	}
	before := make(map[string]displaySpaces, len(previous.Displays))
	for _, display := range previous.Displays {
		before[display.ID] = display
	}
	changed := -1
	for index, display := range next.Displays {
		earlier, known := before[display.ID]
		if !known {
			return 0, false, nil
		}
		if earlier.Current == display.Current {
			continue
		}
		if changed >= 0 {
			return 0, false, nil
		}
		changed = index
	}
	if changed < 0 {
		return 0, false, nil
	}
	desktop, err := currentDesktop(next.Displays[changed], desktopNumbers(*next))
	if err != nil {
		return 0, false, err
	}
	return desktop, desktop > 0, nil
}
```

- [ ] **Step 4: Run the tests**

Run: `go test ./... -run 'SpaceSnapshot|DesktopNumbers|DesktopChange' 2>&1 | grep -v "ld: warning" | tail -3`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add desktop_follow.go desktop_follow_test.go
git commit -m "Parse Mission Control Space snapshots and detect desktop changes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The follower state machine

**Files:**
- Modify: `desktop_follow.go`
- Test: `desktop_follow_test.go`

**Interfaces:**
- Produces: `type desktopFollower struct`, `newDesktopFollower(snapshot func() ([]byte, error), dispatch func(desktop int, sequence uint64), report func(error)) *desktopFollower`, methods `submit([]byte)`, `run()`, `process() bool`, `setEnabled(bool) error`, `start() error`.

- [ ] **Step 1: Write the failing tests**

```go
type followerHarness struct {
	snapshots  []string
	dispatched []string
	reported   []string
	follower   *desktopFollower
}

func newFollowerHarness(t *testing.T) *followerHarness {
	h := &followerHarness{}
	h.follower = newDesktopFollower(
		func() ([]byte, error) {
			if len(h.snapshots) == 0 {
				return nil, errors.New("no snapshot available")
			}
			return []byte(h.snapshots[len(h.snapshots)-1]), nil
		},
		func(desktop int, sequence uint64) { h.dispatched = append(h.dispatched, fmt.Sprintf("%d@%d", desktop, sequence)) },
		func(err error) { h.reported = append(h.reported, err.Error()) },
	)
	return h
}

func oneDisplay(current uint64) string {
	return fmt.Sprintf(`{"displays":[{"Display Identifier":"D","Current Space":{"id64":%d},"Spaces":[{"id64":1,"type":0},{"id64":2,"type":0},{"id64":3,"type":0},{"id64":9,"type":4}]}]}`, current)
}

func TestDesktopFollowerDispatchesOnlyWhileEnabled(t *testing.T) {
	h := newFollowerHarness(t)
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
	h.follower.submit([]byte(oneDisplay(9))) // Full screen.
	h.follower.process()
	h.follower.submit([]byte(oneDisplay(3))) // Back to the same desktop is a real change.
	h.follower.process()
	if want := []string{"3@1", "3@2"}; !reflect.DeepEqual(h.dispatched, want) {
		t.Fatalf("dispatched %v, want %v", h.dispatched, want)
	}
	if len(h.reported) != 0 {
		t.Fatalf("unexpected errors: %v", h.reported)
	}
}

func TestDesktopFollowerCoalescesAndDrainsOnDisable(t *testing.T) {
	h := newFollowerHarness(t)
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
	h := newFollowerHarness(t)
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
	h.follower.submit([]byte(`{"error":"SLSCopyManagedDisplaySpaces returned no data"}`))
	h.follower.process()
	if len(h.reported) != 1 || !strings.Contains(h.reported[0], "returned no data") {
		t.Fatalf("parse errors must be reported: %v", h.reported)
	}
	h.follower.submit([]byte(oneDisplay(2)))
	h.follower.process()
	if want := []string{"2@1"}; !reflect.DeepEqual(h.dispatched, want) {
		t.Fatalf("a reported error must not stop later changes: %v", h.dispatched)
	}
}
```

Add `"errors"`, `"fmt"`, `"reflect"` to the test imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./... -run DesktopFollower 2>&1 | grep -v "ld: warning" | tail -5`
Expected: `undefined: newDesktopFollower`.

- [ ] **Step 3: Implement** (append to `desktop_follow.go`; add `"sync"` and `"sync/atomic"` imports)

```go
// desktopFollower turns Space snapshots into at most one desktop change per
// actual switch. The native side submits without blocking; a goroutine runs
// process for each signal, so rapid switches settle on the latest snapshot.
type desktopFollower struct {
	mu       sync.Mutex
	started  bool
	wanted   bool
	previous *spaceSnapshot
	sequence uint64
	latest   atomic.Pointer[[]byte]
	signal   chan struct{}
	snapshot func() ([]byte, error)
	dispatch func(desktop int, sequence uint64)
	report   func(err error)
}

func newDesktopFollower(snapshot func() ([]byte, error), dispatch func(int, uint64), report func(error)) *desktopFollower {
	return &desktopFollower{signal: make(chan struct{}, 1), snapshot: snapshot, dispatch: dispatch, report: report}
}

func (f *desktopFollower) submit(data []byte) {
	f.latest.Store(&data)
	select {
	case f.signal <- struct{}{}:
	default:
	}
}

func (f *desktopFollower) run() {
	for range f.signal {
		f.process()
	}
}

// process handles one pending signal and reports whether one was pending.
func (f *desktopFollower) process() bool {
	select {
	case <-f.signal:
	default:
	}
	data := f.latest.Swap(nil)
	if data == nil {
		return false
	}
	f.mu.Lock()
	if !f.wanted {
		f.mu.Unlock()
		return true
	}
	snapshot, err := parseSpaceSnapshot(*data)
	if err != nil {
		f.mu.Unlock()
		f.report(err)
		return true
	}
	desktop, changed, err := desktopChange(f.previous, &snapshot)
	f.previous = &snapshot
	if err != nil {
		f.mu.Unlock()
		f.report(err)
		return true
	}
	if !changed {
		f.mu.Unlock()
		return true
	}
	f.sequence++
	sequence := f.sequence
	f.mu.Unlock()
	f.dispatch(desktop, sequence)
	return true
}

// setEnabled records the setting. Turning it on after the monitor started
// takes a fresh baseline so the next switch is followed; turning it off drops
// any queued change.
func (f *desktopFollower) setEnabled(enabled bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wanted = enabled
	f.previous = nil
	f.latest.Store(nil)
	select {
	case <-f.signal:
	default:
	}
	if enabled && f.started {
		return f.baselineLocked()
	}
	return nil
}

func (f *desktopFollower) start() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.started = true
	if f.wanted {
		return f.baselineLocked()
	}
	return nil
}

func (f *desktopFollower) baselineLocked() error {
	data, err := f.snapshot()
	if err != nil {
		return err
	}
	snapshot, err := parseSpaceSnapshot(data)
	if err != nil {
		return err
	}
	f.previous = &snapshot
	return nil
}
```

Note: `run` calls `process`, which drains the signal itself first; the range loop's receive already consumed one token, so the inner non-blocking receive is a no-op there and matters only for direct `process` calls in tests and for `setEnabled` draining.

- [ ] **Step 4: Run the tests**

Run: `go test -race ./... 2>&1 | grep -v "ld: warning" | tail -3`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add desktop_follow.go desktop_follow_test.go
git commit -m "Add the desktop follower state machine

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Setting, native monitor, window routing and startup wiring

**Files:**
- Modify: `app.go` (Settings struct, GetSettings, SaveSettings, new setFollowDesktop)
- Modify: `main.go` (Desktop fields, DidFinishLaunching, dispatch helpers)
- Create: `desktop_follow_darwin.go`, `desktop_follow_darwin.m`, `desktop_follow_other.go`
- Test: `app_test.go`, `desktop_follow_test.go`

**Interfaces:**
- Produces: `Settings.FollowDesktop bool` (`json:"followDesktop"`); `(a *App) setFollowDesktop(enabled bool) error`; `desktopChangeTarget(windows []application.Window, date string) application.Window`; `(d *Desktop) dispatchDesktopChange(desktop int, sequence uint64)`; `(d *Desktop) reportDesktopError(err error)`; `(d *Desktop) startDesktopFollow()`; platform functions `startNativeDesktopFollow(d *Desktop) error` and `nativeDesktopSnapshot() ([]byte, error)`.
- Consumes: `desktopFollower` from Task 2, `dispatchToWindow` and `dayWindowName` from `main.go`.

- [ ] **Step 1: Write the failing tests**

In `app_test.go`:

```go
func TestFollowDesktopSettingPersistsAndDefaultsOff(t *testing.T) {
	home := t.TempDir()
	config := filepath.Join(t.TempDir(), "settings.json")
	app := newAppForPaths(home, config)
	settings, err := app.GetSettings()
	if err != nil || settings.FollowDesktop {
		t.Fatalf("follow desktop must default to off: %#v %v", settings, err)
	}
	settings.StorageRoot = filepath.Join(t.TempDir(), "journal")
	settings.FollowDesktop = true
	if _, err := app.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	reloaded, err := newAppForPaths(home, config).GetSettings()
	if err != nil || !reloaded.FollowDesktop {
		t.Fatalf("follow desktop was not persisted: %#v %v", reloaded, err)
	}
	if !strings.Contains(string(mustRead(t, config)), `"followDesktop": true`) {
		t.Fatal("settings.json must store followDesktop")
	}
}

func TestFollowDesktopCannotBeEnabledWhenUnavailable(t *testing.T) {
	app := newAppForPaths(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"))
	app.desktop = &Desktop{service: app, followUnavailable: "SkyLight does not export SLSCopyManagedDisplaySpaces"}
	_, err := app.SaveSettings(Settings{StorageRoot: filepath.Join(t.TempDir(), "journal"), FollowDesktop: true})
	if err == nil || !strings.Contains(err.Error(), "SLSCopyManagedDisplaySpaces") {
		t.Fatalf("enabling must fail with the native reason: %v", err)
	}
	if _, statErr := os.Stat(app.settingsPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("a rejected save must not write settings")
	}
}
```

Add `mustRead(t, path)` helper (`os.ReadFile` with `t.Fatal`) and imports `errors`, `strings`.

In `desktop_follow_test.go`:

```go
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
	windows := []application.Window{&followTestWindow{name: "welcome"}, &followTestWindow{name: "day-2026-09-10"}, today, &followTestWindow{name: "settings"}}
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./... -run 'FollowDesktop|DesktopChangeTarget' 2>&1 | grep -v "ld: warning" | tail -5`
Expected: compile errors for `FollowDesktop`, `followUnavailable`, `desktopChangeTarget`.

- [ ] **Step 3: Implement the setting in `app.go`**

Add to `Settings`:

```go
	FollowDesktop bool `json:"followDesktop"`
```

Add fields to `App`: `followMu sync.Mutex`, `followKnown bool`, `followEnabled bool`.

In `GetSettings`, after each `a.setDebugMode(settings.DebugMode)` add:

```go
	if err := a.setFollowDesktop(settings.FollowDesktop); err != nil {
		log.Printf("Follow macOS desktop: %v", err)
	}
```

(import `log`). The launch path reports the same failure to the windows through `startDesktopFollow`, so this log line is a duplicate record, not the only record.

In `SaveSettings`, after the `ensureJournalFolders` call and before marshalling:

```go
	if err := a.setFollowDesktop(settings.FollowDesktop); err != nil {
		return Settings{}, err
	}
```

and after a failed `atomicWriteFile` (inside that `if`), revert before returning:

```go
		_ = a.setFollowDesktop(previous.FollowDesktop)
```

Add the method:

```go
// setFollowDesktop forwards the setting to the native follower once per
// change. Enabling fails visibly when the private Space API is unavailable.
func (a *App) setFollowDesktop(enabled bool) error {
	a.followMu.Lock()
	defer a.followMu.Unlock()
	if a.followKnown && a.followEnabled == enabled {
		return nil
	}
	if a.desktop != nil {
		if enabled && a.desktop.followUnavailable != "" {
			return errors.New("follow macOS desktop is unavailable: " + a.desktop.followUnavailable)
		}
		if a.desktop.follower != nil {
			if err := a.desktop.follower.setEnabled(enabled); err != nil {
				return fmt.Errorf("follow macOS desktop: %w", err)
			}
		}
	}
	a.followKnown, a.followEnabled = true, enabled
	return nil
}
```

- [ ] **Step 4: Implement routing and startup in `main.go` and `desktop_follow.go`**

`Desktop` gains:

```go
	follower          *desktopFollower
	followUnavailable string
	followErrorMu     sync.Mutex
	lastFollowError   string
```

In `main()` after `service.desktop = desktop`:

```go
	desktop.follower = newDesktopFollower(nativeDesktopSnapshot, desktop.dispatchDesktopChange, desktop.reportDesktopError)
```

In the `ApplicationDidFinishLaunching` handler, after `startNativeCommandHints(desktop)`:

```go
		desktop.startDesktopFollow()
```

Append to `desktop_follow.go` (imports `log`, `time`, `github.com/wailsapp/wails/v3/pkg/application`):

```go
// startDesktopFollow starts the native Space observer once the application is
// running. A persisted enabled setting that cannot work is reported to every
// window rather than ignored.
func (d *Desktop) startDesktopFollow() {
	if err := startNativeDesktopFollow(d); err != nil {
		d.followUnavailable = err.Error()
		log.Printf("Follow macOS desktop unavailable: %v", err)
		if settings, settingsErr := d.service.GetSettings(); settingsErr == nil && settings.FollowDesktop {
			for _, window := range d.native.Window.GetAll() {
				dispatchToWindow(window, "menu:error", "Follow macOS desktop is unavailable: "+err.Error())
			}
		}
		return
	}
	go d.follower.run()
	if err := d.follower.start(); err != nil {
		d.reportDesktopError(err)
	}
}

func desktopChangeTarget(windows []application.Window, date string) application.Window {
	name := dayWindowName(date)
	for _, window := range windows {
		if window.Name() == name {
			return window
		}
	}
	return nil
}

// dispatchDesktopChange tells today's journal window which desktop is now
// active. It never shows, focuses or unminimises anything.
func (d *Desktop) dispatchDesktopChange(desktop int, sequence uint64) {
	date := time.Now().Format("2006-01-02")
	window := desktopChangeTarget(d.native.Window.GetAll(), date)
	windowName := ""
	if window != nil {
		windowName = window.Name()
	}
	_ = d.service.RecordDebugEvents([]DebugEvent{{
		Window: windowName, Category: "desktop", Action: "changed", Sequence: sequence,
		Details: map[string]string{"desktop": strconv.Itoa(desktop), "date": date, "delivered": strconv.FormatBool(window != nil)},
	}})
	if window == nil {
		return
	}
	dispatchToWindow(window, "desktop:changed", map[string]any{"desktop": desktop, "sequence": sequence})
}

// reportDesktopError shows a Space observation failure once per distinct
// message in today's window, or the current window when today is closed.
func (d *Desktop) reportDesktopError(err error) {
	message := "Follow macOS desktop: " + err.Error()
	d.followErrorMu.Lock()
	repeated := d.lastFollowError == message
	d.lastFollowError = message
	d.followErrorMu.Unlock()
	log.Print(message)
	if repeated {
		return
	}
	window := desktopChangeTarget(d.native.Window.GetAll(), time.Now().Format("2006-01-02"))
	if window == nil {
		window = d.native.Window.Current()
	}
	if window != nil {
		dispatchToWindow(window, "menu:error", message)
	}
}
```

`desktop_follow_other.go`:

```go
//go:build !darwin

package main

import "errors"

func startNativeDesktopFollow(*Desktop) error {
	return errors.New("following Mission Control desktops needs macOS")
}

func nativeDesktopSnapshot() ([]byte, error) {
	return nil, errors.New("following Mission Control desktops needs macOS")
}
```

`desktop_follow_darwin.go`:

```go
//go:build darwin

package main

/*
#include <stdlib.h>
char *jm_start_desktop_monitor(void);
char *jm_desktop_snapshot(void);
*/
import "C"

import (
	"errors"
	"sync/atomic"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

var desktopFollowerRef atomic.Pointer[desktopFollower]

//export journalistDesktopSnapshot
func journalistDesktopSnapshot(data *C.char) {
	// Copy and return at once; AppKit is waiting on the main thread.
	if follower := desktopFollowerRef.Load(); follower != nil && data != nil {
		follower.submit([]byte(C.GoString(data)))
	}
}

func nativeDesktopSnapshot() ([]byte, error) {
	value := C.jm_desktop_snapshot()
	if value == nil {
		return nil, errors.New("desktop snapshot unavailable")
	}
	defer C.free(unsafe.Pointer(value))
	return []byte(C.GoString(value)), nil
}

func startNativeDesktopFollow(d *Desktop) error {
	desktopFollowerRef.Store(d.follower)
	var message string
	application.InvokeSync(func() {
		if value := C.jm_start_desktop_monitor(); value != nil {
			message = C.GoString(value)
			C.free(unsafe.Pointer(value))
		}
	})
	if message != "" {
		return errors.New(message)
	}
	return nil
}
```

`desktop_follow_darwin.m`:

```objc
#import <Cocoa/Cocoa.h>
#import <dlfcn.h>

extern void journalistDesktopSnapshot(char *json);

typedef int CGSConnectionID;
static CGSConnectionID (*jm_SLSMainConnectionID)(void);
static CFArrayRef (*jm_SLSCopyManagedDisplaySpaces)(CGSConnectionID);
static BOOL desktopMonitorStarted;

static char *jm_json_string(NSDictionary *object) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return strdup(text.UTF8String);
}

static char *jm_json_error(NSString *reason) {
    return jm_json_string(@{@"error": reason});
}

// jm_desktop_snapshot serialises the live SLSCopyManagedDisplaySpaces array.
// It uses no AppKit state, so any thread may call it.
char *jm_desktop_snapshot(void) {
    if (!jm_SLSMainConnectionID || !jm_SLSCopyManagedDisplaySpaces) {
        return jm_json_error(@"SkyLight symbols are not loaded");
    }
    CFArrayRef spaces = jm_SLSCopyManagedDisplaySpaces(jm_SLSMainConnectionID());
    if (!spaces) {
        return jm_json_error(@"SLSCopyManagedDisplaySpaces returned no data");
    }
    NSDictionary *payload = @{@"displays": CFBridgingRelease(spaces)};
    if (![NSJSONSerialization isValidJSONObject:payload]) {
        return jm_json_error(@"SLSCopyManagedDisplaySpaces returned values that cannot be serialised");
    }
    return jm_json_string(payload);
}

static void jm_publish_desktop_snapshot(void) {
    char *json = jm_desktop_snapshot();
    journalistDesktopSnapshot(json);
    free(json);
}

char *jm_start_desktop_monitor(void) {
    if (desktopMonitorStarted) return NULL;
    void *handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW);
    if (!handle) return strdup("the SkyLight framework could not be loaded");
    jm_SLSMainConnectionID = dlsym(handle, "SLSMainConnectionID");
    jm_SLSCopyManagedDisplaySpaces = dlsym(handle, "SLSCopyManagedDisplaySpaces");
    if (!jm_SLSMainConnectionID) return strdup("SkyLight does not export SLSMainConnectionID");
    if (!jm_SLSCopyManagedDisplaySpaces) return strdup("SkyLight does not export SLSCopyManagedDisplaySpaces");
    desktopMonitorStarted = YES;
    [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceActiveSpaceDidChangeNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
        jm_publish_desktop_snapshot();
    }];
    // Displays coming and going reorder desktops; refresh the baseline.
    [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidChangeScreenParametersNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
        jm_publish_desktop_snapshot();
    }];
    return NULL;
}
```

- [ ] **Step 5: Run all Go checks**

Run: `go vet ./... && go test -race ./... 2>&1 | grep -v "ld: warning" | tail -3`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
git add app.go app_test.go main.go desktop_follow.go desktop_follow_test.go desktop_follow_darwin.go desktop_follow_darwin.m desktop_follow_other.go
git commit -m "Observe Mission Control desktop changes and route them to today's window

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Settings UI and regenerated bindings

**Files:**
- Regenerate: `frontend/bindings/journalist-mode-desktop/models.ts` via `wails3 task generate:bindings`
- Modify: `frontend/src/api.ts` (mock settings), `frontend/src/components/SettingsView.tsx`, `frontend/src/App.css` (only if a new class is needed)
- Test: `frontend/src/components/SettingsView.test.tsx`

**Interfaces:**
- Consumes: `Settings.followDesktop` from the regenerated model.
- Produces: switch input with `aria-label="Follow macOS desktop"`; `onSave` receives `followDesktop`.

- [ ] **Step 1: Regenerate bindings**

Run: `cd /Users/dirk/Dev/journalist-mode-follow-desktop && wails3 task generate:bindings 2>&1 | tail -3 && grep -n followDesktop frontend/bindings/journalist-mode-desktop/models.ts`
Expected: `"followDesktop": boolean;` and its default in the constructor.

- [ ] **Step 2: Write the failing test** (add to `SettingsView.test.tsx`)

```tsx
    it('persists the follow-desktop opt-in with its explanation', async () => {
        const onSave = vi.fn(async () => undefined);
        await act(async () => {
            root.render(
                <SettingsView
                    settings={{storageRoot: '/journal', editorFont: 'system', debugMode: false, followDesktop: false} as Settings}
                    debugLogDirectory="/private/debug"
                    onBack={vi.fn()}
                    onBrowse={vi.fn(async () => '')}
                    onOpenDebugFolder={vi.fn(async () => undefined)}
                    onSave={onSave}
                />,
            );
        });
        const follow = host.querySelector<HTMLInputElement>('[aria-label="Follow macOS desktop"]')!;
        expect(follow.checked).toBe(false);
        expect(host.textContent).toContain('Automatically select and zoom the Doing stream matching the desktop you switch to.');
        await act(async () => follow.click());
        const save = [...host.querySelectorAll<HTMLButtonElement>('button')]
            .find(button => button.textContent === 'Save settings')!;
        await act(async () => save.click());
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({followDesktop: true, debugMode: false}));
    });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test --prefix frontend -- SettingsView 2>&1 | tail -8`
Expected: fails because the input is null.

- [ ] **Step 4: Implement**

`api.ts` mock settings: add `followDesktop: false`.

`SettingsView.tsx`: add `const [followDesktop, setFollowDesktop] = useState(settings.followDesktop);`, `useEffect(() => setFollowDesktop(settings.followDesktop), [settings.followDesktop]);`, include `followDesktop` in `onSave({...settings, storageRoot, debugMode, followDesktop})`, and insert this card before the Updates card:

```tsx
                <div className="settings-card">
                    <label className="debug-toggle">
                        <span className="setting-label">
                            <span>
                                <strong>Follow macOS desktop</strong>
                                <small>Automatically select and zoom the Doing stream matching the desktop you switch to.</small>
                            </span>
                        </span>
                        <span className="switch-control">
                            <input
                                type="checkbox"
                                aria-label="Follow macOS desktop"
                                checked={followDesktop}
                                onChange={event => setFollowDesktop(event.target.checked)}
                            />
                            <span aria-hidden="true"/>
                        </span>
                    </label>
                    <p className="setting-note">Desktop 1 shows the first Doing stream and Desktop N shows stream N in today's journal window. Journalist Mode stays in the background; the app you are working in keeps the keyboard.</p>
                </div>
```

- [ ] **Step 5: Run the frontend tests and build**

Run: `npm test --prefix frontend 2>&1 | tail -5 && npm run build --prefix frontend 2>&1 | tail -3`
Expected: all tests pass, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/bindings frontend/src/api.ts frontend/src/components/SettingsView.tsx frontend/src/components/SettingsView.test.tsx
git commit -m "Add the Follow macOS desktop setting

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Idempotent focus-and-zoom workspace action

**Files:**
- Modify: `frontend/src/lib/workspace.ts` (WorkspaceAction union), `frontend/src/components/DayWorkspace.tsx` (focusDoingZoomed, handleWorkspaceAction)
- Test: `frontend/src/components/DayWorkspace.follow.test.tsx`

**Interfaces:**
- Produces: `{type: 'focus-doing-zoomed'; streamIndex: number}` in `WorkspaceAction`.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import {act} from 'react';
import {EditorView} from '@codemirror/view';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {appAPI, DayData} from '../api';
import {WorkspaceActionRequest} from '../lib/workspace';
import {DayWorkspace} from './DayWorkspace';

const streams = [1, 2, 4, 7, 10];
const day = {
    date: '2026-09-11',
    todo: {path: '/journal/Todo/2026-09-11.jmtodo.md', name: '2026-09-11.jmtodo.md', content: '[2026-09-11] Todo', exists: true, streamIndex: 0},
    doing: streams.map(streamIndex => ({
        path: `/journal/Doing/2026-09-11${streamIndex === 1 ? '' : `_${streamIndex}`}.jm.md`,
        name: `2026-09-11${streamIndex === 1 ? '' : `_${streamIndex}`}.jm.md`,
        content: `(2026-09-11 09:00) Stream ${streamIndex}`, exists: true, streamIndex,
    })),
} as DayData;

describe('focus-doing-zoomed', () => {
    let host: HTMLDivElement;
    let root: Root;
    let request: WorkspaceActionRequest;

    beforeEach(() => {
        (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
        globalThis.ResizeObserver = class {observe() {} unobserve() {} disconnect() {}};
        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = () => new DOMRect();
        vi.spyOn(appAPI, 'readJournalFiles').mockResolvedValue([day.todo, ...day.doing]);
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        request = {action: {type: 'focus-todo'}, revision: 0};
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        vi.restoreAllMocks();
    });

    const render = async () => act(async () => root.render(
        <DayWorkspace day={day} debugMode={false} saveRequest={0} discardRequest={0} newDoingRequest={0}
            workspaceActionRequest={request} interactionDisabled={false} onError={vi.fn()}
            onSaveStateChange={vi.fn()} onSaveComplete={vi.fn()} />,
    ));
    const dispatch = async (action: WorkspaceActionRequest['action']) => {
        request = {action, revision: request.revision + 1};
        await render();
    };
    const visiblePanes = () => [...host.querySelectorAll<HTMLElement>('.journal-pane')]
        .filter(pane => !pane.hidden).map(pane => pane.querySelector('.filename')!.textContent);
    const zoomed = () => host.querySelector('.pane-strip')!.classList.contains('is-zoomed');

    it('zooms the matching stream from an unzoomed layout, from another zoomed pane, and stays put on repeats', async () => {
        await render();
        expect(zoomed()).toBe(false);
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 7});
        expect(zoomed()).toBe(true);
        expect(visiblePanes()).toEqual(['2026-09-11_7.jm.md']);
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 7});
        expect(visiblePanes()).toEqual(['2026-09-11_7.jm.md']);
        await dispatch({type: 'toggle-zoom'});
        expect(zoomed()).toBe(false);
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 4});
        expect(visiblePanes()).toEqual(['2026-09-11_4.jm.md']);
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 10});
        expect(visiblePanes()).toEqual(['2026-09-11_10.jm.md']);
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 1});
        expect(visiblePanes()).toEqual(['2026-09-11.jm.md']);
    });

    it('leaves the workspace unchanged for a missing stream and preserves text and selection', async () => {
        await render();
        const editor = EditorView.findFromDOM(host.querySelectorAll<HTMLElement>('.cm-editor')[3])!; // stream 7
        await act(async () => { editor.dispatch({selection: {anchor: 3, head: 8}}); });
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 7});
        expect(editor.state.selection.main).toMatchObject({anchor: 3, head: 8});
        await dispatch({type: 'focus-doing-zoomed', streamIndex: 5});
        expect(zoomed()).toBe(true);
        expect(visiblePanes()).toEqual(['2026-09-11_7.jm.md']);
        expect([...host.querySelectorAll<HTMLElement>('.cm-editor')].map(el => EditorView.findFromDOM(el)!.state.doc.toString()))
            .toEqual([day.todo.content, ...day.doing.map(file => file.content)]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix frontend -- DayWorkspace.follow 2>&1 | tail -8`
Expected: TypeScript or runtime failure on the unknown action type (the switch ignores it, so `zoomed()` stays false).

- [ ] **Step 3: Implement**

`workspace.ts`: add `| {type: 'focus-doing-zoomed'; streamIndex: number}` to `WorkspaceAction`.

`DayWorkspace.tsx`, after `focusDoing`:

```tsx
    // Following a desktop assigns the zoom rather than toggling it, so repeated
    // events for the same desktop keep the pane zoomed.
    const focusDoingZoomed = useCallback((streamIndex: number): boolean => {
        const path = doingFiles.find(file => file.streamIndex === streamIndex)?.path;
        if (!path) {
            return false;
        }
        setFocusedPath(path);
        setZoomedPath(path);
        setEditorFocus(current => ({path, revision: current.revision + 1}));
        return true;
    }, [doingFiles]);
```

In `handleWorkspaceAction` add `case 'focus-doing-zoomed': handled = focusDoingZoomed(action.streamIndex); break;` and add `focusDoingZoomed` to its dependency list.

- [ ] **Step 4: Run the tests**

Run: `npm test --prefix frontend 2>&1 | tail -5`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/workspace.ts frontend/src/components/DayWorkspace.tsx frontend/src/components/DayWorkspace.follow.test.tsx
git commit -m "Add an idempotent focus-and-zoom workspace action

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Route desktop events in App with sequence filtering and deferral

**Files:**
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/App.follow.test.tsx`

**Interfaces:**
- Consumes: `desktop:changed` payload `{desktop: number; sequence: number}`; `settings.followDesktop`; the Task 5 action.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import {act, useEffect} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import App from './App';

const harness = vi.hoisted(() => ({
    events: new Map<string, (event: {data: unknown}) => void>(),
    actions: [] as string[],
    settings: {storageRoot: '/journal', editorFont: 'system', debugMode: false, followDesktop: true},
    setState: (_state: string) => {},
}));
vi.mock('@wailsio/runtime', () => ({
    Events: {On: (name: string, handler: (event: {data: unknown}) => void) => {
        harness.events.set(name, handler);
        return () => harness.events.delete(name);
    }},
    Window: {SetTitle: vi.fn(async () => undefined)},
}));
vi.mock('./api', () => ({appAPI: {
    isNative: () => true,
    isSettingsWindow: () => false,
    getSettings: async () => harness.settings,
    listDays: async () => [],
    getLaunchDate: async () => '2026-09-11',
    openDay: async () => ({date: '2026-09-11', todo: {}, doing: []}),
    cancelQuit: vi.fn(async () => undefined),
    closeWindow: vi.fn(async () => undefined),
}}));
vi.mock('./components/DayWorkspace', () => ({DayWorkspace: (props: any) => {
    harness.setState = props.onSaveStateChange;
    useEffect(() => props.onSaveStateChange('saved'), []);
    useEffect(() => {
        if (props.workspaceActionRequest.revision > 0) harness.actions.push(JSON.stringify(props.workspaceActionRequest.action));
    }, [props.workspaceActionRequest.revision]);
    return <button disabled={props.interactionDisabled}>Journal editor</button>;
}}));

describe('desktop follow routing', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(async () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        harness.events.clear(); harness.actions = [];
        harness.settings = {...harness.settings, followDesktop: true};
        host = document.createElement('div'); document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => root.render(<App/>));
    });
    afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
    const event = async (name: string, data: unknown) => act(async () => harness.events.get(name)!({data}));
    const zoom = (streamIndex: number) => JSON.stringify({type: 'focus-doing-zoomed', streamIndex});

    it('applies fresh events, drops stale sequences, and stops when the setting turns off', async () => {
        await event('desktop:changed', {desktop: 7, sequence: 1});
        await event('desktop:changed', {desktop: 4, sequence: 1});
        await event('desktop:changed', {desktop: 2, sequence: 3});
        await event('desktop:changed', {desktop: 9, sequence: 2});
        expect(harness.actions).toEqual([zoom(7), zoom(2)]);
        await event('settings:changed', {...harness.settings, followDesktop: false});
        await event('desktop:changed', {desktop: 5, sequence: 4});
        expect(harness.actions).toEqual([zoom(7), zoom(2)]);
    });

    it('defers a change while the close prompt is open and applies it after Cancel', async () => {
        await act(async () => harness.setState('dirty'));
        await event('window:close-request', undefined);
        expect(host.textContent).toContain('Save changes before closing?');
        await event('desktop:changed', {desktop: 4, sequence: 1});
        await event('desktop:changed', {desktop: 7, sequence: 2});
        expect(harness.actions).toEqual([]);
        const cancel = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Cancel')!;
        await act(async () => cancel.click());
        expect(harness.actions).toEqual([zoom(7)]);
    });

    it('drops a deferred change when the setting turns off before the prompt closes', async () => {
        await act(async () => harness.setState('dirty'));
        await event('window:close-request', undefined);
        await event('desktop:changed', {desktop: 4, sequence: 1});
        await event('settings:changed', {...harness.settings, followDesktop: false});
        const cancel = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Cancel')!;
        await act(async () => cancel.click());
        expect(harness.actions).toEqual([]);
    });

    it('defers while a file conflict is unresolved', async () => {
        await act(async () => harness.setState('conflict'));
        await event('desktop:changed', {desktop: 4, sequence: 1});
        expect(harness.actions).toEqual([]);
        await act(async () => harness.setState('saved'));
        expect(harness.actions).toEqual([zoom(4)]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix frontend -- App.follow 2>&1 | tail -8`
Expected: `harness.events.get('desktop:changed')` is undefined.

- [ ] **Step 3: Implement in `App.tsx`**

Add refs near the other refs:

```tsx
    const lastDesktopSequence = useRef(0);
    const pendingDesktop = useRef<number | null>(null);
```

Add a helper after `requestWorkspaceAction`:

```tsx
    const followBlocked = () => dayPickerOpen || closePrompt !== null || shortcutsOpen
        || quitRequestRef.current !== null || workspaceSaveStateRef.current === 'conflict';
```

In the native event effect, add:

```tsx
        const stopDesktop = Events.On('desktop:changed', event => {
            const data = event.data as {desktop: number; sequence: number};
            if (!(data.sequence > lastDesktopSequence.current)) return;
            lastDesktopSequence.current = data.sequence;
            if (!settings?.followDesktop || screen !== 'day') return;
            if (followBlocked()) {
                // Do not interrupt a prompt or conflict; apply the latest target when it ends.
                pendingDesktop.current = data.desktop;
                return;
            }
            requestWorkspaceAction({type: 'focus-doing-zoomed', streamIndex: data.desktop});
        });
```

and `stopDesktop();` in the cleanup. In the `settings:changed` handler add `if (!changed.followDesktop) pendingDesktop.current = null;`.

Add the deferred-application effect after the other effects:

```tsx
    useEffect(() => {
        if (pendingDesktop.current === null || screen !== 'day' || dayPickerOpen || closePrompt
            || shortcutsOpen || quitRequest || workspaceSaveState === 'conflict') {
            return;
        }
        const desktop = pendingDesktop.current;
        pendingDesktop.current = null;
        if (settings?.followDesktop) {
            requestWorkspaceAction({type: 'focus-doing-zoomed', streamIndex: desktop});
        }
    }, [closePrompt, dayPickerOpen, quitRequest, screen, settings, shortcutsOpen, workspaceSaveState]);
```

- [ ] **Step 4: Run the tests and build**

Run: `npm test --prefix frontend 2>&1 | tail -5 && npm run build --prefix frontend 2>&1 | tail -3`
Expected: all pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/App.follow.test.tsx
git commit -m "Route desktop changes to the workspace with deferral during prompts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the paragraph** to "How a day works", after the paragraph ending "without closing or reloading the other editors.":

```markdown
Settings has an optional **Follow macOS desktop** switch, off by default. When it is on and you move to another Mission Control desktop, today's journal window selects the Doing stream with the same number and zooms it: Desktop 1 shows `YYYY-MM-DD.jm.md`, Desktop 7 shows `YYYY-MM-DD_7.jm.md`, and numbers above 9 work even though the Command-number shortcuts stop at 9. Journalist Mode stays in the background and never takes the keyboard from the app you switched to. If today's window or the matching stream does not exist, nothing changes. This uses a private macOS interface; if it is unavailable, turning the switch on reports an error instead of silently doing nothing.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document the Follow macOS desktop setting

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Native validation

**Files:**
- Create (git-ignored): `tmp/follow-desktop/harness.py`, `tmp/follow-desktop/results.jsonl`
- Create: `docs/testing/desktop-follow.md`, `docs/testing/desktop-follow-results.json`

- [ ] **Step 1: Build a signed package**: `cd /Users/dirk/Dev/journalist-mode-follow-desktop && wails3 task build && wails3 task package && codesign --force --deep --sign - "build/bin/Journalist Mode.app"` (ad-hoc for iteration; the final tested build uses `JM_NOTARY_PROFILE=journalist-mode-notary bash scripts/package-macos.sh`).
- [ ] **Step 2: Prepare fixtures without the lock**: confirm no `Journalist Mode` process is running; back up `~/Library/Application Support/Journalist Mode/settings.json`; hash every file under the real journal root; write a scratch settings file pointing `storageRoot` at `tmp/follow-desktop/journal` with `followDesktop: false`; create today's Todo file and Doing streams 1, 2, 4, 7 and 10 with fixture text.
- [ ] **Step 3: Acquire the screen lock** (`screen-lock.sh acquire journalist-mode-desktop-82 "Journalist Mode desktop-follow native checks" 12`), message the peer session, then run the harness: launch the app, open today, enable the setting in Settings, add a tenth desktop through Mission Control's add button if only nine exist, activate TextEdit as the foreground app, and for each case switch desktops with `osascript key code … using control down` at 0.6 s spacing and record: visible panes and focused editor from the Accessibility tree, frontmost application name and Journalist Mode's window order from the window list, and file hashes.
- [ ] **Step 4: Cases**: 4→7 (unzoomed start), 7→2 (switch zoom), 2→2 by re-sending nothing and checking a Mission Control open/close leaves it zoomed, manual unzoom then a duplicate notification (open and close Mission Control) leaves it unzoomed, 1 (unsuffixed), 10 (above nine), 9 (missing stream: unchanged), rapid 4→7→2 (0.6 s apart) ends on 2, disable then switch (unchanged), enable and switch again (works without restart), minimised window stays minimised and updates on unminimise, hidden app stays hidden, unsaved text in stream 7 and a caret position survive, Mission Control label comparison with a full-screen TextEdit Space present, and a click on a Mission Control desktop thumbnail.
- [ ] **Step 5: Restore**: quit the test app, remove the tenth desktop and the full-screen Space, restore settings.json, verify the real journal hashes are unchanged, return to the original desktop, release the lock, message the peer.
- [ ] **Step 6: Write `docs/testing/desktop-follow.md` and `desktop-follow-results.json`** from `results.jsonl`, stating what was verified, what was not (multi-display, trackpad gestures) and why.
- [ ] **Step 7: Commit**

```bash
git add docs/testing/desktop-follow.md docs/testing/desktop-follow-results.json
git commit -m "Record native validation of desktop following

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Review, PR and delivery

- [ ] **Step 1**: Run every check: `go vet ./... && go test -race ./... && npm test --prefix frontend && npm run build --prefix frontend && python3 -m unittest discover -s scripts -p 'test_*.py'`.
- [ ] **Step 2**: Adversarial code review by a fresh subagent against the issue's acceptance criteria; fix confirmed findings with regression tests; rerun checks.
- [ ] **Step 3**: Push `feature/follow-desktop`, open the PR with `gh pr create` describing behaviour, checks run and native evidence, body ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`; after the notarized build passes the native batch, merge (default agreed with Dirk unless he objects) and install the tested bundle into /Applications, keeping a backup of the previous bundle under `tmp/follow-desktop/original-installed`.
