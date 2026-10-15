#!/usr/bin/env node
// Watcher fork: compiles resources/watcher-ble.cs (WinRT BLE central for the
// Watcher link, spec O14) with the .NET Framework csc.exe that ships with
// Windows 10/11, against the OS WinRT metadata. No SDK or NuGet needed.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "win32") process.exit(0);

const projectRoot = path.resolve(__dirname, "..");
const source = path.join(projectRoot, "resources", "watcher-ble.cs");
const outputDir = path.join(projectRoot, "resources", "bin");
const output = path.join(outputDir, "watcher-ble.exe");

const log = (msg) => console.log(`[watcher-ble] ${msg}`);

const windir = process.env.WINDIR || "C:\\Windows";
const framework = path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319");
const winmd = path.join(windir, "System32", "WinMetadata");

function upToDate() {
  try {
    return fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs;
  } catch {
    return false;
  }
}

function compile() {
  const csc = path.join(framework, "csc.exe");
  if (!fs.existsSync(csc)) return false;
  const refs = [
    path.join(winmd, "Windows.Devices.winmd"),
    path.join(winmd, "Windows.Foundation.winmd"),
    path.join(winmd, "Windows.Storage.winmd"),
    path.join(winmd, "Windows.Security.winmd"),
    path.join(framework, "System.Runtime.dll"),
    path.join(framework, "System.Threading.Tasks.dll"),
    path.join(framework, "System.Runtime.InteropServices.WindowsRuntime.dll"),
  ];
  const args = [
    "/nologo",
    "/optimize+",
    "/target:exe",
    "/platform:anycpu",
    `/out:${output}`,
    ...refs.map((r) => `/r:${r}`),
    source,
  ];
  const result = spawnSync(csc, args, { stdio: "inherit", cwd: projectRoot });
  return !result.error && result.status === 0 && fs.existsSync(output);
}

fs.mkdirSync(outputDir, { recursive: true });
if (upToDate()) {
  log("Binary is up to date, skipping build");
} else if (compile()) {
  log("Built with .NET Framework csc");
} else {
  console.warn("[watcher-ble] Build failed (needs .NET Framework 4.x csc.exe).");
  console.warn("[watcher-ble] The Watcher BLE link will be unavailable.");
}
