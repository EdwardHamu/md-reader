use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::{StateFlags, WindowExt};

#[derive(Default)]
pub struct StartupGate(AtomicBool);

impl StartupGate {
    pub fn is_revealed(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    fn reveal<E>(&self, show: impl FnOnce() -> Result<(), E>) -> Result<bool, E> {
        if self
            .0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(false);
        }
        if let Err(error) = show() {
            self.0.store(false, Ordering::Release);
            return Err(error);
        }
        Ok(true)
    }
}

// Restoring maximized state can show a native window: do it only inside the gate.
fn show_main(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let _ = window.restore_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED);
    window.show()
}

#[tauri::command]
pub fn reveal_main_window(window: tauri::WebviewWindow, dark: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主窗口可发出启动就绪通知".into());
    }
    let shown = window
        .state::<StartupGate>()
        .reveal(|| {
            let color = if dark {
                tauri::window::Color(20, 18, 24, 255)
            } else {
                tauri::window::Color(244, 242, 247, 255)
            };
            // Setting background may be unsupported on some platforms; showing is still mandatory.
            let _ = window.set_background_color(Some(color));
            show_main(&window)
        })
        .map_err(|error| error.to_string())?;
    if shown {
        let _ = window.set_focus();
    }
    Ok(())
}

pub fn focus_existing(app: &tauri::AppHandle) {
    // A second instance must not expose an uninitialized first instance.
    if !app.state::<StartupGate>().is_revealed() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn arm_watchdog(app: tauri::AppHandle) {
    // Independent of JS, rAF, IPC and WebView timers. Not a permanent background service.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(6));
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let result = app.state::<StartupGate>().reveal(|| show_main(&window));
        let message = match result {
            Ok(false) => return,
            Ok(true) => {
                let _ = window.set_focus();
                "界面未能及时就绪，窗口已恢复显示。若仍无响应，请关闭应用后重试；若页面提供“重新加载”，也可点击重试。"
            }
            Err(_) => "系统未能显示 MD Reader 主窗口，请关闭应用后重试。",
        };
        app.dialog()
            .message(message)
            .title("MD Reader · 启动恢复")
            .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
            .show(|_| {});
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_first_signal_shows() {
        let gate = StartupGate::default();
        assert!(!gate.is_revealed());
        assert_eq!(gate.reveal(|| Ok::<(), ()>(())), Ok(true));
        assert_eq!(
            gate.reveal(|| panic!("must not show twice")),
            Ok::<bool, ()>(false)
        );
        assert!(gate.is_revealed());
    }
    #[test]
    fn failed_show_can_be_retried_by_watchdog() {
        let gate = StartupGate::default();
        assert_eq!(gate.reveal(|| Err("show failed")), Err("show failed"));
        assert!(!gate.is_revealed());
        assert_eq!(gate.reveal(|| Ok::<(), &str>(())), Ok(true));
    }
}
