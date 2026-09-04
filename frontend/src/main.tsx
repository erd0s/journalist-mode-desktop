import React from 'react'
import {createRoot} from 'react-dom/client'
import './style.css'
// Must stay ahead of App: it registers a window listener that has to run
// before the Wails runtime's, and App imports the runtime.
import './lib/welcomeTitleBand'
import App from './App'

const container = document.getElementById('root')

const root = createRoot(container!)

root.render(
    <React.StrictMode>
        <App/>
    </React.StrictMode>
)
