//go:build darwin

package main

/*
#cgo CFLAGS: -fblocks
#cgo LDFLAGS: -framework Cocoa
#include <stdlib.h>
char *jm_start_updates(void);
int jm_automatic_checks(void);
void jm_set_automatic_checks(int enabled);
void jm_check_updates(void);
int jm_update_pending(void);
int jm_resume_update(void);
*/
import "C"

import (
	"errors"
	"sync/atomic"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

var updaterDesktop atomic.Pointer[Desktop]

//export journalistRequestUpdateQuit
func journalistRequestUpdateQuit() {
	if desktop := updaterDesktop.Load(); desktop != nil {
		go func() {
			if desktop.quit.permitted() {
				nativeResumeUpdate()
			} else {
				desktop.beginQuit(true, true)
			}
		}()
	}
}

//export journalistUpdateFailed
func journalistUpdateFailed() {
	if desktop := updaterDesktop.Load(); desktop != nil {
		go desktop.abortUpdateQuit()
	}
}

func startNativeUpdates(d *Desktop) error {
	updaterDesktop.Store(d)
	var message string
	application.InvokeSync(func() {
		if value := C.jm_start_updates(); value != nil {
			message = C.GoString(value)
			C.free(unsafe.Pointer(value))
		}
	})
	if message != "" {
		return errors.New(message)
	}
	return nil
}

func nativeUpdatePending() bool {
	var pending bool
	application.InvokeSync(func() { pending = C.jm_update_pending() != 0 })
	return pending
}

func nativeResumeUpdate() bool {
	var resumed bool
	application.InvokeSync(func() { resumed = C.jm_resume_update() != 0 })
	return resumed
}

func (a *App) GetUpdateStatus() UpdateStatus {
	var status UpdateStatus
	if a.desktop == nil {
		return status
	}
	application.InvokeSync(func() {
		status.Version = buildVersion
		status.AutomaticChecks = C.jm_automatic_checks() != 0
	})
	return status
}

func (a *App) SetAutomaticUpdateChecks(enabled bool) {
	if a.desktop == nil {
		return
	}
	application.InvokeSync(func() {
		value := C.int(0)
		if enabled {
			value = 1
		}
		C.jm_set_automatic_checks(value)
	})
}

func (a *App) CheckForUpdates() {
	if a.desktop != nil {
		application.InvokeSync(func() { C.jm_check_updates() })
	}
}
