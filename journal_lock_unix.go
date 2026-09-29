//go:build darwin || linux

package main

import (
	"golang.org/x/sys/unix"
	"os"
)

func lockJournalHandle(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
}
