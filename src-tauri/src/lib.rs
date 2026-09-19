mod reader;

use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

// A single pending path, not an unbounded queue. Managed before setup for macOS Opened.
struct PendingOpen(Mutex<Option<String>>);

fn from_args(args: &[String]) -> Option<String> {
    args.iter().skip(1).find_map(|arg| {
        let path = std::path::Path::new(arg);
        if arg.starts_with("--") || !reader::is_markdown(path) || !path.is_file() {
            return None;
        }
        Some(
            path.canonicalize()
                .map(|p| reader::display_path(&p))
                .unwrap_or_else(|_| arg.clone()),
        )
    })
}

fn deliver_file(app: &tauri::AppHandle, path: String) {
    if let Ok(mut pending) = app.state::<PendingOpen>().0.lock() {
        *pending = Some(path.clone());
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("md-reader://open-file", path);
}

#[tauri::command]
fn take_pending_open_file(state: State<'_, PendingOpen>) -> Option<String> {
    state.0.lock().ok()?.take()
}

#[tauri::command]
async fn read_document(path: String) -> Result<reader::Document, String> {
    tauri::async_runtime::spawn_blocking(move || reader::read_document(&path))
        .await
        .map_err(|e| format!("读取任务失败：{e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial = from_args(&std::env::args().collect::<Vec<_>>());
    let app = tauri::Builder::default()
        .manage(PendingOpen(Mutex::new(initial)))
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path) = from_args(&args) {
                deliver_file(app, path);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            read_document,
            take_pending_open_file
        ])
        .build(tauri::generate_context!())
        .expect("无法启动 MD Reader");
    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            if let Some(path) = urls
                .iter()
                .rev()
                .filter_map(|url| url.to_file_path().ok())
                .find(|p| reader::is_markdown(p))
            {
                deliver_file(_app, reader::display_path(&path));
            }
        }
    });
}
