package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
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

// process handles one pending snapshot and reports whether one was pending.
// run has already consumed the signal token; direct callers drain it here.
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
