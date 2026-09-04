// The Wails runtime listens for dblclick in the capture phase on window and
// treats a double-click on any --wails-draggable element as a title-bar
// double-click, which asks the window to zoom. The welcome window is fixed
// size, and AppKit reports a fixed-size window as already zoomed, so that
// request nudges the window instead of doing nothing. Stop the event before
// the runtime sees it.
//
// Capture listeners on the same target run in registration order, so this
// module must be imported before anything that imports @wailsio/runtime.
const WELCOME_TITLE_BAND = '.welcome-shell > .window-drag-region';

window.addEventListener('dblclick', event => {
    if (event.target instanceof Element && event.target.closest(WELCOME_TITLE_BAND)) {
        event.stopImmediatePropagation();
    }
}, true);

export {};
