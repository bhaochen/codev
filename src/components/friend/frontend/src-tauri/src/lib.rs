use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            // Force load from HTTP server so WebGL works properly in webkit2gtk
            window.eval("window.location.replace('http://127.0.0.1:3456/friend/')")
                .map_err(|e| eprintln!("Failed to set URL: {e}")).ok();
            Ok(())
        });

    builder.run(tauri::generate_context!())
        .expect("error while running tauri application");
}