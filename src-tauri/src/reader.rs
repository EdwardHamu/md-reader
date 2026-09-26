//! Read-only, bounded file loading. No directory scanning, watching or document cache.
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Serialize)]
pub struct Document {
    pub path: String,
    pub source: String,
}

pub fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("md" | "markdown" | "mdx" | "txt")
    )
}

pub fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
    }
}

fn bounded_text(reader: impl Read) -> Result<String, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取文件失败：{e}"))?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("文件超过 8 MiB，请拆分后阅读。".into());
    }
    String::from_utf8(bytes).map_err(|_| "文件不是有效的 UTF-8 文本，请先转换编码。".into())
}

pub fn read_document(path: &str) -> Result<Document, String> {
    let input = Path::new(path);
    if !is_markdown(input) {
        return Err("只支持 .md / .markdown / .mdx / .txt 文件。".into());
    }
    let path = input
        .canonicalize()
        .map_err(|e| format!("无法打开文件：{e}"))?;
    let metadata = path.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("请选择文件，而不是文件夹。".into());
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err("文件超过 8 MiB，请拆分后阅读。".into());
    }
    let file = File::open(&path).map_err(|e| format!("无法读取文件：{e}"))?;
    // take(MAX+1) also bounds files that grow after the metadata check.
    let source = bounded_text(file)?;
    Ok(Document {
        path: display_path(&path),
        source,
    })
}


// Require the exact source originally opened in the editor to prevent silent overwrites.
pub fn save_document(path: &str, source: &str, expected: &str) -> Result<(), String> {
    let input = Path::new(path);
    if !is_markdown(input) { return Err("只支持 Markdown / 文本文件。".into()); }
    if source.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("内容超过 8 MiB，无法保存。".into());
    }
    let canonical = input.canonicalize().map_err(|e| format!("无法打开文件：{e}"))?;
    if !canonical.is_file() { return Err("请选择文件，而不是文件夹。".into()); }
    if read_document(path)?.source != expected {
        return Err("文件已在外部更改，请复制当前编辑内容后重新打开，避免覆盖。".into());
    }
    // `canonical` has symlinks resolved: the link survives and its target is replaced.
    atomic_write(&canonical, source.as_bytes())
}

/// Deletes the temporary file on every early return / error unless it was renamed into place.
struct TempFileGuard(Option<PathBuf>);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

/// Create a new, uniquely named sibling of `target` (same directory ⇒ same filesystem,
/// so the final rename is atomic). `create_new` never clobbers an existing file.
fn create_temp_sibling(target: &Path) -> Result<(File, PathBuf), String> {
    let dir = target.parent().ok_or("无法确定文件所在目录。")?;
    let name = target.file_name().ok_or("无效的文件名。")?.to_string_lossy();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let mut last_error = None;
    for attempt in 0..16u32 {
        let temp = dir.join(format!(
            ".{name}.{}-{nanos:x}-{attempt}.mdreader-tmp",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => return Ok((file, temp)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last_error = Some(e),
            Err(e) => return Err(format!("无法在文件所在目录创建临时文件：{e}")),
        }
    }
    Err(format!("无法创建临时文件：{}", last_error.map(|e| e.to_string()).unwrap_or_default()))
}

/// Replace `target` via rename. On Windows, antivirus/indexers can hold the file for a
/// moment (ERROR_ACCESS_DENIED / sharing violation), so retry briefly there.
fn replace_file(temp: &Path, target: &Path) -> std::io::Result<()> {
    let attempts = if cfg!(windows) { 5 } else { 1 };
    let mut result = fs::rename(temp, target);
    for _ in 1..attempts {
        match &result {
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(32) => {
                std::thread::sleep(std::time::Duration::from_millis(40));
                result = fs::rename(temp, target);
            }
            _ => break,
        }
    }
    result
}

/// Crash-safe save: write a temporary sibling, fsync it, then atomically rename it over the
/// target. At any instant the target holds either the complete old or the complete new content;
/// a crash or power loss can at worst leave a stray `*.mdreader-tmp` file, never a truncated document.
pub(crate) fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let permissions = fs::metadata(target)
        .map_err(|e| format!("无法读取文件属性：{e}"))?
        .permissions();
    // rename() ignores the target's own permission bits on Unix: keep "read-only means read-only".
    if permissions.readonly() {
        return Err("文件为只读，无法保存。".into());
    }
    let (mut file, temp) = create_temp_sibling(target)?;
    let mut guard = TempFileGuard(Some(temp.clone()));
    file.write_all(bytes).map_err(|e| format!("保存失败：{e}"))?;
    file.sync_all().map_err(|e| format!("同步文件失败：{e}"))?;
    drop(file); // Windows cannot rename a file that still has an open handle.
    // Keep the original mode bits (e.g. 0600 stays private) instead of the umask default.
    fs::set_permissions(&temp, permissions).map_err(|e| format!("无法设置文件权限：{e}"))?;
    replace_file(&temp, target).map_err(|e| format!("无法替换原文件（原文件未被修改）：{e}"))?;
    guard.0 = None; // Renamed into place: nothing to clean up.
    // Persist the directory entry too (Unix); best effort, the data itself is already synced.
    #[cfg(unix)]
    if let Some(dir) = target.parent() {
        let _ = File::open(dir).and_then(|d| d.sync_all());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn whitelist_and_paths() {
        assert!(is_markdown(Path::new("HELLO.MDX")));
        assert!(is_markdown(Path::new("notes.txt")));
        assert!(!is_markdown(Path::new("payload.exe")));
        assert_eq!(display_path(Path::new(r"\\?\C:\x.md")), r"C:\x.md");
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\x.md")),
            r"\\server\share\x.md"
        );
    }
    #[test]
    fn bounded_utf8() {
        assert_eq!(bounded_text("你好\n".as_bytes()).unwrap(), "你好\n");
        assert!(bounded_text(&[0xff][..]).is_err());
        let exact = std::io::repeat(b'a').take(MAX_DOCUMENT_BYTES);
        assert_eq!(
            bounded_text(exact).unwrap().len() as u64,
            MAX_DOCUMENT_BYTES
        );
        assert!(bounded_text(std::io::repeat(b'a'))
            .unwrap_err()
            .contains("8 MiB"));
    }
    #[test]
    fn rejects_missing_and_non_markdown() {
        assert!(read_document("missing-md-reader-test.md").is_err());
        assert!(read_document("package.json").is_err());
    }

    /// A unique scratch directory, removed on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir()
                .join(format!("md-reader-{tag}-{}-{nanos}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn file(&self, name: &str, content: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, content).unwrap();
            path
        }
        fn entries(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.0).unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            names
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn save_replaces_content_and_leaves_no_temp_file() {
        let dir = Scratch::new("save");
        let path = dir.file("note.md", "old\n");
        save_document(path.to_str().unwrap(), "新内容\n", "old\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "新内容\n");
        assert_eq!(dir.entries(), vec!["note.md".to_string()]);
    }

    #[test]
    fn save_rejects_external_change_without_touching_the_file() {
        let dir = Scratch::new("conflict");
        let path = dir.file("note.md", "changed elsewhere");
        assert!(save_document(path.to_str().unwrap(), "mine", "original").unwrap_err().contains("外部更改"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "changed elsewhere");
        assert_eq!(dir.entries(), vec!["note.md".to_string()]);
    }

    #[test]
    fn save_refuses_read_only_files() {
        let dir = Scratch::new("readonly");
        let path = dir.file("note.md", "keep");
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&path, perms.clone()).unwrap();
        assert!(save_document(path.to_str().unwrap(), "new", "keep").unwrap_err().contains("只读"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep");
        assert_eq!(dir.entries(), vec!["note.md".to_string()]);
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&path, perms).unwrap(); // Let Scratch clean up on Windows.
    }

    #[test]
    fn failed_replace_keeps_target_and_removes_temp_file() {
        let dir = Scratch::new("fail");
        // A directory cannot be replaced by a file: rename fails after the temp file was written.
        let target = dir.0.join("occupied.md");
        fs::create_dir(&target).unwrap();
        assert!(atomic_write(&target, b"data").unwrap_err().contains("原文件未被修改"));
        assert!(target.is_dir());
        assert_eq!(dir.entries(), vec!["occupied.md".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn save_preserves_unix_mode_bits() {
        use std::os::unix::fs::PermissionsExt;
        let dir = Scratch::new("mode");
        let path = dir.file("private.md", "secret");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        save_document(path.to_str().unwrap(), "still secret", "secret").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn save_through_symlink_replaces_target_and_keeps_link() {
        let dir = Scratch::new("link");
        let real = dir.file("real.md", "old");
        let link = dir.0.join("link.md");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        save_document(link.to_str().unwrap(), "new", "old").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
    }
}
