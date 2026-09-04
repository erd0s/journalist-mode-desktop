package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

const (
	applicationName = "Journalist Mode"
	welcomeWindow   = "welcome"
	settingsWindow  = "settings"
)

var singleInstanceKey = [32]byte{
	0x6a, 0x6f, 0x75, 0x72, 0x6e, 0x61, 0x6c, 0x69,
	0x73, 0x74, 0x2d, 0x6d, 0x6f, 0x64, 0x65, 0x2d,
	0x64, 0x65, 0x73, 0x6b, 0x74, 0x6f, 0x70, 0x2d,
	0x77, 0x69, 0x6e, 0x64, 0x6f, 0x77, 0x73, 0x21,
}

// Desktop owns native windows. Journal data remains in App so every window
// shares one service and one file lock inside a single macOS application.
type Desktop struct {
	native        *application.App
	windowMu      sync.Mutex
	closeMu       sync.Mutex
	approvedClose map[uint]bool
}

func main() {
	frontendAssets, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}

	service := NewApp()
	var desktop *Desktop
	native := application.New(application.Options{
		Name:        applicationName,
		Description: "A plain-text workspace for parallel streams of thought.",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(frontendAssets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true,
		},
		Linux: application.LinuxOptions{
			DisableQuitOnLastWindowClosed: true,
			ProgramName:                   applicationName,
		},
		Services: []application.Service{application.NewService(service)},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID:      "com.dirkstewart.journalist-mode",
			EncryptionKey: singleInstanceKey,
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				if desktop != nil {
					desktop.OpenWelcomeWindow()
				}
			},
		},
	})

	desktop = &Desktop{
		native:        native,
		approvedClose: make(map[uint]bool),
	}
	service.desktop = desktop

	native.Menu.Set(applicationMenu(native, service, desktop))
	native.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(*application.ApplicationEvent) {
		if len(native.Window.GetAll()) == 0 {
			desktop.OpenWelcomeWindow()
		}
	})
	desktop.OpenWelcomeWindow()

	if err := native.Run(); err != nil {
		log.Fatal(err)
	}
}

func (d *Desktop) OpenWelcomeWindow() {
	d.windowMu.Lock()
	defer d.windowMu.Unlock()

	if existing, ok := d.native.Window.GetByName(welcomeWindow); ok {
		existing.Show()
		existing.Restore()
		existing.Focus()
		return
	}

	window := d.native.Window.NewWithOptions(baseWindowOptions(application.WebviewWindowOptions{
		Name:          welcomeWindow,
		Title:         applicationName,
		Width:         900,
		Height:        640,
		MinWidth:      900,
		MinHeight:     640,
		DisableResize: true,
		URL:           "/",
	}))
	d.protectClose(window)
	window.Show()
	window.Focus()
}

func (d *Desktop) OpenSettingsWindow() string {
	d.windowMu.Lock()
	defer d.windowMu.Unlock()

	if existing, ok := d.native.Window.GetByName(settingsWindow); ok {
		existing.Show()
		existing.Restore()
		existing.Focus()
		return "focused"
	}

	window := d.native.Window.NewWithOptions(baseWindowOptions(application.WebviewWindowOptions{
		Name:          settingsWindow,
		Title:         "Settings — " + applicationName,
		Width:         720,
		Height:        760,
		MinWidth:      620,
		MinHeight:     640,
		DisableResize: false,
		URL:           "/?settings=1",
	}))
	d.protectClose(window)
	window.Show()
	window.Focus()
	return "opened"
}

func (d *Desktop) OpenDayWindow(date string) string {
	d.windowMu.Lock()
	defer d.windowMu.Unlock()

	name := dayWindowName(date)
	if existing, ok := d.native.Window.GetByName(name); ok {
		existing.Show()
		existing.Restore()
		existing.Focus()
		return "focused"
	}

	window := d.native.Window.NewWithOptions(baseWindowOptions(application.WebviewWindowOptions{
		Name:      name,
		Title:     fmt.Sprintf("%s — %s", date, applicationName),
		Width:     1480,
		Height:    900,
		MinWidth:  900,
		MinHeight: 640,
		URL:       "/?day=" + url.QueryEscape(date),
	}))
	d.protectClose(window)
	window.Show()
	window.Focus()
	return "opened"
}

func baseWindowOptions(options application.WebviewWindowOptions) application.WebviewWindowOptions {
	options.InitialPosition = application.WindowCentered
	options.BackgroundColour = application.NewRGB(244, 241, 235)
	options.UseApplicationMenu = true
	options.Mac.TitleBar = application.MacTitleBarHiddenInset
	options.Mac.CollectionBehavior = application.MacWindowCollectionBehaviorParticipatesInCycle |
		application.MacWindowCollectionBehaviorFullScreenPrimary
	return options
}

func dayWindowName(date string) string {
	return "day-" + date
}

func (d *Desktop) hasOpenDayWindow() bool {
	for _, window := range d.native.Window.GetAll() {
		if strings.HasPrefix(window.Name(), "day-") {
			return true
		}
	}
	return false
}

func (d *Desktop) broadcastSettings(settings Settings) {
	for _, window := range d.native.Window.GetAll() {
		dispatchToWindow(window, "settings:changed", settings)
	}
}

func (d *Desktop) protectClose(window *application.WebviewWindow) {
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if d.consumeApprovedClose(window.ID()) {
			return
		}
		event.Cancel()
		dispatchToWindow(window, "window:close-request")
	})
}

func (d *Desktop) ConfirmClose(window application.Window) {
	d.closeMu.Lock()
	d.approvedClose[window.ID()] = true
	d.closeMu.Unlock()
	window.Close()
}

func (d *Desktop) consumeApprovedClose(windowID uint) bool {
	d.closeMu.Lock()
	defer d.closeMu.Unlock()
	approved := d.approvedClose[windowID]
	delete(d.approvedClose, windowID)
	return approved
}

type paneMenuItem struct {
	label       string
	accelerator string
	position    int
}

func paneFocusMenuItems() []paneMenuItem {
	items := []paneMenuItem{{label: "Todo", accelerator: "CmdOrCtrl+B", position: 0}}
	for streamIndex := 1; streamIndex <= 9; streamIndex++ {
		items = append(items, paneMenuItem{
			label:       "Doing " + strconv.Itoa(streamIndex),
			accelerator: "CmdOrCtrl+" + strconv.Itoa(streamIndex),
			position:    streamIndex,
		})
	}
	return items
}

type menuShortcut struct {
	label       string
	accelerator string
}

// dayPickerMenuItems lists the File menu entries that open the day picker.
func dayPickerMenuItems() []menuShortcut {
	return []menuShortcut{
		{label: "Open Journal Day…", accelerator: "CmdOrCtrl+O"},
		{label: "New Journal Day…", accelerator: "CmdOrCtrl+N"},
	}
}

// addDayPickerItems is the only place the day-picker entries are added, so
// every shortcut in dayPickerMenuItems reaches the same handler.
func addDayPickerItems(menu *application.Menu, openDayPicker func(*application.Context)) {
	for _, item := range dayPickerMenuItems() {
		menu.Add(item.label).SetAccelerator(item.accelerator).OnClick(openDayPicker)
	}
}

func applicationMenu(native *application.App, service *App, desktop *Desktop) *application.Menu {
	result := native.NewMenu()
	if runtime.GOOS == "darwin" {
		result.AddRole(application.AppMenu)
	}

	fileMenu := result.AddSubmenu("File")
	addDayPickerItems(fileMenu, func(*application.Context) {
		if window := native.Window.Current(); window != nil {
			dispatchToWindow(window, "menu:open")
			return
		}
		desktop.OpenWelcomeWindow()
	})
	fileMenu.Add("New Doing Stream").SetAccelerator("CmdOrCtrl+T").OnClick(func(*application.Context) {
		emitToCurrent(native, "menu:new-doing")
	})
	fileMenu.AddSeparator()
	fileMenu.Add("Save All").SetAccelerator("CmdOrCtrl+S").OnClick(func(*application.Context) {
		emitToCurrent(native, "menu:save")
	})
	fileMenu.AddRole(application.CloseWindow)
	fileMenu.AddSeparator()
	fileMenu.Add("Settings…").SetAccelerator("CmdOrCtrl+,").OnClick(func(*application.Context) {
		desktop.OpenSettingsWindow()
	})

	result.AddRole(application.EditMenu)
	viewMenu := result.AddSubmenu("View")
	viewMenu.Add("Toggle Focused Pane Zoom").SetAccelerator("CmdOrCtrl+Shift+Z").OnClick(func(*application.Context) {
		emitToCurrent(native, "menu:toggle-pane-zoom")
	})
	viewMenu.Add("Toggle All Doing History").SetAccelerator("CmdOrCtrl+Shift+H").OnClick(func(*application.Context) {
		emitToCurrent(native, "menu:toggle-all-doing-history")
	})
	viewMenu.Add("Toggle Focused Doing History").SetAccelerator("CmdOrCtrl+Option+H").OnClick(func(*application.Context) {
		emitToCurrent(native, "menu:toggle-focused-doing-history")
	})
	viewMenu.AddSeparator()
	viewMenu.Add("Focus Pane Left").SetAccelerator("CmdOrCtrl+Option+Left").OnClick(func(*application.Context) {
		emitToCurrent(native, "menu:move-focus", -1)
	})
	viewMenu.Add("Focus Pane Right").SetAccelerator("CmdOrCtrl+Option+Right").OnClick(func(*application.Context) {
		emitToCurrent(native, "menu:move-focus", 1)
	})
	focusMenu := viewMenu.AddSubmenu("Focus Pane")
	for _, spec := range paneFocusMenuItems() {
		item := spec
		focusMenu.Add(item.label).SetAccelerator(item.accelerator).OnClick(func(*application.Context) {
			emitToCurrent(native, "menu:focus-pane", item.position)
		})
	}

	viewMenu.AddSeparator()
	fontMenu := viewMenu.AddSubmenu("Editor Font")
	selectedFont := defaultEditorFont
	if settings, settingsErr := service.GetSettings(); settingsErr == nil {
		selectedFont = settings.EditorFont
	}
	fontOptions := []struct{ id, label string }{
		{id: "avenir-next-condensed", label: "Avenir Next Condensed"},
		{id: "din-condensed", label: "DIN Condensed"},
		{id: "pt-sans-narrow", label: "PT Sans Narrow"},
		{id: "system", label: "System Sans"},
	}
	fontItems := make([]*application.MenuItem, len(fontOptions))
	for index, option := range fontOptions {
		itemIndex := index
		font := option
		fontItems[index] = fontMenu.AddRadio(font.label, font.id == selectedFont).OnClick(func(*application.Context) {
			settings, settingsErr := service.SetEditorFont(font.id)
			if settingsErr != nil {
				emitToCurrent(native, "menu:error", settingsErr.Error())
				return
			}
			for current, menuItem := range fontItems {
				menuItem.SetChecked(current == itemIndex)
			}
			for _, window := range native.Window.GetAll() {
				dispatchToWindow(window, "menu:font", settings.EditorFont)
			}
		})
	}

	result.AddRole(application.WindowMenu)
	return result
}

func emitToCurrent(native *application.App, name string, data ...any) {
	if window := native.Window.Current(); window != nil {
		dispatchToWindow(window, name, data...)
	}
}

func dispatchToWindow(window application.Window, name string, data ...any) {
	event := &application.CustomEvent{Name: name, Sender: window.Name()}
	if len(data) == 1 {
		event.Data = data[0]
	} else if len(data) > 1 {
		event.Data = data
	}
	window.DispatchWailsEvent(event)
}
