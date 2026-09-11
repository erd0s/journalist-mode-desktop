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
func journalistDesktopSnapshot(data *C.char, baseline C.int) {
	// Copy and return at once; AppKit is waiting on the main thread. A
	// baseline (wake or display change) replaces the reference state instead
	// of being followed.
	follower := desktopFollowerRef.Load()
	if follower == nil || data == nil {
		return
	}
	if baseline != 0 {
		follower.submitBaseline([]byte(C.GoString(data)))
		return
	}
	follower.submit([]byte(C.GoString(data)))
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
