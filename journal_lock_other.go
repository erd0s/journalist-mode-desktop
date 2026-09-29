//go:build !darwin && !linux

package main

import (
	"errors"
	"os"
)

func lockJournalHandle(file *os.File) error {
	return errors.New("journal file locking is unavailable on this platform")
}
