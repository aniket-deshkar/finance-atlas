# Finance Atlas Desktop

The Windows application uses Tauri 2 and the same static Next.js frontend as the web app. All frontend assets ship inside the executable. No Next.js server, Chrome window, Google account, cloud database, or LLM service is needed to run it. Windows renders the interface using Microsoft Edge WebView2. The installer embeds the WebView2 offline installer so installation does not depend on downloading that runtime.

## Build on Windows

Install Node 24, Rust with an MSVC toolchain, Microsoft C++ Build Tools with a Windows SDK, and WebView2. On Windows ARM64, install the ARM64/ARM64EC C++ tools as well. See the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/).

This workspace also supports an isolated Rust installation under the parent workspace's `.toolchains/finance-atlas` directory. The desktop scripts discover it automatically; no system PATH change is required. Microsoft build tools installed through Visual Studio Installer remain registered Windows build dependencies.

```powershell
cd path\to\FinanceAtlas
npm.cmd ci
npm.cmd run desktop:check
npm.cmd run desktop:test
npm.cmd run desktop:build
```

The executable is `src-tauri\target\release\finance-atlas.exe`. Installers are under `src-tauri\target\release\bundle\nsis`. The target architecture follows the Rust host, which is ARM64 on the current development machine. Build on an x64 host or install an x64 target and matching linker to distribute an x64 edition.

`npm.cmd run desktop:open` starts the built executable. Subsequent launches focus the existing window. `npm.cmd run desktop:dev` builds the static frontend and starts a debug desktop window; it also uses bundled assets and does not start a web server. Rebuild to pick up frontend edits.

Install with the generated setup executable to add Finance Atlas to Windows. Installer signing is not configured; Windows may display an unknown-publisher warning for this personal build. The application does not auto-update or download application code.

## Move your existing data

The desktop WebView2 profile is separate from Chrome/Edge and localhost. Creating a desktop workspace does not copy or modify a browser's vault.

1. In the browser app, download an encrypted `.atlasenc` backup. Use a full ZIP archive if migrating a legacy HTML app's separate receipt store.
2. Open Finance Atlas Desktop and create a local workspace/passphrase.
3. Open **Settings → Data, backup & security** and preview the encrypted backup or legacy JSON/ZIP.
4. Review the preview, then replace the desktop workspace. For an encrypted restore, supply the backup's original passphrase. The restored workspace is saved under the desktop workspace's encryption key.
5. Check balances and statements against your authoritative records. Keep the source backup.

The passphrase is required to decrypt the vault and is not sent to the Rust host. Desktop financial data remains an AES-GCM encrypted IndexedDB vault in the application's WebView2 profile under its per-user local application-data directory (`app.financeatlas.desktop\webview`). This is embedded local storage, not a cloud/server database. The Rust host writes encrypted backup files and user-requested exports. App configuration contains the chosen backup path; the remembered theme is also a nonfinancial preference.

## Backups, exports and privacy

Choose the backup folder in **Settings → Data, backup & security**. The desktop uses a native folder picker and writes only validated encrypted snapshots to that selected folder. Writes use a temporary file, flush to disk, and verify the saved bytes. A different file using an existing revision is rejected. Copies run after changes and daily while the workspace is open and unlocked.

JSON, CSV, XLSX, ZIP and attachment exports use a native Save dialog and are readable unless explicitly exported as `.atlasenc`. The export limit is 64 MB. Import uses the standard file picker and the existing validation/preview flow. Folder access is limited to the selected backup folder; no general filesystem or shell plugin is enabled.

The local build handles questions about attached figures inside Assistant. Cloud
models and market feeds require a configured deployment and an owner sign-in.
Selecting a public reference opens it in your system browser. Uploaded originals,
their extracted text, and chat history use encrypted device records outside the
synced ledger. An Atlas ledger backup excludes those device records. Use Documents
to save an original or export the document index.

Keep an independent encrypted backup before uninstalling, clearing application data, or moving PCs. Uninstalling the executable is not a data-migration method. Do not change the Tauri application identifier or WebView2 profile path without a migration plan.

## Verification

`desktop:test` runs the native encrypted-envelope validation and atomic-write regressions. The existing `npm.cmd test` checks financial rules. `npm.cmd run build` and `npm.cmd run test:browser` verify the embedded frontend. `node tests/desktop-smoke.mjs` checks a debug executable using an explicitly isolated temporary WebView2 profile and synthetic records. Debug test-profile overrides are ignored by release builds.
