package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	settingsDirectoryName = "Journalist Mode"
	defaultEditorFont     = "avenir-next-condensed"
)

var (
	doingFilenamePattern = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})(?:_(\d+))?\.jm\.md$`)
	todoFilenamePattern  = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})\.jmtodo\.md$`)
)

// Settings contains the small amount of application state that is not stored
// in the journal files themselves.
type Settings struct {
	StorageRoot string `json:"storageRoot"`
	EditorFont  string `json:"editorFont"`
}

// DaySummary is the information needed by the welcome screen.
type DaySummary struct {
	Date       string `json:"date"`
	DoingCount int    `json:"doingCount"`
	HasTodo    bool   `json:"hasTodo"`
}

// JournalFile is one plain-text file displayed by the day workspace.
type JournalFile struct {
	Path        string `json:"path"`
	Name        string `json:"name"`
	Content     string `json:"content"`
	Exists      bool   `json:"exists"`
	StreamIndex int    `json:"streamIndex"`
}

// SaveResult reports whether an optimistic journal save reached disk. When
// Conflict is true, Content is the newer disk version that was preserved.
type SaveResult struct {
	Saved    bool   `json:"saved"`
	Conflict bool   `json:"conflict"`
	Content  string `json:"content"`
	Exists   bool   `json:"exists"`
}

// DayData contains the todo and all Doing streams discovered for one date.
type DayData struct {
	Date  string        `json:"date"`
	Todo  JournalFile   `json:"todo"`
	Doing []JournalFile `json:"doing"`
}

// App is the native boundary for settings and journal-file access.
type App struct {
	ctx          context.Context
	homeDir      string
	settingsPath string
	launchDate   string
	fileMu       sync.Mutex
}

// NewApp creates the application using the current user's standard folders.
func NewApp(launchDate ...string) *App {
	homeDir, _ := os.UserHomeDir()
	configDir, err := os.UserConfigDir()
	if err != nil || configDir == "" {
		configDir = filepath.Join(homeDir, ".config")
	}

	app := newAppForPaths(homeDir, filepath.Join(configDir, settingsDirectoryName, "settings.json"))
	if len(launchDate) > 0 && validDate(launchDate[0]) {
		app.launchDate = launchDate[0]
	}
	return app
}

func newAppForPaths(homeDir, settingsPath string) *App {
	return &App{
		homeDir:      homeDir,
		settingsPath: settingsPath,
	}
}

// startup stores the Wails context used by native dialogs.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	if err := a.registerDayWindow(); err != nil {
		runtime.LogError(ctx, err.Error())
	}
}

func (a *App) shutdown(_ context.Context) {
	if err := a.unregisterDayWindow(); err != nil && a.ctx != nil {
		runtime.LogError(a.ctx, err.Error())
	}
}

// GetLaunchDate returns the day requested when this window was opened.
func (a *App) GetLaunchDate() string {
	return a.launchDate
}

// OpenDayWindow focuses an existing window for the date or opens a new one.
func (a *App) OpenDayWindow(date string) (string, error) {
	if !validDate(date) {
		return "", errors.New("date must use YYYY-MM-DD")
	}

	pid, open, err := a.registeredDayPID(date)
	if err != nil {
		return "", err
	}
	if open {
		if err := focusProcess(pid); err != nil {
			return "", fmt.Errorf("focus journal day: %w", err)
		}
		return "focused", nil
	}

	if err := a.openWindow(date); err != nil {
		return "", err
	}
	return "opened", nil
}

func (a *App) openWindow(date string) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate application: %w", err)
	}

	const bundleMarker = ".app/Contents/MacOS/"
	if marker := strings.LastIndex(executable, bundleMarker); marker >= 0 {
		bundlePath := executable[:marker+len(".app")]
		arguments := []string{"-n", bundlePath}
		if date != "" {
			arguments = append(arguments, "--args", "--day", date)
		}
		if err := exec.Command("open", arguments...).Start(); err != nil {
			return fmt.Errorf("open new window: %w", err)
		}
		return nil
	}

	arguments := withoutLaunchDay(os.Args[1:])
	if date != "" {
		arguments = append(arguments, "--day", date)
	}
	command := exec.Command(executable, arguments...)
	if err := command.Start(); err != nil {
		return fmt.Errorf("open new window: %w", err)
	}
	return nil
}

func (a *App) registerDayWindow() error {
	if a.launchDate == "" {
		return nil
	}
	registration := []byte(strconv.Itoa(os.Getpid()))
	if err := atomicWriteFile(a.dayWindowPath(a.launchDate), registration, 0o600); err != nil {
		return fmt.Errorf("register journal window: %w", err)
	}
	return nil
}

func (a *App) unregisterDayWindow() error {
	if a.launchDate == "" {
		return nil
	}
	path := a.dayWindowPath(a.launchDate)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read journal window registration: %w", err)
	}
	if strings.TrimSpace(string(data)) != strconv.Itoa(os.Getpid()) {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove journal window registration: %w", err)
	}
	return nil
}

func (a *App) registeredDayPID(date string) (int, bool, error) {
	path := a.dayWindowPath(date)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("read journal window registration: %w", err)
	}

	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err == nil && pid > 0 && processAlive(pid) {
		return pid, true, nil
	}
	if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		return 0, false, fmt.Errorf("remove stale journal window registration: %w", removeErr)
	}
	return 0, false, nil
}

func (a *App) dayWindowPath(date string) string {
	return filepath.Join(filepath.Dir(a.settingsPath), "windows", date+".pid")
}

func processAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = process.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}

func focusProcess(pid int) error {
	script := fmt.Sprintf(
		`tell application "System Events" to set frontmost of first process whose unix id is %d to true`,
		pid,
	)
	return exec.Command("osascript", "-e", script).Run()
}

// GetSettings returns persisted settings or the default ~/Documents/JM root.
func (a *App) GetSettings() (Settings, error) {
	settings := Settings{
		StorageRoot: filepath.Join(a.homeDir, "Documents", "JM"),
		EditorFont:  defaultEditorFont,
	}

	data, err := os.ReadFile(a.settingsPath)
	if errors.Is(err, os.ErrNotExist) {
		return settings, nil
	}
	if err != nil {
		return Settings{}, fmt.Errorf("read settings: %w", err)
	}

	if err := json.Unmarshal(data, &settings); err != nil {
		return Settings{}, fmt.Errorf("parse settings: %w", err)
	}
	if strings.TrimSpace(settings.StorageRoot) == "" {
		settings.StorageRoot = filepath.Join(a.homeDir, "Documents", "JM")
	}
	settings.StorageRoot = a.expandPath(settings.StorageRoot)
	settings.EditorFont = normaliseEditorFont(settings.EditorFont)

	return settings, nil
}

// SaveSettings persists a journal root and creates its Doing/Todo folders.
func (a *App) SaveSettings(settings Settings) (Settings, error) {
	root := a.expandPath(settings.StorageRoot)
	if root == "" || !filepath.IsAbs(root) {
		return Settings{}, errors.New("storage location must be an absolute folder")
	}

	settings.StorageRoot = filepath.Clean(root)
	settings.EditorFont = normaliseEditorFont(settings.EditorFont)
	if err := ensureJournalFolders(settings.StorageRoot); err != nil {
		return Settings{}, err
	}

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return Settings{}, fmt.Errorf("encode settings: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(a.settingsPath), 0o755); err != nil {
		return Settings{}, fmt.Errorf("create settings folder: %w", err)
	}
	if err := atomicWriteFile(a.settingsPath, data, 0o600); err != nil {
		return Settings{}, fmt.Errorf("save settings: %w", err)
	}

	return settings, nil
}

// SetEditorFont persists an editor font selected from the native View menu.
func (a *App) SetEditorFont(font string) (Settings, error) {
	if !validEditorFont(font) {
		return Settings{}, errors.New("unknown editor font")
	}
	settings, err := a.GetSettings()
	if err != nil {
		return Settings{}, err
	}
	settings.EditorFont = font
	return a.SaveSettings(settings)
}

// ChooseStorageDirectory opens the native folder picker.
func (a *App) ChooseStorageDirectory() (string, error) {
	if a.ctx == nil {
		return "", errors.New("folder picker is not available before app startup")
	}

	settings, err := a.GetSettings()
	if err != nil {
		return "", err
	}

	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		DefaultDirectory:     settings.StorageRoot,
		Title:                "Choose Journalist Mode folder",
		CanCreateDirectories: true,
		ResolvesAliases:      true,
	})
}

// ListDays discovers dates represented by either Doing or Todo files.
func (a *App) ListDays() ([]DaySummary, error) {
	settings, err := a.GetSettings()
	if err != nil {
		return nil, err
	}
	if err := ensureJournalFolders(settings.StorageRoot); err != nil {
		return nil, err
	}

	days := make(map[string]*DaySummary)

	doingEntries, err := os.ReadDir(filepath.Join(settings.StorageRoot, "Doing"))
	if err != nil {
		return nil, fmt.Errorf("read Doing folder: %w", err)
	}
	for _, entry := range doingEntries {
		if entry.IsDir() {
			continue
		}
		match := doingFilenamePattern.FindStringSubmatch(entry.Name())
		if match == nil || !validDate(match[1]) {
			continue
		}
		day := getOrCreateDay(days, match[1])
		day.DoingCount++
	}

	todoEntries, err := os.ReadDir(filepath.Join(settings.StorageRoot, "Todo"))
	if err != nil {
		return nil, fmt.Errorf("read Todo folder: %w", err)
	}
	for _, entry := range todoEntries {
		if entry.IsDir() {
			continue
		}
		match := todoFilenamePattern.FindStringSubmatch(entry.Name())
		if match == nil || !validDate(match[1]) {
			continue
		}
		getOrCreateDay(days, match[1]).HasTodo = true
	}

	result := make([]DaySummary, 0, len(days))
	for _, day := range days {
		result = append(result, *day)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Date > result[j].Date
	})

	return result, nil
}

// CreateToday creates today's base Doing and Todo files without truncating
// anything that already exists.
func (a *App) CreateToday() (DayData, error) {
	return a.CreateDay(time.Now().Format("2006-01-02"))
}

// CreateDay creates the base file set for a validated date.
func (a *App) CreateDay(date string) (DayData, error) {
	if !validDate(date) {
		return DayData{}, errors.New("date must use YYYY-MM-DD")
	}

	settings, err := a.GetSettings()
	if err != nil {
		return DayData{}, err
	}
	if err := ensureJournalFolders(settings.StorageRoot); err != nil {
		return DayData{}, err
	}

	paths := []string{
		filepath.Join(settings.StorageRoot, "Doing", date+".jm.md"),
		filepath.Join(settings.StorageRoot, "Todo", date+".jmtodo.md"),
	}
	for _, path := range paths {
		file, createErr := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o644)
		if createErr != nil {
			return DayData{}, fmt.Errorf("create %s: %w", filepath.Base(path), createErr)
		}
		if closeErr := file.Close(); closeErr != nil {
			return DayData{}, fmt.Errorf("close %s: %w", filepath.Base(path), closeErr)
		}
	}

	return a.OpenDay(date)
}

// CreateDoingStream adds the next numbered Doing file for an open day. The
// exclusive create keeps simultaneous shortcuts or app instances from choosing
// the same filename.
func (a *App) CreateDoingStream(date string) (JournalFile, error) {
	if !validDate(date) {
		return JournalFile{}, errors.New("date must use YYYY-MM-DD")
	}

	a.fileMu.Lock()
	file, err := a.createDoingStream(date)
	a.fileMu.Unlock()
	if err != nil {
		return JournalFile{}, err
	}

	if a.ctx != nil {
		runtime.MenuSetApplicationMenu(a.ctx, applicationMenu(a))
	}
	return file, nil
}

func (a *App) createDoingStream(date string) (JournalFile, error) {
	settings, err := a.GetSettings()
	if err != nil {
		return JournalFile{}, err
	}
	if err := ensureJournalFolders(settings.StorageRoot); err != nil {
		return JournalFile{}, err
	}

	doingDir := filepath.Join(settings.StorageRoot, "Doing")
	entries, err := os.ReadDir(doingDir)
	if err != nil {
		return JournalFile{}, fmt.Errorf("read Doing folder: %w", err)
	}

	nextIndex := 1
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		match := doingFilenamePattern.FindStringSubmatch(entry.Name())
		if match == nil || match[1] != date {
			continue
		}
		index := 1
		if match[2] != "" {
			index, _ = strconv.Atoi(match[2])
		}
		if index >= nextIndex {
			nextIndex = index + 1
		}
	}

	for {
		name := date + ".jm.md"
		if nextIndex > 1 {
			name = fmt.Sprintf("%s_%d.jm.md", date, nextIndex)
		}
		path := filepath.Join(doingDir, name)
		created, createErr := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if errors.Is(createErr, os.ErrExist) {
			nextIndex++
			continue
		}
		if createErr != nil {
			return JournalFile{}, fmt.Errorf("create %s: %w", name, createErr)
		}
		if closeErr := created.Close(); closeErr != nil {
			return JournalFile{}, fmt.Errorf("close %s: %w", name, closeErr)
		}
		return JournalFile{
			Path:        path,
			Name:        name,
			Exists:      true,
			StreamIndex: nextIndex,
		}, nil
	}
}

// OpenDay reads an existing day's plain-text files without changing them.
func (a *App) OpenDay(date string) (DayData, error) {
	if !validDate(date) {
		return DayData{}, errors.New("date must use YYYY-MM-DD")
	}

	settings, err := a.GetSettings()
	if err != nil {
		return DayData{}, err
	}
	if err := ensureJournalFolders(settings.StorageRoot); err != nil {
		return DayData{}, err
	}

	todoPath := filepath.Join(settings.StorageRoot, "Todo", date+".jmtodo.md")
	todo, err := readJournalFile(todoPath, 0)
	if err != nil {
		return DayData{}, err
	}

	doingDir := filepath.Join(settings.StorageRoot, "Doing")
	entries, err := os.ReadDir(doingDir)
	if err != nil {
		return DayData{}, fmt.Errorf("read Doing folder: %w", err)
	}

	doing := make([]JournalFile, 0)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		match := doingFilenamePattern.FindStringSubmatch(entry.Name())
		if match == nil || match[1] != date {
			continue
		}

		streamIndex := 1
		if match[2] != "" {
			streamIndex, _ = strconv.Atoi(match[2])
		}
		file, readErr := readJournalFile(filepath.Join(doingDir, entry.Name()), streamIndex)
		if readErr != nil {
			return DayData{}, readErr
		}
		doing = append(doing, file)
	}

	sort.Slice(doing, func(i, j int) bool {
		if doing[i].StreamIndex == doing[j].StreamIndex {
			return doing[i].Name < doing[j].Name
		}
		return doing[i].StreamIndex < doing[j].StreamIndex
	})

	return DayData{Date: date, Todo: todo, Doing: doing}, nil
}

// ReadJournalFiles returns fresh snapshots for open panes. The frontend polls
// this in one batch so changes made by editors, scripts, or coding agents are
// noticed without installing a long-lived filesystem watcher.
func (a *App) ReadJournalFiles(paths []string) ([]JournalFile, error) {
	a.fileMu.Lock()
	defer a.fileMu.Unlock()

	settings, err := a.GetSettings()
	if err != nil {
		return nil, err
	}

	files := make([]JournalFile, 0, len(paths))
	for _, path := range paths {
		cleanPath := filepath.Clean(path)
		if !a.isJournalPath(settings.StorageRoot, cleanPath) {
			return nil, errors.New("refusing to read outside the configured journal folders")
		}
		file, readErr := readJournalFile(cleanPath, 0)
		if readErr != nil {
			return nil, readErr
		}
		files = append(files, file)
	}
	return files, nil
}

// SaveFile atomically saves a journal file inside the configured Doing/Todo
// folders. Unless force is explicit, the save only proceeds when disk still
// matches the version the editor started from.
func (a *App) SaveFile(path, content, expectedContent string, force bool) (SaveResult, error) {
	a.fileMu.Lock()
	defer a.fileMu.Unlock()

	settings, err := a.GetSettings()
	if err != nil {
		return SaveResult{}, err
	}

	cleanPath := filepath.Clean(path)
	if !a.isJournalPath(settings.StorageRoot, cleanPath) {
		return SaveResult{}, errors.New("refusing to write outside the configured journal folders")
	}

	diskData, readErr := os.ReadFile(cleanPath)
	diskExists := true
	if errors.Is(readErr, os.ErrNotExist) {
		diskData = nil
		diskExists = false
	} else if readErr != nil {
		return SaveResult{}, fmt.Errorf("read %s before saving: %w", filepath.Base(cleanPath), readErr)
	}
	diskContent := string(diskData)
	if diskExists && diskContent == content {
		return SaveResult{Saved: true, Content: content, Exists: true}, nil
	}
	if !force && diskContent != expectedContent {
		return SaveResult{
			Conflict: true,
			Content:  diskContent,
			Exists:   diskExists,
		}, nil
	}

	mode := os.FileMode(0o644)
	if info, statErr := os.Stat(cleanPath); statErr == nil {
		mode = info.Mode().Perm()
	}
	if err := atomicWriteFile(cleanPath, []byte(content), mode); err != nil {
		return SaveResult{}, fmt.Errorf("save %s: %w", filepath.Base(cleanPath), err)
	}

	return SaveResult{Saved: true, Content: content, Exists: true}, nil
}

func (a *App) expandPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "~" {
		return a.homeDir
	}
	if strings.HasPrefix(path, "~/") {
		return filepath.Join(a.homeDir, strings.TrimPrefix(path, "~/"))
	}
	return path
}

func (a *App) isJournalPath(root, path string) bool {
	for _, folder := range []string{"Doing", "Todo"} {
		base := filepath.Join(root, folder)
		relative, err := filepath.Rel(base, path)
		if err == nil && relative != "." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && relative != ".." {
			return true
		}
	}
	return false
}

func ensureJournalFolders(root string) error {
	for _, folder := range []string{"Doing", "Todo"} {
		if err := os.MkdirAll(filepath.Join(root, folder), 0o755); err != nil {
			return fmt.Errorf("create %s folder: %w", folder, err)
		}
	}
	return nil
}

func getOrCreateDay(days map[string]*DaySummary, date string) *DaySummary {
	if day, ok := days[date]; ok {
		return day
	}
	day := &DaySummary{Date: date}
	days[date] = day
	return day
}

func validDate(date string) bool {
	parsed, err := time.Parse("2006-01-02", date)
	return err == nil && parsed.Format("2006-01-02") == date
}

func readJournalFile(path string, streamIndex int) (JournalFile, error) {
	file := JournalFile{
		Path:        path,
		Name:        filepath.Base(path),
		StreamIndex: streamIndex,
	}

	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return file, nil
	}
	if err != nil {
		return JournalFile{}, fmt.Errorf("read %s: %w", filepath.Base(path), err)
	}

	file.Content = string(data)
	file.Exists = true
	return file, nil
}

func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}

	temp, err := os.CreateTemp(filepath.Dir(path), ".jm-save-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)

	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}

	return os.Rename(tempName, path)
}

func withoutLaunchDay(args []string) []string {
	result := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		if args[index] == "--day" {
			index++
			continue
		}
		if strings.HasPrefix(args[index], "--day=") {
			continue
		}
		result = append(result, args[index])
	}
	return result
}

func validEditorFont(font string) bool {
	switch font {
	case "avenir-next-condensed", "din-condensed", "pt-sans-narrow", "system":
		return true
	default:
		return false
	}
}

func normaliseEditorFont(font string) string {
	if validEditorFont(font) {
		return font
	}
	return defaultEditorFont
}
