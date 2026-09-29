package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const reorderRecoveryName = ".jm-reorder-recovery.json"

// A stable lock file coordinates app instances even when a journal inode is
// replaced by rename. Never unlink it: that would allow two lock owners.
func beginJournalAccess(root string) (func(), error) {
	lock, err := os.OpenFile(filepath.Join(root, ".jm-journal.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockJournalHandle(lock); err != nil {
		lock.Close()
		return nil, fmt.Errorf("journal is busy; could not obtain its file lock: %w", err)
	}
	release := func() { lock.Close() }
	if err := recoverDoingMove(root); err != nil {
		release()
		return nil, err
	}
	return release, nil
}

type doingMoveEntry struct {
	Name   string      `json:"name"`
	Before []byte      `json:"before"`
	After  []byte      `json:"after"`
	Mode   os.FileMode `json:"mode"`
}

type doingMoveRecovery struct {
	Entries []doingMoveEntry `json:"entries"`
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// Refuse symbolic links and verify the inode before and after acquiring its
// lock. The shuffle also rejects aliases among the affected files.
func lockDoingFile(path string) (*os.File, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", filepath.Base(path))
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) {
		file.Close()
		return nil, fmt.Errorf("%s changed while obtaining its lock", filepath.Base(path))
	}
	if err := lockJournalHandle(file); err != nil {
		file.Close()
		return nil, fmt.Errorf("%s is busy; could not obtain its file lock: %w", filepath.Base(path), err)
	}
	current, err := os.Lstat(path)
	if err != nil || !os.SameFile(actual, current) || !current.Mode().IsRegular() {
		file.Close()
		return nil, fmt.Errorf("%s changed while obtaining its lock", filepath.Base(path))
	}
	return file, nil
}

func checkDoingDirectory(root string) error {
	info, err := os.Lstat(filepath.Join(root, "Doing"))
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("Doing must be a directory, not a symbolic link")
	}
	return nil
}

// Each replacement is atomic and its new inode stays locked until the entire
// operation ends. The recovery record is durable before the first replacement.
func replaceDoingFile(path string, data []byte, mode os.FileMode) (*os.File, error) {
	file, err := os.CreateTemp(filepath.Dir(path), ".jm-move-*")
	if err != nil {
		return nil, err
	}
	name := file.Name()
	defer os.Remove(name)
	fail := func(err error) (*os.File, error) { file.Close(); return nil, err }
	if err := lockJournalHandle(file); err != nil {
		return fail(err)
	}
	if _, err := file.Write(data); err != nil {
		return fail(err)
	}
	if err := file.Chmod(mode.Perm()); err != nil {
		return fail(err)
	}
	if err := file.Sync(); err != nil {
		return fail(err)
	}
	if err := os.Rename(name, path); err != nil {
		return fail(err)
	}
	return file, nil
}

func closeJournalHandles(files []*os.File) {
	for _, file := range files {
		file.Close()
	}
}

func recoverDoingMove(root string) error {
	path := filepath.Join(root, reorderRecoveryName)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var recovery doingMoveRecovery
	if err := json.Unmarshal(data, &recovery); err != nil {
		return fmt.Errorf("read shuffle recovery record: %w", err)
	}
	if len(recovery.Entries) < 2 {
		return errors.New("invalid shuffle recovery record")
	}
	if err := checkDoingDirectory(root); err != nil {
		return err
	}
	var handles []*os.File
	defer func() { closeJournalHandles(handles) }()
	seen := make(map[string]bool)
	// Preflight every file before rolling back any of them. Never overwrite a
	// third-party edit made after an interrupted move; retain both versions.
	for _, entry := range recovery.Entries {
		if !doingFilenamePattern.MatchString(entry.Name) || filepath.Base(entry.Name) != entry.Name || seen[entry.Name] {
			return errors.New("invalid path in shuffle recovery record")
		}
		seen[entry.Name] = true
		target := filepath.Join(root, "Doing", entry.Name)
		file, err := lockDoingFile(target)
		if err != nil {
			return fmt.Errorf("shuffle recovery needs attention (%s): %w", path, err)
		}
		handles = append(handles, file)
		current, err := os.ReadFile(target)
		if err != nil {
			return err
		}
		if !bytes.Equal(current, entry.Before) && !bytes.Equal(current, entry.After) {
			return fmt.Errorf("%s changed after an interrupted shuffle; originals are preserved in %s; resolve recovery before continuing", entry.Name, path)
		}
	}
	for _, entry := range recovery.Entries {
		file, err := replaceDoingFile(filepath.Join(root, "Doing", entry.Name), entry.Before, entry.Mode)
		if err != nil {
			return fmt.Errorf("restore interrupted shuffle (originals in %s): %w", path, err)
		}
		handles = append(handles, file)
	}
	if err := syncDirectory(filepath.Join(root, "Doing")); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncDirectory(root)
}

// MoveDoingContents inserts one stream's contents at another fixed position.
// Expected contains every visible Doing snapshot; stale or missing files abort
// before any write. Filenames, stream numbers and Todo never move.
func (a *App) MoveDoingContents(date string, from, to int, expected []JournalFile) ([]JournalFile, error) {
	if !validDate(date) {
		return nil, errors.New("date must use YYYY-MM-DD")
	}
	a.fileMu.Lock()
	defer a.fileMu.Unlock()
	settings, err := a.GetSettings()
	if err != nil {
		return nil, err
	}
	release, err := beginJournalAccess(settings.StorageRoot)
	if err != nil {
		return nil, err
	}
	defer release()
	if err := checkDoingDirectory(settings.StorageRoot); err != nil {
		return nil, err
	}
	day, err := a.openDay(date, settings)
	if err != nil {
		return nil, err
	}
	if len(expected) != len(day.Doing) {
		return nil, errors.New("Doing files changed; refresh before shuffling")
	}
	source, destination := -1, -1
	indices := make(map[int]bool)
	for i, file := range day.Doing {
		if file.StreamIndex < 1 || indices[file.StreamIndex] {
			return nil, errors.New("Doing stream numbers must be positive and unique before shuffling")
		}
		indices[file.StreamIndex] = true
		if file.StreamIndex == from {
			source = i
		}
		if file.StreamIndex == to {
			destination = i
		}
		if file.Path != expected[i].Path || !expected[i].Exists || file.Content != expected[i].Content {
			return nil, fmt.Errorf("%s changed; refresh before shuffling", file.Name)
		}
	}
	if source < 0 || destination < 0 {
		return nil, errors.New("choose two existing Doing streams")
	}
	if source == destination {
		return day.Doing, nil
	}
	low, high := min(source, destination), max(source, destination)
	contents := make([]string, len(day.Doing))
	for i, file := range day.Doing {
		contents[i] = file.Content
	}
	moving := contents[source]
	if source > destination {
		copy(contents[destination+1:source+1], contents[destination:source])
	} else {
		copy(contents[source:destination], contents[source+1:destination+1])
	}
	contents[destination] = moving
	var handles []*os.File
	defer func() { closeJournalHandles(handles) }()
	recovery := doingMoveRecovery{}
	var infos []os.FileInfo
	for i := low; i <= high; i++ {
		file := day.Doing[i]
		handle, err := lockDoingFile(file.Path)
		if err != nil {
			return nil, err
		}
		handles = append(handles, handle)
		info, err := handle.Stat()
		if err != nil {
			return nil, err
		}
		for _, other := range infos {
			if os.SameFile(info, other) {
				return nil, errors.New("Doing files must not be hard links to each other")
			}
		}
		infos = append(infos, info)
		current, err := os.ReadFile(file.Path)
		if err != nil {
			return nil, err
		}
		if string(current) != expected[i].Content {
			return nil, fmt.Errorf("%s changed; refresh before shuffling", file.Name)
		}
		recovery.Entries = append(recovery.Entries, doingMoveEntry{file.Name, current, []byte(contents[i]), info.Mode().Perm()})
	}
	if err := commitDoingMove(settings.StorageRoot, recovery, replaceDoingFile); err != nil {
		// Keep the stable journal lock while reacquiring the current inodes for
		// rollback. Release original and replacement inode locks first.
		closeJournalHandles(handles)
		handles = nil
		return nil, errors.Join(fmt.Errorf("shuffle failed: %w", err), recoverDoingMove(settings.StorageRoot))
	}
	for i := range day.Doing {
		day.Doing[i].Content = contents[i]
	}
	return day.Doing, nil
}

// The caller holds the journal lock and every original file lock. The injected
// replacement operation lets tests exercise failures after a partial commit.
func commitDoingMove(root string, recovery doingMoveRecovery, replace func(string, []byte, os.FileMode) (*os.File, error)) error {
	record, err := json.Marshal(recovery)
	if err != nil {
		return err
	}
	recoveryPath := filepath.Join(root, reorderRecoveryName)
	if err := atomicWriteFile(recoveryPath, record, 0o600); err != nil {
		return err
	}
	if err := syncDirectory(root); err != nil {
		return err
	}
	var handles []*os.File
	defer func() { closeJournalHandles(handles) }()
	for _, entry := range recovery.Entries {
		handle, err := replace(filepath.Join(root, "Doing", entry.Name), entry.After, entry.Mode)
		if err != nil {
			return err
		}
		handles = append(handles, handle)
	}
	if err := syncDirectory(filepath.Join(root, "Doing")); err != nil {
		return err
	}
	if err := os.Remove(recoveryPath); err != nil {
		return err
	}
	return syncDirectory(root)
}
