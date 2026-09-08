package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// A quit is a two-phase operation: every journal consents before any window
// closes. Discard consent does not erase an editor if another window cancels.
type quitGate struct {
	mu       sync.Mutex
	serial   uint64
	token    uint64
	windows  []uint
	index    int
	allow    bool
	update   bool
	relaunch bool
}

func (q *quitGate) begin(windows []uint, update bool, relaunch bool) (uint64, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.token != 0 || q.allow {
		return q.token, false
	}
	q.serial++
	q.token, q.windows, q.index, q.update = q.serial, windows, 0, update
	q.relaunch = relaunch
	return q.token, true
}

type quitStep struct {
	window                     uint
	complete, update, relaunch bool
}

func (q *quitGate) current(token uint64) *quitStep {
	q.mu.Lock()
	defer q.mu.Unlock()
	if token == 0 || token != q.token {
		return nil
	}
	step := &quitStep{complete: q.index == len(q.windows), update: q.update, relaunch: q.relaunch}
	if !step.complete {
		step.window = q.windows[q.index]
	}
	return step
}

func (q *quitGate) approve(token uint64, window uint) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if token == 0 || token != q.token || q.index >= len(q.windows) || q.windows[q.index] != window {
		return false
	}
	q.index++
	return true
}

func (q *quitGate) cancel(token uint64) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if token == 0 || token != q.token || q.allow {
		return false
	}
	q.token, q.windows, q.index = 0, nil, 0
	return true
}

func (q *quitGate) pending() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.token != 0
}

func (q *quitGate) permitted() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.allow
}

func (q *quitGate) commit(token uint64, prepare func() error) (bool, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if token == 0 || token != q.token || q.index != len(q.windows) || q.allow {
		return false, nil
	}
	if err := prepare(); err != nil {
		return false, err
	}
	q.allow = true
	return true, nil
}

func (d *Desktop) abortUpdateQuit() {
	d.quit.mu.Lock()
	token := d.quit.token
	d.quit.allow = false
	d.quit.mu.Unlock()
	_ = os.Remove(d.service.relaunchPath())
	d.cancelQuit(token)
}

func (d *Desktop) shouldQuit() bool {
	if d.quit.permitted() {
		return true
	}
	go d.beginQuit(nativeUpdatePending(), false)
	return false
}

func (d *Desktop) beginQuit(update bool, relaunch bool) {
	d.windowMu.Lock()
	windows := d.native.Window.GetAll()
	sort.Slice(windows, func(i, j int) bool { return windows[i].ID() < windows[j].ID() })
	var ids []uint
	for _, window := range windows {
		if strings.HasPrefix(window.Name(), "day-") {
			ids = append(ids, window.ID())
		}
	}
	token, started := d.quit.begin(ids, update, relaunch)
	d.windowMu.Unlock()
	if started {
		d.advanceQuit(token)
	}
}

func (d *Desktop) advanceQuit(token uint64) {
	step := d.quit.current(token)
	if step == nil {
		return
	}
	if step.complete {
		committed, err := d.quit.commit(token, func() error {
			if step.update {
				return d.service.saveRelaunchDays(d.native.Window.GetAll())
			}
			return nil
		})
		if err != nil {
			d.cancelQuit(token)
			emitToCurrent(d.native, "menu:error", err.Error())
			return
		}
		if committed {
			if step.relaunch && nativeResumeUpdate() {
				return
			}
			d.native.Quit()
		}
		return
	}
	window, exists := d.native.Window.GetByID(step.window)
	if !exists {
		if d.quit.approve(token, step.window) {
			d.advanceQuit(token)
		}
		return
	}
	if window.IsMinimised() {
		window.UnMinimise()
	}
	window.Show()
	window.Focus()
	dispatchToWindow(window, "app:prepare-quit", map[string]any{"token": token, "update": step.update})
}

func (d *Desktop) cancelQuit(token uint64) {
	if d.quit.cancel(token) {
		for _, window := range d.native.Window.GetAll() {
			dispatchToWindow(window, "app:cancel-quit", token)
		}
	}
}

func (a *App) ApproveQuit(ctx context.Context, token uint64) error {
	window, ok := ctx.Value(application.WindowKey).(application.Window)
	if a.desktop == nil || !ok || window == nil {
		return errors.New("calling window is not available")
	}
	if a.desktop.quit.approve(token, window.ID()) {
		go a.desktop.advanceQuit(token)
	}
	return nil
}

func (a *App) CancelQuit(token uint64) {
	if a.desktop != nil {
		a.desktop.cancelQuit(token)
	}
}

type relaunchDays struct {
	StorageRoot string   `json:"storageRoot"`
	Dates       []string `json:"dates"`
}

func (a *App) relaunchPath() string {
	return filepath.Join(filepath.Dir(a.settingsPath), "relaunch.json")
}

func (a *App) saveRelaunchDays(windows []application.Window) error {
	settings, err := a.GetSettings()
	if err != nil {
		return err
	}
	state := relaunchDays{StorageRoot: settings.StorageRoot}
	for _, window := range windows {
		date := strings.TrimPrefix(window.Name(), "day-")
		if validDate(date) {
			state.Dates = append(state.Dates, date)
		}
	}
	sort.Strings(state.Dates)
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(a.relaunchPath()), 0700); err != nil {
		return err
	}
	if err := atomicWriteFile(a.relaunchPath(), data, 0600); err != nil {
		return fmt.Errorf("remember journals before updating: %w", err)
	}
	return nil
}

func (a *App) takeRelaunchDays() ([]string, error) {
	data, err := os.ReadFile(a.relaunchPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var state relaunchDays
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	settings, err := a.GetSettings()
	if err != nil {
		return nil, err
	}
	if state.StorageRoot != settings.StorageRoot {
		return nil, errors.New("journal folder changed since the update; choose a day to reopen")
	}
	seen := make(map[string]bool)
	var dates []string
	for _, date := range state.Dates {
		if !validDate(date) {
			return nil, errors.New("invalid date in relaunch state")
		}
		if !seen[date] {
			dates = append(dates, date)
			seen[date] = true
		}
	}
	if err := os.Remove(a.relaunchPath()); err != nil {
		return nil, err
	}
	return dates, nil
}
