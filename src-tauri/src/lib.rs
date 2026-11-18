use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex};
use tauri::Manager;
mod cloud_auth;

const MAX_EXPORT: usize = 64_000_000;
#[derive(Default)]
struct BackupFolder(Mutex<Option<PathBuf>>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EncryptedBackup {
    format: String, version: u8, revision: String, salt: String, iv: String, ciphertext: String,
}

fn validate_backup(text: &str) -> Result<String, String> {
    if text.len() > 42_000_000 { return Err("The encrypted backup exceeds 42 MB.".into()); }
    let value: EncryptedBackup = serde_json::from_str(text).map_err(|_| "Only encrypted Finance Atlas snapshots can be written automatically.")?;
    if value.format != "finance-atlas-web-enc-v1" || value.version != 1 || uuid::Uuid::parse_str(&value.revision).is_err()
        || STANDARD.decode(&value.salt).map(|b| b.len()).unwrap_or(0) != 16
        || STANDARD.decode(&value.iv).map(|b| b.len()).unwrap_or(0) != 12 {
        return Err("The encrypted snapshot header is invalid.".into());
    }
    let size = STANDARD.decode(&value.ciphertext).map_err(|_| "Invalid encrypted snapshot.")?.len();
    if !(17..=30_000_016).contains(&size) { return Err("Invalid encrypted snapshot size.".into()); }
    Ok(value.revision)
}

fn atomic_write(path: &Path, bytes: &[u8], overwrite: bool) -> Result<(), String> {
    let parent = path.parent().ok_or("Choose a valid output folder.")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot create a file in the selected folder.")?;
    temp.write_all(bytes).map_err(|_| "The file could not be written.")?;
    temp.as_file().sync_all().map_err(|_| "The file could not be flushed to disk.")?;
    if overwrite { temp.persist(path).map_err(|_| "Cannot replace the selected file.")?; }
    else { temp.persist_noclobber(path).map_err(|_| "A backup with this revision already exists.")?; }
    if fs::read(path).map_err(|_| "Cannot verify the saved file.")? != bytes { return Err("Saved file verification failed.".into()); }
    Ok(())
}

fn safe_name(input: &str) -> String {
    let name: String = input.chars().filter(|c| !c.is_control() && !"/\\:*?\"<>|".contains(*c)).take(140).collect();
    let trimmed = name.trim_matches([' ', '.']);
    if trimmed.is_empty() { "Finance_Atlas_Backup.atlasenc".into() } else { trimmed.into() }
}

#[tauri::command]
async fn export_file(name: String, data: String) -> Result<Option<String>, String> {
    if data.len() > (MAX_EXPORT / 3 + 1) * 4 { return Err("The export exceeds 64 MB.".into()); }
    let bytes = STANDARD.decode(data).map_err(|_| "Invalid export content.")?;
    if bytes.len() > MAX_EXPORT { return Err("The export exceeds 64 MB.".into()); }
    let file = rfd::AsyncFileDialog::new().set_title("Save Finance Atlas export").set_file_name(safe_name(&name)).save_file().await;
    let Some(file) = file else { return Ok(None); };
    let path = file.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        atomic_write(&path, &bytes, true)?;
        Ok(Some(path.display().to_string()))
    }).await.map_err(|_| "The export could not be completed.".to_string())?
}

#[tauri::command]
fn backup_folder(folder: tauri::State<BackupFolder>) -> Result<Option<String>, String> {
    Ok(folder.0.lock().map_err(|_| "Backup settings are busy.")?.as_ref().map(|p| p.display().to_string()))
}

#[tauri::command]
async fn choose_backup_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let file = rfd::AsyncFileDialog::new().set_title("Choose encrypted backup folder").pick_folder().await;
    let Some(file) = file else { return Ok(None); };
    let path = fs::canonicalize(file.path()).map_err(|_| "Choose an accessible local folder.")?;
    let config_dir = app.path().app_config_dir().map_err(|_| "Desktop configuration is unavailable.")?;
    fs::create_dir_all(&config_dir).map_err(|_| "Cannot create desktop configuration.")?;
    let config = serde_json::to_vec(&path).map_err(|_| "Cannot save the folder selection.")?;
    atomic_write(&config_dir.join("backup-folder.json"), &config, true)?;
    let result = path.display().to_string();
    *app.state::<BackupFolder>().0.lock().map_err(|_| "Backup settings are busy.")? = Some(path);
    Ok(Some(result))
}

#[tauri::command]
async fn write_encrypted_backup(app: tauri::AppHandle, text: String) -> Result<String, String> {
    let revision = validate_backup(&text)?;
    let selected = app.state::<BackupFolder>().0.lock().map_err(|_| "Backup settings are busy.")?.clone().ok_or("Choose a backup folder first.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let current = fs::canonicalize(&selected).map_err(|_| "The selected backup folder is unavailable.")?;
        if current != selected { return Err("The backup folder changed. Choose it again in Settings.".into()); }
        let path = current.join(format!("Finance_Atlas_{revision}.atlasenc"));
        if path.exists() {
            if fs::read(&path).map_err(|_| "Cannot read the existing backup.")? != text.as_bytes() { return Err("A different backup already uses this revision.".into()); }
        } else { atomic_write(&path, text.as_bytes(), false)?; }
        Ok(path.display().to_string())
    }).await.map_err(|_| "The backup could not be completed.".to_string())?
}

#[tauri::command]
fn set_native_theme(window: tauri::WebviewWindow, theme: String) -> Result<(), String> {
    let theme = match theme.as_str() { "dark" => tauri::Theme::Dark, "light" => tauri::Theme::Light, _ => return Err("Choose a light or dark theme.".into()) };
    window.set_theme(Some(theme)).map_err(|_| "The window theme could not be updated.".into())
}

#[tauri::command]
fn open_public_source(address: String) -> Result<(), String> {
    if address.len() > 4096 { return Err("The source link is too long.".into()); }
    let url = tauri::Url::parse(&address).map_err(|_| "Invalid source link.")?;
    if url.scheme() != "https" ||
        url.host_str().is_none_or(|host| !host.contains('.') || host.ends_with(".localhost") || host.parse::<std::net::IpAddr>().is_ok()) ||
        !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return Err("Open a public HTTPS source.".into());
    }
    std::process::Command::new("explorer.exe").arg(url.as_str()).spawn().map_err(|_| "Could not open the browser.")?;
    Ok(())
}

pub fn run() {
    let test_profile = if cfg!(debug_assertions) { std::env::var_os("ATLAS_DESKTOP_TEST_PROFILE") } else { None };
    let mut context = tauri::generate_context!();
    if test_profile.is_some() {
        context.config_mut().identifier.push_str(".smoke-test");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.unminimize(); let _ = window.set_focus(); }
        }))
        .manage(BackupFolder::default())
        .invoke_handler(tauri::generate_handler![export_file, backup_folder, choose_backup_folder, write_encrypted_backup, set_native_theme, open_public_source, cloud_auth::desktop_pair])
        .setup(move |app| {
            if test_profile.is_none() {
                let config_dir = app.path().app_config_dir()?;
                if let Ok(bytes) = fs::read(config_dir.join("backup-folder.json")) {
                    if let Ok(path) = serde_json::from_slice::<PathBuf>(&bytes) {
                        *app.state::<BackupFolder>().0.lock().map_err(|_| "Backup settings are busy")? = Some(path);
                    }
                }
            }
            let config = &app.config().app.windows[0];
            let mut builder = tauri::WebviewWindowBuilder::from_config(app, config)?;
            let profile = app.path().app_local_data_dir()?.join("webview");
            // Native integration checks use a separate profile and never access a real vault.
            let profile = if let Some(test) = test_profile.as_ref() {
                let path = fs::canonicalize(PathBuf::from(test))?;
                let temporary = fs::canonicalize(std::env::temp_dir())?;
                if !path.starts_with(temporary) || !path.file_name().is_some_and(|n| n.to_string_lossy().starts_with("finance-atlas-desktop-test-")) {
                    return Err("Desktop test profile must be an isolated temporary directory".into());
                }
                path
            } else { profile };
            fs::create_dir_all(&profile)?;
            builder = builder.data_directory(profile);
            builder
                .prevent_overflow()
                .on_navigation(|url| {
                    let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
                    local
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .run(context)
        .expect("Finance Atlas could not start");
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot() -> String { serde_json::json!({"format":"finance-atlas-web-enc-v1","version":1,"revision":"12345678-1234-4234-8234-123456789abc","salt":STANDARD.encode([0u8;16]),"iv":STANDARD.encode([0u8;12]),"ciphertext":STANDARD.encode([0u8;17])}).to_string() }
    #[test] fn backups_reject_plaintext_and_extra_fields() {
        assert!(validate_backup(&snapshot()).is_ok());
        assert!(validate_backup("{\"transactions\":[]}").is_err());
        let mut value: serde_json::Value = serde_json::from_str(&snapshot()).unwrap();
        value["transactions"] = serde_json::json!([]);
        assert!(validate_backup(&value.to_string()).is_err());
    }
    #[test] fn backups_are_atomic_and_cannot_replace_other_revisions() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("backup.atlasenc");
        atomic_write(&path, b"first", false).unwrap();
        assert!(atomic_write(&path, b"second", false).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"first");
        atomic_write(&path, b"second", true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
    }
    #[test] fn export_names_cannot_specify_paths() {
        assert!(!safe_name("../../secret\\file.txt").contains('/'));
        assert!(!safe_name("../../secret\\file.txt").contains('\\'));
        assert_eq!(safe_name("..."), "Finance_Atlas_Backup.atlasenc");
    }
}
