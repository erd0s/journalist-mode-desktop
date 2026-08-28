package main

import (
	"embed"
	"os"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp(launchDateFromArgs(os.Args[1:]))

	// Create application with options
	err := wails.Run(&options.App{
		Title:     "Journalist Mode",
		Width:     1480,
		Height:    900,
		MinWidth:  900,
		MinHeight: 640,
		Menu:      applicationMenu(app),
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 244, G: 241, B: 235, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
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
	fileMenu.AddText("New Window", keys.CmdOrCtrl("n"), func(_ *menu.CallbackData) {
		if err := app.OpenNewWindow(); err != nil && app.ctx != nil {
			runtime.EventsEmit(app.ctx, "menu:error", err.Error())
		}
	})
	fileMenu.AddText("Open Journal Day…", keys.CmdOrCtrl("o"), func(_ *menu.CallbackData) {
		if err := app.OpenDayPicker(); err != nil && app.ctx != nil {
			runtime.EventsEmit(app.ctx, "menu:error", err.Error())
		}
	})
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
	viewMenu.AddText("Toggle Completed Work", keys.Combo("h", keys.CmdOrCtrlKey, keys.ShiftKey), func(_ *menu.CallbackData) {
		if app.ctx != nil {
			runtime.EventsEmit(app.ctx, "menu:toggle-completed")
		}
	})
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
