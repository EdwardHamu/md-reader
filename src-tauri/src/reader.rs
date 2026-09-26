//! Read-only, bounded file loading. No directory scanning, watching or document cache.
use serde::Serialize;
use std::{fs::{File, OpenOptions}, io::{Read, Write}, path::Path};

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
    let mut file = OpenOptions::new().write(true).truncate(true).open(&canonical)
        .map_err(|e| format!("无法写入文件：{e}"))?;
    file.write_all(source.as_bytes()).map_err(|e| format!("保存失败：{e}"))?;
    file.sync_all().map_err(|e| format!("同步文件失败：{e}"))?;
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
}
