package main

import (
	"embed"
	"os"
	"strconv"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	launchDate := launchDateFromArgs(os.Args[1:])
	app := NewApp(launchDate)
	width, height := 1480, 900
	minWidth, minHeight := 900, 640
	disableResize := false
	if launchDate == "" {
		width, height = 900, 640
		minWidth, minHeight = width, height
		disableResize = true
	}

	// Create application with options
	err := wails.Run(&options.App{
		Title:         "Journalist Mode",
		Width:         width,
		Height:        height,
		MinWidth:      minWidth,
		MinHeight:     minHeight,
		DisableResize: disableResize,
		Menu:          applicationMenu(app),
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 244, G: 241, B: 235, A: 1},
		Mac: &mac.Options{
			TitleBar: mac.TitleBarHiddenInset(),
		},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}

func applicationMenu(app *App) *menu.Menu {
	application := menu.NewMenu()
	application.Append(menu.AppMenu())
	fileMenu := application.AddSubmenu("File")
	fileMenu.AddText("Open Journal Day…", keys.CmdOrCtrl("o"), func(_ *menu.CallbackData) {
		if app.ctx != nil {
			runtime.EventsEmit(app.ctx, "menu:open")
		}
	})
	if app.GetLaunchDate() != "" {
		fileMenu.AddText("New Doing Stream", keys.CmdOrCtrl("t"), func(_ *menu.CallbackData) {
			if app.ctx != nil {
				runtime.EventsEmit(app.ctx, "menu:new-doing")
			}
		})
	}
	fileMenu.AddSeparator()
	fileMenu.AddText("Save All", keys.CmdOrCtrl("s"), func(_ *menu.CallbackData) {
		if app.ctx != nil {
			runtime.EventsEmit(app.ctx, "menu:save")
		}
	})
	fileMenu.AddSeparator()
	fileMenu.AddText("Settings…", keys.CmdOrCtrl(","), func(_ *menu.CallbackData) {
		if app.ctx != nil {
			runtime.EventsEmit(app.ctx, "menu:settings")
		}
	})
	application.Append(menu.EditMenu())

	selectedFont := defaultEditorFont
	if settings, err := app.GetSettings(); err == nil {
		selectedFont = settings.EditorFont
	}
	fontOptions := []struct {
		id    string
		label string
	}{
		{id: "avenir-next-condensed", label: "Avenir Next Condensed"},
		{id: "din-condensed", label: "DIN Condensed"},
		{id: "pt-sans-narrow", label: "PT Sans Narrow"},
		{id: "system", label: "System Sans"},
	}
	viewMenu := application.AddSubmenu("View")
	if launchDate := app.GetLaunchDate(); launchDate != "" {
		viewMenu.AddText("Toggle Todo Pane", keys.CmdOrCtrl("b"), func(_ *menu.CallbackData) {
			if app.ctx != nil {
				runtime.EventsEmit(app.ctx, "menu:toggle-todo")
			}
		})
		viewMenu.AddText("Toggle Focused Pane Zoom", keys.Combo("z", keys.CmdOrCtrlKey, keys.ShiftKey), func(_ *menu.CallbackData) {
			if app.ctx != nil {
				runtime.EventsEmit(app.ctx, "menu:toggle-pane-zoom")
			}
		})
		viewMenu.AddText("Toggle All Doing History", keys.Combo("h", keys.CmdOrCtrlKey, keys.ShiftKey), func(_ *menu.CallbackData) {
			if app.ctx != nil {
				runtime.EventsEmit(app.ctx, "menu:toggle-all-doing-history")
			}
		})
		viewMenu.AddText("Toggle Focused Doing History", keys.Combo("h", keys.CmdOrCtrlKey, keys.OptionOrAltKey), func(_ *menu.CallbackData) {
			if app.ctx != nil {
				runtime.EventsEmit(app.ctx, "menu:toggle-focused-doing-history")
			}
		})
		viewMenu.AddSeparator()
		viewMenu.AddText("Focus Pane Left", keys.Combo("left", keys.CmdOrCtrlKey, keys.OptionOrAltKey), func(_ *menu.CallbackData) {
			if app.ctx != nil {
				runtime.EventsEmit(app.ctx, "menu:move-focus", -1)
			}
		})
		viewMenu.AddText("Focus Pane Right", keys.Combo("right", keys.CmdOrCtrlKey, keys.OptionOrAltKey), func(_ *menu.CallbackData) {
			if app.ctx != nil {
				runtime.EventsEmit(app.ctx, "menu:move-focus", 1)
			}
		})
		day, err := app.OpenDay(launchDate)
		if err == nil {
			focusMenu := viewMenu.AddSubmenu("Focus Pane")
			paneLabels := []string{"Todo"}
			for _, file := range day.Doing {
				paneLabels = append(paneLabels, "Doing "+strconv.Itoa(file.StreamIndex))
			}
			for index, label := range paneLabels {
				position := index + 1
				var accelerator *keys.Accelerator
				if position <= 9 {
					accelerator = keys.CmdOrCtrl(strconv.Itoa(position))
				}
				focusMenu.AddText(label, accelerator, func(_ *menu.CallbackData) {
					if app.ctx != nil {
						runtime.EventsEmit(app.ctx, "menu:focus-pane", position)
					}
				})
			}
		}
	}
	viewMenu.AddSeparator()
	fontMenu := viewMenu.AddSubmenu("Editor Font")
	fontItems := make([]*menu.MenuItem, len(fontOptions))
	for index, option := range fontOptions {
		itemIndex := index
		font := option
		fontItems[index] = fontMenu.AddRadio(font.label, font.id == selectedFont, nil, func(_ *menu.CallbackData) {
			settings, err := app.SetEditorFont(font.id)
			if err != nil {
				if app.ctx != nil {
					runtime.EventsEmit(app.ctx, "menu:error", err.Error())
				}
				return
			}
			for current, item := range fontItems {
				item.SetChecked(current == itemIndex)
			}
			if app.ctx != nil {
				runtime.MenuUpdateApplicationMenu(app.ctx)
				runtime.EventsEmit(app.ctx, "menu:font", settings.EditorFont)
			}
		})
	}

	application.Append(menu.WindowMenu())
	return application
}

func launchDateFromArgs(args []string) string {
	for index, argument := range args {
		if argument == "--day" && index+1 < len(args) && validDate(args[index+1]) {
			return args[index+1]
		}
		if strings.HasPrefix(argument, "--day=") {
			date := strings.TrimPrefix(argument, "--day=")
			if validDate(date) {
				return date
			}
		}
	}
	return ""
}
