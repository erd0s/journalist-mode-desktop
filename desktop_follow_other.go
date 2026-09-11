//go:build !darwin

package main

import "errors"

func startNativeDesktopFollow(*Desktop) error {
	return errors.New("following Mission Control desktops needs macOS")
}

func nativeDesktopSnapshot() ([]byte, error) {
	return nil, errors.New("following Mission Control desktops needs macOS")
}
