// File operations for the right-click menu, on this computer only (writeTextFile is local, and the
// menu hides them for remote spaces). Windows goes through PowerShell, whose -LiteralPath and quoting
// keep names with spaces, apostrophes and accents intact; macOS and Linux use their usual tools.
import { exec, writeTextFile, window } from "herdr";

const platform = () => window()?.platform;
const quote = s => "'" + s.replace(/['‘’‚‛]/g, "$&$&") + "'";
const parentOf = path => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));

async function powershell(script, timeout) {
  // Without Stop, a failed .NET call (a missing file, a locked folder) still exits 0.
  const r = await exec("powershell", ["-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; " + script], { timeout });
  if (r.code !== 0) throw new Error(firstLine(r.stderr) || "The operation failed");
}

async function run(command, args) {
  const r = await exec(command, args);
  if (r.code !== 0) throw new Error(firstLine(r.stderr) || `${command} failed`);
}

// PowerShell errors span several lines; the first one says what went wrong.
function firstLine(text) {
  const line = (text ?? "").split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? "";
  return line.replace(/^Exception calling "\w+" with "\d+" argument\(s\): /, "").replace(/^"|"$/g, "");
}

export const trashName = () => (platform() === "windows" ? "Recycle Bin" : "Trash");
export const revealLabel = () => (platform() === "windows" ? "Reveal in File Explorer" : platform() === "macos" ? "Reveal in Finder" : "Open Containing Folder");

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// Why a new name can't be used, or null.
export function invalidName(name) {
  const windows = platform() === "windows";
  if (!name) return "A name is required";
  if (name === "." || name === "..") return `"${name}" is not a valid name`;
  if (windows ? /[\\/:*?"<>|]/.test(name) : name.includes("/")) return windows ? 'A name can\'t contain \\ / : * ? " < > |' : "A name can't contain /";
  if (windows && /[. ]$/.test(name)) return "A name can't end with a dot or a space";
  if (windows && RESERVED.test(name)) return `"${name}" is reserved by Windows`;
  return null;
}

export async function createFile(path) {
  await writeTextFile(path, "", null);
}

export async function createFolder(path) {
  if (platform() === "windows") await powershell(`New-Item -ItemType Directory -Path ${quote(path)} | Out-Null`);
  else await run("mkdir", ["--", path]);
}

export async function rename(path, name) {
  if (platform() === "windows") await powershell(`Rename-Item -LiteralPath ${quote(path)} -NewName ${quote(name)}`);
  else await run("mv", ["--", path, `${parentOf(path)}/${name}`]);
}

// Into another folder, keeping the name. The explorer checks the name is free first; -n is a backstop.
export async function move(path, folder) {
  if (platform() === "windows") await powershell(`Move-Item -LiteralPath ${quote(path)} -Destination ${quote(folder)}`);
  else await run("mv", ["-n", "--", path, `${folder}/`]);
}

// Recoverable: the Recycle Bin on Windows, the Trash elsewhere.
export async function trash(path, dir) {
  const p = platform();
  if (p === "windows") {
    // OnlyErrorDialogs: no progress or confirmation window; the explorer asked already.
    await powershell(`Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::Delete${dir ? "Directory" : "File"}(${quote(path)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`, 120000);
  } else if (p === "macos") {
    await run("osascript", ["-e", `tell application "Finder" to delete POSIX file ${JSON.stringify(path)}`]);
  } else {
    await run("gio", ["trash", "--", path]);
  }
}

export async function reveal(path) {
  const p = platform();
  // explorer.exe wants /select,"path" as one argument, quotes included.
  if (p === "windows") await powershell(`Start-Process explorer.exe -ArgumentList ('/select,"' + ${quote(path)} + '"')`);
  else if (p === "macos") await run("open", ["-R", path]);
  else await run("xdg-open", [parentOf(path) || "/"]);
}
