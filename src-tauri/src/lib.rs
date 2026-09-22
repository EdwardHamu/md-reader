mod reader;
mod startup;
mod resident;

use std::sync::Mutex;
use tauri::{Manager, State};

// A single pending path, not an unbounded queue. Managed before setup for macOS Opened.
#[derive(Default)]
struct OpenState {
    path: Option<String>,
    ready: bool,
}
struct PendingOpen(Mutex<OpenState>);

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
    resident::request_window(app, Some(path));
}

#[tauri::command]
fn take_pending_open_file(state: State<'_, PendingOpen>) -> Option<String> {
    let mut state = state.0.lock().ok()?;
    state.ready = true;
    state.path.take()
}

#[tauri::command]
async fn read_document(path: String) -> Result<reader::Document, String> {
    tauri::async_runtime::spawn_blocking(move || reader::read_document(&path))
        .await
        .map_err(|e| format!("读取任务失败：{e}"))?
}

// Enumerate installed system font family names, deduplicated and sorted.
// Runs on a blocking thread: fontdb scans platform font directories on load.
#[tauri::command]
async fn list_system_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut families: Vec<String> = db
            .faces()
            .flat_map(|face| face.families.iter())
            .map(|(name, _)| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect();
        families.sort();
        families.dedup();
        families
    })
    .await
    .map_err(|e| format!("字体枚举任务失败：{e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial = from_args(&std::env::args().collect::<Vec<_>>());
    let app = tauri::Builder::default()
        .manage(PendingOpen(Mutex::new(OpenState { path: initial, ready: false })))
        .manage(startup::StartupGate::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path) = from_args(&args) {
                deliver_file(app, path);
            } else {
                resident::request_window(app, None);
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
                .skip_initial_state("main")
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .setup(|app| {
            resident::install_tray(app.handle())?;
            let has_file = app.state::<PendingOpen>().0.lock()
                .map(|state| state.path.is_some()).unwrap_or(false);
            if has_file { resident::ensure_window(app.handle())?; }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_document,
            take_pending_open_file,
            list_system_fonts,
            startup::reveal_main_window
        ])
        .build(tauri::generate_context!())
        .expect("无法启动 MD Reader");
    app.run(|_app, _event| {
        match &_event {
            tauri::RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. }
                if label == "main" => {
                _app.state::<startup::StartupGate>().reset();
                if let Ok(mut state) = _app.state::<PendingOpen>().0.lock() {
                    *state = OpenState::default();
                }
            }
            _ => {}
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = &_event {
            resident::request_window(_app, None);
        }
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
