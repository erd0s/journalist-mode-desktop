package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const debugLogVersion = 1

// DebugFileSnapshot captures both the editor's current content and the last
// content observed on disk. Debug logs deliberately contain journal text.
type DebugFileSnapshot struct {
	Path             string `json:"path"`
	Name             string `json:"name"`
	Kind             string `json:"kind"`
	StreamIndex      int    `json:"streamIndex"`
	Content          string `json:"content"`
	DiskContent      string `json:"diskContent"`
	SaveState        string `json:"saveState"`
	CompletedVisible bool   `json:"completedVisible"`
	Focused          bool   `json:"focused"`
	Visible          bool   `json:"visible"`
}

// DebugEvent is one frontend interaction and its complete workspace snapshot.
type DebugEvent struct {
	ClientTimestamp string              `json:"clientTimestamp"`
	Sequence        uint64              `json:"sequence"`
	Window          string              `json:"window"`
	Category        string              `json:"category"`
	Action          string              `json:"action"`
	Details         map[string]string   `json:"details"`
	Files           []DebugFileSnapshot `json:"files"`
}

type debugLogEntry struct {
	Version    int    `json:"version"`
	SessionID  string `json:"sessionId"`
	RecordedAt string `json:"recordedAt"`
	DebugEvent
}

// RecordDebugEvents appends a short frontend batch to the active JSONL log.
// Calls are ignored when debug mode is disabled so a stale window cannot keep
// collecting journal content after the setting has been turned off.
func (a *App) RecordDebugEvents(events []DebugEvent) error {
	if len(events) == 0 {
		return nil
	}
	if err := a.ensureDebugModeKnown(); err != nil {
		return err
	}

	a.debugMu.Lock()
	defer a.debugMu.Unlock()
	if !a.debugEnabled {
		return nil
	}
	if err := a.ensureDebugSessionLocked(); err != nil {
		return err
	}

	file, err := os.OpenFile(a.debugLogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open debug log: %w", err)
	}
	defer file.Close()

	encoder := json.NewEncoder(file)
	checkpoint := false
	for _, event := range events {
		event.Category = strings.TrimSpace(event.Category)
		event.Action = strings.TrimSpace(event.Action)
		if event.Category == "" {
			event.Category = "interaction"
		}
		if event.Action == "" {
			event.Action = "unknown"
		}
		entry := debugLogEntry{
			Version:    debugLogVersion,
			SessionID:  a.debugSession,
			RecordedAt: time.Now().UTC().Format(time.RFC3339Nano),
			DebugEvent: event,
		}
		if err := encoder.Encode(entry); err != nil {
			return fmt.Errorf("write debug log: %w", err)
		}
		checkpoint = checkpoint || event.Category == "checkpoint"
	}
	if checkpoint {
		if err := file.Sync(); err != nil {
			return fmt.Errorf("flush debug checkpoint: %w", err)
		}
	}
	return nil
}

// GetDebugLogDirectory returns the private application-support folder used by
// the flight recorder. It does not create the folder until logging is enabled
// or the user explicitly asks to reveal it.
func (a *App) GetDebugLogDirectory() string {
	return a.debugLogDirectory()
}

// OpenDebugLogFolder reveals the recorder folder in Finder or the platform's
// equivalent file manager.
func (a *App) OpenDebugLogFolder() error {
	if a.desktop == nil {
		return errors.New("file manager is not available")
	}
	directory := a.debugLogDirectory()
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create debug log folder: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return fmt.Errorf("secure debug log folder: %w", err)
	}
	return a.desktop.native.Env.OpenFileManager(directory, false)
}

func (a *App) ensureDebugModeKnown() error {
	a.debugMu.Lock()
	known := a.debugKnown
	a.debugMu.Unlock()
	if known {
		return nil
	}
	_, err := a.GetSettings()
	return err
}

func (a *App) setDebugMode(enabled bool) {
	a.debugMu.Lock()
	defer a.debugMu.Unlock()
	if !a.debugKnown || a.debugEnabled != enabled {
		a.debugSession = ""
		a.debugLogPath = ""
	}
	a.debugKnown = true
	a.debugEnabled = enabled
}

func (a *App) ensureDebugSessionLocked() error {
	if a.debugLogPath != "" {
		return nil
	}
	directory := a.debugLogDirectory()
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create debug log folder: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return fmt.Errorf("secure debug log folder: %w", err)
	}

	started := time.Now().UTC().Format("20060102T150405.000000000Z")
	a.debugSession = fmt.Sprintf("%s-%d", started, os.Getpid())
	a.debugLogPath = filepath.Join(directory, "debug-"+a.debugSession+".jsonl")
	file, err := os.OpenFile(a.debugLogPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create debug log: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close debug log: %w", err)
	}
	return nil
}

func (a *App) debugLogDirectory() string {
	return filepath.Join(filepath.Dir(a.settingsPath), "debug")
}
