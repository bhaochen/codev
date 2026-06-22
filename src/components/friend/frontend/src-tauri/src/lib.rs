use tauri::{Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // Allow microphone/camera access for browser VAD (getUserMedia)
            #[cfg(target_os = "linux")]
            {
                use webkit2gtk::{PermissionRequestExt, WebViewExt};
                let _ = window.with_webview(|webview| {
                    let platform = webview.inner();
                    platform.connect_permission_request(|_webview, request| {
                        // Allow all permission requests (media, etc.)
                        request.allow();
                        true
                    });
                });
            }

            let _ = window.set_focus();
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
