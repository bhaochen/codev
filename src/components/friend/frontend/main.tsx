import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { listen } from '@tauri-apps/api/event'

// Ensure correct URL when loaded via Tauri (WebGL requires HTTP server)
if (typeof window !== 'undefined' && !window.location.href.includes('/friend/')) {
  window.location.replace('http://127.0.0.1:3456/friend/')
}

// Listen for Tauri close event and notify backend
listen('friend-window-close', () => {
  fetch('http://127.0.0.1:3456/friend/api/window-close', { method: 'POST' }).catch(() => {})
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)