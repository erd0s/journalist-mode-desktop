//go:build darwin

package main

/*
void jm_start_command_monitor(void);
*/
import "C"

import (
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type commandState struct {
	Held     bool   `json:"held"`
	Used     bool   `json:"used"`
	Sequence uint64 `json:"sequence"`
}

var latestCommandState atomic.Pointer[commandState]
var commandStateChanged = make(chan struct{}, 1)

//export journalistCommandState
func journalistCommandState(held C.int, used C.int, sequence C.ulonglong) {
	latestCommandState.Store(&commandState{held != 0, used != 0, uint64(sequence)})
	// Never block AppKit while Go dispatches to a webview. Coalescing retains
	// the latest release, including when several events arrive in one frame.
	select {
	case commandStateChanged <- struct{}{}:
	default:
	}
}

func startNativeCommandHints(d *Desktop) {
	go func() {
		for range commandStateChanged {
			state := latestCommandState.Load()
			if state == nil {
				continue
			}
			if !state.Held {
				for _, window := range d.native.Window.GetAll() {
					dispatchToWindow(window, "keyboard:command-state", state)
				}
			} else if window := d.native.Window.Current(); window != nil {
				dispatchToWindow(window, "keyboard:command-state", state)
			}
		}
	}()
	application.InvokeSync(func() { C.jm_start_command_monitor() })
}
