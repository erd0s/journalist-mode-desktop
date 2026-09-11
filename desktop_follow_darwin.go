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
