use tauri::{Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let url = url::Url::parse("http://127.0.0.1:3456/friend/").unwrap();
                let _ = window.navigate(url);
                let _ = window.set_focus();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                window.emit("friend-window-close", ()).ok();
            }
        });

    builder.run(tauri::generate_context!())
        .expect("error while running tauri application");
}