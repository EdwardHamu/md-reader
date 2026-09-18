//! PDF 导出的辅助工具：Edge/Chrome 可执行文件探测、Windows 扩展路径前缀
//! 处理、本地路径转 file:// URL。均为无状态纯函数，含单元测试。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 当前 Unix 时间戳（毫秒），用作临时文件名的唯一后缀。
pub fn current_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 剥离 Windows API 返回的扩展长度路径前缀（`\\?\` / `\\?\UNC\`）。
///
/// `canonicalize()` 在 Windows 上会返回 `\\?\D:\...` 形式，直接交给 Edge
/// 或前端显示都会出问题，必须先归一化回普通路径。
pub fn strip_windows_extended_prefix(s: String) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        // UNC 形式：`\\?\UNC\server\share` → `\\server\share`
        format!(r"\\{}", rest)
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s
    }
}

/// 本地路径转 file:// URL，兼容 UNC / POSIX / Windows 盘符三种形态：
/// - `\\server\share\...` → `file://server/share/...`（双斜杠宿主）
/// - `/usr/...` → `file:///usr/...`（POSIX 绝对路径）
/// - `C:/...` → `file:///C:/...`（盘符路径，file:// 后要有三根斜杠）
pub fn path_to_file_url(path: &Path) -> String {
    let canon = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let s = strip_windows_extended_prefix(canon.to_string_lossy().to_string());
    let normalized = s.replace('\\', "/");
    if normalized.starts_with("//") {
        format!("file:{}", normalized)
    } else if normalized.starts_with('/') {
        format!("file://{}", normalized)
    } else {
        format!("file:///{}", normalized)
    }
}

/// 探测可用的 PDF 引擎（Edge 优先，Chrome 兜底）。
///
/// 探测顺序：
/// 1. `custom`：前端持久化的用户手动选择（localStorage["md-reader-edge-path"]
///    传下来的），最高优先级——自动探测失败时用户的选择必须被尊重；
/// 2. Windows：`where msedge` 查 PATH；
/// 3. 各平台硬编码的常见安装路径，其中 Windows / macOS 的最后两个候选是
///    Chrome——Edge 缺失时 Chrome 完全兼容相同的 headless 参数。
pub fn find_edge_executable(custom: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = custom {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：避免 where.exe 闪 cmd 黑窗。
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("where");
        c.arg("msedge");
        c.creation_flags(0x08000000);
        if let Ok(output) = c.output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(line) = stdout.lines().next() {
                    let p = PathBuf::from(line.trim());
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        candidates.push(PathBuf::from(
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ));
        candidates.push(PathBuf::from(
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ));
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(local).join("Microsoft\\Edge\\Application\\msedge.exe"),
            );
        }
        candidates.push(PathBuf::from(
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        ));
        candidates.push(PathBuf::from(
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ));
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from(
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ));
        candidates.push(PathBuf::from(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ));
    }
    #[cfg(target_os = "linux")]
    {
        for p in &[
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
        ] {
            candidates.push(PathBuf::from(p));
        }
    }

    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }
    None
}

/// 前端在设置页调用：返回探测到的引擎路径（存在性检查），用于展示
/// 「已找到 / 未找到 PDF 引擎」状态。参数 camelCase 对应前端的 customEdge。
#[tauri::command]
pub fn check_pdf_engine(custom_edge: Option<String>) -> Option<String> {
    find_edge_executable(custom_edge.as_deref())
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 覆盖 strip_windows_extended_prefix 的全部四种输入形态
    #[test]
    fn strips_extended_drive_prefix() {
        assert_eq!(
            strip_windows_extended_prefix(r"\\?\D:\work\a.md".to_string()),
            r"D:\work\a.md"
        );
    }

    #[test]
    fn strips_extended_unc_prefix() {
        assert_eq!(
            strip_windows_extended_prefix(
                r"\\?\UNC\192.168.1.224\工作共享\a.md".to_string(),
            ),
            r"\\192.168.1.224\工作共享\a.md"
        );
    }

    #[test]
    fn keeps_normal_drive_path() {
        assert_eq!(
            strip_windows_extended_prefix(r"D:\work\a.md".to_string()),
            r"D:\work\a.md"
        );
    }

    #[test]
    fn keeps_normal_unc_path() {
        assert_eq!(
            strip_windows_extended_prefix(r"\\server\share\a.md".to_string()),
            r"\\server\share\a.md"
        );
    }
}
