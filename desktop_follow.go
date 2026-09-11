package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
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

// desktopChange reports the display whose current Space changed and its new
// desktop number. A missing baseline, a changed display set, several displays
// changing at once, or a full-screen destination is not a change.
func desktopChange(previous, next *spaceSnapshot) (display string, desktop int, changed bool, err error) {
	if previous == nil || len(previous.Displays) != len(next.Displays) {
		return "", 0, false, nil
	}
	before := make(map[string]displaySpaces, len(previous.Displays))
	for _, entry := range previous.Displays {
		before[entry.ID] = entry
	}
	index := -1
	for position, entry := range next.Displays {
		earlier, known := before[entry.ID]
		if !known {
			return "", 0, false, nil
		}
		if earlier.Current == entry.Current {
			continue
		}
		if index >= 0 {
			return "", 0, false, nil
		}
		index = position
	}
	if index < 0 {
		return "", 0, false, nil
	}
	desktop, err = currentDesktop(next.Displays[index], desktopNumbers(*next))
	if err != nil {
		return "", 0, false, err
	}
	return next.Displays[index].ID, desktop, desktop > 0, nil
}

// desktopFollower turns Space snapshots into at most one desktop change per
// actual switch. The native side submits without blocking; a goroutine runs
// process for each signal, so rapid switches settle on the latest snapshot.
type desktopFollower struct {
	mu       sync.Mutex
	started  bool
	wanted   bool
	previous *spaceSnapshot
	// lastSpace is the last numbered Space each display showed, so leaving
	// for a full-screen Space and returning to the same desktop is not a
	// desktop change. It compares Space identity, not the desktop number,
	// because reordering or removing desktops renumbers them without a switch.
	lastSpace map[string]uint64
	// failed records an observation error so the next good snapshot can
	// report recovery and clear the user-visible status.
	failed   bool
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
// The payload is taken under the mutex so a baseline applied meanwhile wins
// over a snapshot that was queued before it.
func (f *desktopFollower) process() bool {
	select {
	case <-f.signal:
	default:
	}
	f.mu.Lock()
	data := f.latest.Swap(nil)
	if data == nil {
		f.mu.Unlock()
		return false
	}
	if !f.wanted {
		f.mu.Unlock()
		return true
	}
	snapshot, err := parseSpaceSnapshot(*data)
	if err != nil {
		f.failed = true
		f.mu.Unlock()
		f.report(err)
		return true
	}
	display, desktop, changed, err := desktopChange(f.previous, &snapshot)
	f.previous = &snapshot
	if err != nil {
		f.failed = true
		f.mu.Unlock()
		f.report(err)
		return true
	}
	recovered := f.failed
	f.failed = false
	if changed && f.lastSpace[display] == currentSpaceOf(&snapshot, display) {
		changed = false
	}
	f.noteDesktopsLocked(&snapshot)
	var sequence uint64
	if changed {
		f.sequence++
		sequence = f.sequence
	}
	f.mu.Unlock()
	if recovered {
		f.report(nil)
	}
	if changed {
		f.dispatch(desktop, sequence)
	}
	return true
}

func currentSpaceOf(snapshot *spaceSnapshot, display string) uint64 {
	for _, entry := range snapshot.Displays {
		if entry.ID == display {
			return entry.Current
		}
	}
	return 0
}

// submitBaseline replaces the baseline with this snapshot without following
// it. Waking from sleep and display changes use it, so a desktop that changed
// while the Mac was asleep is not treated as a switch. It runs synchronously
// because it must win over any snapshot still queued.
func (f *desktopFollower) submitBaseline(data []byte) {
	f.mu.Lock()
	if !f.wanted {
		f.mu.Unlock()
		return
	}
	f.latest.Store(nil)
	select {
	case <-f.signal:
	default:
	}
	snapshot, err := parseSpaceSnapshot(data)
	if err != nil {
		f.mu.Unlock()
		f.report(err)
		return
	}
	f.previous = &snapshot
	f.lastSpace = nil
	f.noteDesktopsLocked(&snapshot)
	recovered := f.failed
	f.failed = false
	f.mu.Unlock()
	if recovered {
		f.report(nil)
	}
}

// noteDesktopsLocked remembers the numbered Space each display shows.
func (f *desktopFollower) noteDesktopsLocked(snapshot *spaceSnapshot) {
	if f.lastSpace == nil {
		f.lastSpace = make(map[string]uint64)
	}
	numbers := desktopNumbers(*snapshot)
	for _, display := range snapshot.Displays {
		if desktop, err := currentDesktop(display, numbers); err == nil && desktop > 0 {
			f.lastSpace[display.ID] = display.Current
		}
	}
}

// setEnabled records the setting. Turning it on after the monitor started
// takes a fresh baseline so the next switch is followed; turning it off drops
// any queued change.
func (f *desktopFollower) setEnabled(enabled bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wanted = enabled
	f.previous = nil
	f.lastSpace = nil
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

// baselineLocked takes a fresh reference snapshot. A failure is returned to
// the caller (a settings save or the launch path) and remembered so the next
// good snapshot reports recovery.
func (f *desktopFollower) baselineLocked() error {
	data, err := f.snapshot()
	if err != nil {
		f.failed = true
		return err
	}
	snapshot, err := parseSpaceSnapshot(data)
	if err != nil {
		f.failed = true
		return err
	}
	f.previous = &snapshot
	f.lastSpace = nil
	f.noteDesktopsLocked(&snapshot)
	if f.failed {
		f.failed = false
		defer f.report(nil)
	}
	return nil
}

// FollowDesktopStatus tells the frontend whether the native Space observer is
// usable, so Settings can explain an inactive switch.
type FollowDesktopStatus struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
}

// GetFollowDesktopStatus reports a monitor that could not start and also the
// last observation failure, so a launch-time baseline error that no window
// could display yet is still visible in Settings and the day window.
func (a *App) GetFollowDesktopStatus() FollowDesktopStatus {
	if a.desktop == nil {
		return FollowDesktopStatus{Reason: "window manager is not available"}
	}
	if reason := a.desktop.followUnavailableReason(); reason != "" {
		return FollowDesktopStatus{Reason: reason}
	}
	a.desktop.followErrorMu.Lock()
	lastError := a.desktop.lastFollowError
	a.desktop.followErrorMu.Unlock()
	if lastError != "" {
		return FollowDesktopStatus{Reason: lastError}
	}
	return FollowDesktopStatus{Available: true}
}

func (d *Desktop) followUnavailableReason() string {
	d.followErrorMu.Lock()
	defer d.followErrorMu.Unlock()
	return d.followUnavailable
}

// startDesktopFollow starts the native Space observer once the application is
// running. When it cannot start, GetFollowDesktopStatus carries the reason to
// the Settings window and to day windows that have the setting on.
func (d *Desktop) startDesktopFollow() {
	if err := startNativeDesktopFollow(d); err != nil {
		d.followErrorMu.Lock()
		d.followUnavailable = err.Error()
		d.followErrorMu.Unlock()
		log.Printf("Follow macOS desktop unavailable: %v", err)
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

func localToday() string {
	return time.Now().Format("2006-01-02")
}

// dispatchDesktopChange tells today's journal window which desktop is now
// active. It never shows, focuses or unminimises anything.
func (d *Desktop) dispatchDesktopChange(desktop int, sequence uint64) {
	date := localToday()
	window := desktopChangeTarget(d.native.Window.GetAll(), date)
	windowName := ""
	if window != nil {
		windowName = window.Name()
	}
	_ = d.service.RecordDebugEvents([]DebugEvent{{
		Window: windowName, Category: "desktop", Action: "changed", Sequence: sequence,
		Details: map[string]string{
			"desktop":   strconv.Itoa(desktop),
			"date":      date,
			"delivered": strconv.FormatBool(window != nil),
		},
	}})
	if window == nil {
		return
	}
	dispatchToWindow(window, "desktop:changed", map[string]any{"desktop": desktop, "sequence": sequence})
}

// reportDesktopError shows a Space observation failure once per distinct
// message in today's window, or in every window when today is closed. The
// key window is usually another application's while this feature runs, so
// Window.Current is not a useful target. A nil error means the observer
// recovered; the recorded failure is cleared so the status reads available.
func (d *Desktop) reportDesktopError(err error) {
	if err == nil {
		d.followErrorMu.Lock()
		d.lastFollowError = ""
		d.followErrorMu.Unlock()
		return
	}
	d.followErrorMu.Lock()
	repeated := d.lastFollowError == err.Error()
	d.lastFollowError = err.Error()
	d.followErrorMu.Unlock()
	message := "Follow macOS desktop: " + err.Error()
	log.Print(message)
	if repeated {
		return
	}
	windows := d.native.Window.GetAll()
	if today := desktopChangeTarget(windows, localToday()); today != nil {
		windows = []application.Window{today}
	}
	for _, window := range windows {
		dispatchToWindow(window, "menu:error", message)
	}
}
