import {existsSync, readFileSync} from "node:fs";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {resolve, delimiter} from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const isolated = resolve(root, "../.toolchains/finance-atlas");
const env = {...process.env, NEXT_TELEMETRY_DISABLED: "1"};
if (existsSync(resolve(isolated, "cargo/bin/cargo.exe"))) {
  env.CARGO_HOME = resolve(isolated, "cargo");
  env.RUSTUP_HOME = resolve(isolated, "rustup");
  env.PATH = resolve(isolated, "cargo/bin") + delimiter + env.PATH;
}
const action = process.argv[2];
if (action === "open") {
  const executable = resolve(root, "src-tauri/target/release/finance-atlas.exe");
  if (!existsSync(executable)) throw Error("Build the desktop app first with npm.cmd run desktop:build.");
  const app = spawn(executable, [], {cwd: root, detached: true, stdio: "ignore"});
  app.on("error", error => {console.error(error.message);process.exitCode = 1;});
  app.unref();
} else {
  const rust = spawnSync("cargo", ["--version"], {env, encoding: "utf8", windowsHide: true});
  if (rust.error || rust.status) throw Error("Rust is required. See docs/DESKTOP.md for the Windows build prerequisites.");
  const command = action === "check" || action === "test" ? "cargo" : process.execPath;
  const args = action === "check" || action === "test" ? [action, "--manifest-path", "src-tauri/Cargo.toml"] :
    [resolve(root, "node_modules/@tauri-apps/cli/tauri.js"), action ?? "build", ...process.argv.slice(3)];
  if (command === process.execPath && env.NEXT_PUBLIC_ATLAS_ORIGIN) {
    if (!/^https:\/\/[a-z0-9-]+\.web\.app$/.test(env.NEXT_PUBLIC_ATLAS_ORIGIN)) throw Error("Use the dedicated HTTPS Firebase Hosting origin.");
    const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
    const csp = config.app.security.csp.replace("http://ipc.localhost;", "http://ipc.localhost " + env.NEXT_PUBLIC_ATLAS_ORIGIN + " https://identitytoolkit.googleapis.com https://securetoken.googleapis.com;");
    args.push("--config", JSON.stringify({app:{security:{csp}}}));
  }
  const child = spawn(command, args, {cwd: root, env, stdio: "inherit", windowsHide: true});
  child.on("error", error => {console.error(error.message);process.exitCode = 1;});
  child.on("exit", code => {process.exitCode = code ?? 1;});
}
