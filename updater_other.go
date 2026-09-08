//go:build !darwin

package main

import "errors"

func startNativeUpdates(*Desktop) error {
	return errors.New("automatic updates are available on macOS")
}
func nativeUpdatePending() bool              { return false }
func nativeResumeUpdate() bool               { return false }
func (a *App) GetUpdateStatus() UpdateStatus { return UpdateStatus{Version: "Development build"} }
func (a *App) SetAutomaticUpdateChecks(bool) {}
func (a *App) CheckForUpdates()              {}
