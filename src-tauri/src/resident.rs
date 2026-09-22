use crate::{startup, PendingOpen};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

/// Event-loop thread only: serializes native window creation.
pub fn ensure_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() {
        startup::focus_existing(app);
        return Ok(());
    }
    app.state::<startup::StartupGate>().reset();
    if let Ok(mut state) = app.state::<PendingOpen>().0.lock() { state.ready = false; }
    let config = app.config().app.windows.iter().find(|config| config.label == "main")
        .ok_or_else(|| std::io::Error::other("Missing main window configuration"))?;
    let window = tauri::WebviewWindowBuilder::from_config(app, config)?.build()?;
    let color = if matches!(window.theme(), Ok(tauri::Theme::Dark)) {
        tauri::window::Color(20, 18, 24, 255)
    } else { tauri::window::Color(244, 242, 247, 255) };
    let _ = window.set_background_color(Some(color));
    startup::arm_watchdog(app.clone());
    Ok(())
}

pub fn request_window(app: &tauri::AppHandle, path: Option<String>) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Some(path) = path {
            if let Ok(mut state) = handle.state::<PendingOpen>().0.lock() { state.path = Some(path); }
        }
        if let Err(error) = ensure_window(&handle) {
            handle.dialog().message(format!("无法创建阅读窗口：{error}"))
                .title("MD Reader").show(|_| {});
            return;
        }
        if let Ok(mut state) = handle.state::<PendingOpen>().0.lock() {
            if state.ready {
                if let Some(path) = state.path.take() {
                    if handle.emit_to("main", "md-reader://open-file", &path).is_err() {
                        state.path = Some(path);
                    }
                }
            }
        };
    }) { eprintln!("Unable to schedule reader window: {error}"); }
}

pub fn install_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open-file", "打开文件…", true, None::<&str>)?;
    let reader = MenuItem::with_id(app, "show-reader", "打开阅读窗口", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "退出 MD Reader", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &reader, &exit])?;
    let mut tray = TrayIconBuilder::with_id("resident").tooltip("MD Reader · 后台驻留")
        .menu(&menu).show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open-file" => {
                let handle = app.clone();
                app.dialog().file().add_filter("Markdown / 文本", &["md", "markdown", "mdx", "txt"])
                    .pick_file(move |file| {
                        if let Some(file) = file {
                            if let Ok(path) = file.into_path() {
                                request_window(&handle, Some(crate::reader::display_path(&path)));
                            }
                        }
                    });
            }
            "show-reader" => request_window(app, None),
            "exit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
                request_window(tray.app_handle(), None);
            }
        });
    if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
    tray.build(app)?;
    Ok(())
}
