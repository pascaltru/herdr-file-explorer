// An IDE-style explorer for the space's repository: editor tabs on the left, the file tree on the right.
// Derived from the Herdr app's `files` mod (Apache-2.0, see LICENSE-Herdr.txt) and modified; see NOTICE.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Scrollbar, v_virtual_list, VirtualListScrollHandle, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, appHome, layout, nextCommand, openOverlay, shared, setShared, props, notify } from "herdr";
import * as fs from "fs/promises";
import { NAME, REQUEST, renderSettings, renderContext, renderDelete, contextItems, contextHeight, openDeleteDialog } from "./menus.js";
import * as ops from "./ops.js";

const PER_FOLDER = 500, TOTAL = 5000, PREFETCH = 40, MAX_GIT_PATHS = 200000, CACHE = "cache/file-explorer";
const MOD = `mods/${NAME}`, THEMES = `${MOD}/icon-themes`, DEFAULT_THEME = "seti";
// The settings menu's choice. Shared state rather than config.json: writing a file in the mod
// folder would hot-reload the explorer and close its tabs.
const THEME_KEY = `${NAME}.iconTheme`;
const TREE_WIDTH = 280, NARROW = 368, ROW = 24, PAGE = 10;
// The key of the row where a new file or folder is named; real paths never hold "//".
const NEW_ROW = "//new";
const CONFLICTS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]), RANK = { U: 1, A: 2, D: 3, M: 4, C: 5 };
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);

// Mod panes have no folder, so the tree stays on the space's last focused terminal.
const lastTerminal = new Map();
function location() {
  const space = spaces().find(s => s.active), f = focused();
  if (!space) return { space: null, cwd: null, on: null };
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  if (pane?.terminal && pane.cwd) lastTerminal.set(space.id, { cwd: pane.cwd, on: space.machine ?? null, pane: pane.pane });
  else if (f && f.pane === null && f.cwd) lastTerminal.set(space.id, { cwd: f.cwd, on: f.terminal?.includes("/") ? f.terminal.split("/")[0] : null, pane: null });
  let last = lastTerminal.get(space.id);
  if (!last) {
    const any = panes().find(p => p.tab === f?.tab && p.terminal && p.cwd);
    last = { cwd: any?.cwd || space.folder || null, on: space.machine ?? null, pane: any?.pane ?? null };
  }
  return { space: space.id, ...last };
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = findNode(child, id); if (found) return found; }
  return null;
}

const readJson = async path => JSON.parse(await fs.readFile(`${appHome()}/${path}`, "utf8"));

// The menu's choice, else the install's (config.json), else Seti.
async function preferredTheme() {
  const chosen = shared(THEME_KEY);
  if (typeof chosen === "string" && chosen) return chosen;
  try { return (await readJson(`${MOD}/config.json`)).iconTheme || DEFAULT_THEME; } catch { return DEFAULT_THEME; }
}

// The installed themes: every icon-themes/<name>/theme.json, with its label.
async function listThemes() {
  const out = [];
  for (const dir of await fs.readdir(`${appHome()}/${THEMES}`, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    try { out.push({ name: dir.name, label: (await readJson(`${THEMES}/${dir.name}/theme.json`)).label || dir.name }); } catch {}
  }
  return out.sort((a, b) => (a.name === DEFAULT_THEME ? -1 : b.name === DEFAULT_THEME ? 1 : a.label.localeCompare(b.label)));
}

// The icon theme (icon-themes/<name>/theme.json), with VS Code's language table.
async function loadIconTheme(name) {
  const read = readJson;
  const languages = await read(`${THEMES}/languages.json`).catch(() => ({ extensions: {}, fileNames: {} }));
  for (const candidate of [name, DEFAULT_THEME]) {
    try { return { name: candidate, base: `${THEMES}/${candidate}/`, theme: await read(`${THEMES}/${candidate}/theme.json`), languages, cache: new Map() }; }
    catch {}
  }
  return null;
}

// VS Code's order: file name, then extensions longest first ("a.test.ts": "test.ts", then "ts"),
// then the language those imply, then the theme's default. Light themes try their own maps first.
function resolveIcon(icons, name, dir, open, light) {
  const key = `${light ? 1 : 0}${dir ? (open ? 2 : 1) : 0}${name}`;
  if (icons.cache.has(key)) return icons.cache.get(key);
  const th = icons.theme, n = name.toLowerCase();
  const look = (section, k) => (light ? th.light?.[section]?.[k] : undefined) ?? th[section]?.[k];
  const suffixes = [];
  for (let i = n.indexOf("."); i !== -1; i = n.indexOf(".", i + 1)) suffixes.push(n.slice(i + 1));
  let id;
  if (dir) id = th.folders ? look(open ? "folderNamesExpanded" : "folderNames", n) ?? (open ? th.folderExpanded : th.folder) : null;
  else {
    id = look("fileNames", n);
    for (const s of suffixes) { if (id) break; id = look("fileExtensions", s); }
    if (!id) {
      let lang = icons.languages.fileNames[n];
      for (const s of suffixes) { if (lang) break; lang = icons.languages.extensions[s]; }
      if (lang) id = look("languageIds", lang);
    }
    id ??= (light && th.light?.file) || th.file;
  }
  const def = id ? th.icons[id] : null;
  const icon = !def ? null : th.render === "glyph" ? { glyph: icons.base + def.svg, color: def.color } : { image: icons.base + def };
  icons.cache.set(key, icon);
  return icon;
}

// Folders first, then names case-insensitively with digit runs padded, so "note2" sorts before
// "note10". The key is computed once per entry: comparing with regular expressions instead cost
// about 130 ms per refresh of a 1,400-file repository in Herdr's JavaScript engine.
const sortKey = e => (e.dir ? "0" : "1") + e.name.toLowerCase().replace(/\d+/g, d => d.replace(/^0+/, "").padStart(12, "0"));

// Entries carry their key: an entry whose name or kind changes must be a new object.
function sortEntries(list) {
  for (const e of list) e.key ??= sortKey(e);
  return list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const quote = s => "'" + s.replace(/['‘’‚‛]/g, "$&$&") + "'";
const base = rel => rel.slice(rel.lastIndexOf("/") + 1);
const extension = rel => { const n = base(rel), i = n.lastIndexOf("."); return i > 0 ? n.slice(i + 1).toLowerCase() : ""; };

// Lists several folders in one process (starting PowerShell dominates the cost): null for a folder that's gone.
async function listFolders(paths, on, windows) {
  const viaPowerShell = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target. OneDrive's reparse points are folders.
    const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $res = foreach ($p in @(" + paths.map(quote).join(",") + ")) { try { ,@{ e = @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First " + (PER_FOLDER + 1) + " | ForEach-Object { @{ n = $_.Name; d = [bool]($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0]))))) } }) } } catch { ,@{ e = $null } } }; ConvertTo-Json -InputObject @($res) -Depth 5 -Compress";
    const r = await exec("powershell", ["-NoProfile", "-Command", script], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    return JSON.parse(r.stdout).map(x => x.e === null ? null : (Array.isArray(x.e) ? x.e : [x.e]).map(e => ({ name: e.n, dir: e.d })));
  };
  if (windows) return viaPowerShell();
  const script = 'for dir in "$@"; do if [ -d "$dir" ]; then printf "D\\0"; n=0; for p in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then k=d; else k=f; fi; printf "%s\\0%s\\0" "$k" "$name"; n=$((n+1)); [ "$n" -gt ' + PER_FOLDER + ' ] && break; done; printf "E\\0"; else printf "X\\0"; fi; done';
  let r;
  try { r = await exec("sh", ["-c", script, "explorer", ...paths], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return viaPowerShell();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const t = r.stdout.split("\0"), out = [];
  for (let i = 0; i < t.length && out.length < paths.length;) {
    if (t[i] === "X") { out.push(null); i++; continue; }
    if (t[i] !== "D") break;
    const entries = [];
    for (i++; i < t.length && t[i] !== "E"; i += 2) entries.push({ name: t[i + 1], dir: t[i] === "d" });
    out.push(entries); i++;
  }
  return out;
}

export default class Explorer extends View {
  init(_props, cx) {
    // The same mod opened as an overlay draws only that popup (menus.js).
    const p = props();
    if (p?.menu === "settings") {
      this.menu = { kind: "settings", themes: [], current: p.theme ?? null };
      cx.spawn(async cx => { this.menu.themes = await listThemes(); this.menu.current ??= await preferredTheme(); cx.notify(); });
      return;
    }
    if (p?.menu === "context" || p?.menu === "delete") {
      this.menu = { kind: p.menu };
      if (p.menu === "delete") { this.menu.handle = cx.focus_handle(); this.menu.handle.focus(); }
      return;
    }
    // Requests are kept in shared state across restarts: only act on ones made from now on.
    this.lastRequest = shared(REQUEST)?.id ?? null;
    this.edit = null;
    this.saved = new Map(); this.roots = new Map(); this.context = null; this.locKey = null; this.wide = null;
    this.h = cx.focus_handle(); this.scroll = VirtualListScrollHandle.new(); this.panelShown = null; this.icons = null;
    this.themeLoading = true;
    cx.spawn(async cx => { this.icons = await loadIconTheme(await preferredTheme()); this.themeLoading = false; cx.notify(); });
    this.version = 0; this.flatCache = null; this.typed = ""; this.typedAt = 0; this.terminalPane = null;
    this.reset();
    // Remote spaces can't be watched, and a failed watch falls back to polling.
    cx.timer.every(10000, cx => { if (this.context && (this.context.on || this.context.poll)) this.reload(cx, null, true); });
    // pane.go (alt+arrows) hands the keyboard to this panel.
    cx.spawn(async cx => { for (;;) { const c = await nextCommand(); if (c === "focus") this.h.focus(); cx.notify(); } });
  }

  reset(saved) {
    this.entries = saved?.entries ?? new Map(); this.folders = saved?.folders ?? new Set(); this.marks = saved?.marks ?? {}; this.folderMarks = saved?.folderMarks ?? {}; this.ignored = saved?.ignored ?? new Set(); this.ignoredCache = new Map();
    this.ignoredEntries = saved?.ignoredEntries ?? []; this.lazy = saved?.lazy ?? new Set();
    this.selected = saved?.selected ?? null; this.tabs = saved?.tabs ?? []; this.active = saved?.active ?? null;
    this.views = new Map(); this.changed = new Set(); this.flushing = false; this.error = null; this.limited = false;
    this.version++;
  }

  windows(context = this.context) { return !context?.on && window()?.platform === "windows"; }

  join(rel, context = this.context) {
    if (!rel) return context.root;
    return this.windows(context) ? `${context.root}\\${rel.replace(/\//g, "\\")}` : `${context.root}/${rel}`;
  }

  // --- Where the tree is -------------------------------------------------------------

  sync(cx) {
    const loc = location(), k = JSON.stringify([loc.space, loc.on, loc.cwd]);
    this.terminalPane = loc.pane;
    if (loc.space !== this.space) { this.space = loc.space; this.spaceChangedAt = Date.now(); }
    if (k === this.locKey) return;
    this.locKey = k;
    if (!loc.cwd) { this.switchTo(null, null, false, cx); return; }
    cx.spawn(async cx => {
      const { root, repo } = await this.resolveRoot(loc.cwd, loc.on);
      if (this.locKey !== k) return;
      this.switchTo(root, loc.on, repo, cx);
      cx.notify();
    });
  }

  async resolveRoot(cwd, on) {
    const key = `${on ?? ""}|${cwd}`;
    if (this.roots.has(key)) return this.roots.get(key);
    let root = cwd, repo = false;
    try {
      const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      if (r.code === 0 && r.stdout.trim()) { root = r.stdout.trim(); repo = true; }
    } catch {}
    // Git answers C:/x on Windows; Herdr and PowerShell use C:\x.
    if (!on && window()?.platform === "windows") root = root.replace(/\//g, "\\");
    this.roots.set(key, { root, repo });
    return { root, repo };
  }

  switchTo(root, on, repo, cx) {
    const old = this.context;
    if (old && old.root === root && old.on === on) return;
    if (old) {
      for (const view of this.views.values()) this.release(view);
      this.saved.set(`${old.on ?? ""}|${old.root}`, { entries: this.entries, folders: this.folders, marks: this.marks, folderMarks: this.folderMarks, ignored: this.ignored, ignoredEntries: this.ignoredEntries, lazy: this.lazy, selected: this.selected, tabs: this.tabs, active: this.active });
    }
    if (!root) { this.context = null; this.reset(); this.fit(); return; }
    this.reset(this.saved.get(`${on ?? ""}|${root}`));
    // Outside a repository (a terminal in the home folder), a recursive watch would see every file on disk: poll instead.
    this.context = { root, on, repo, want: null, busy: false, poll: !repo, watched: false };
    this.reload(cx, null, true);
    this.watch(cx);
    this.fit();
  }

  // --- Reading the disk --------------------------------------------------------------

  watch(cx) {
    const context = this.context;
    if (!context || context.on || !context.repo || context.watched) return;
    context.watched = true;
    cx.spawn(async cx => {
      try {
        while (this.context === context) {
          const changed = await watchFolder(context.root);
          if (this.context !== context) return;
          for (const p of changed) this.changed.add(p);
          if (!this.flushing) {
            this.flushing = true;
            // A build or checkout sends bursts; collect them into one refresh.
            cx.timer.after(400, cx => { this.flushing = false; this.flush(context, cx); });
          }
        }
      } catch { if (this.context === context) context.poll = true; }
    });
  }

  flush(context, cx) {
    if (this.context !== context) return;
    const paths = [...this.changed]; this.changed.clear();
    const rootSlash = context.root.replace(/\\/g, "/"), windows = this.windows(context);
    const fold = s => windows ? s.toLowerCase() : s, rootKey = fold(rootSlash);
    const dirs = new Set();
    let all = false, git = false;
    for (const p of paths) {
      const slash = p.replace(/\\/g, "/");
      if (fold(slash) === rootKey) { all = true; break; }
      if (!fold(slash).startsWith(rootKey + "/")) continue;
      const rel = slash.slice(rootSlash.length + 1);
      git = true;
      if (rel === ".git" || rel.startsWith(".git/")) continue;
      const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      if (this.entries.has(parent)) dirs.add(parent);
      // An agent editing an open file: show the new text.
      if (this.tabs.some(t => t.rel === rel)) this.stale(rel, cx);
    }
    if (all) { this.reload(cx, null, true); for (const t of this.tabs) this.stale(t.rel, cx); }
    else if (dirs.size || git) this.reload(cx, [...dirs], git);
  }

  // Coalesces requests: one listing and one git status at a time per context.
  reload(cx, dirs, git) {
    const context = this.context;
    if (!context) return;
    const want = context.want ??= { all: false, dirs: new Set(), git: false };
    if (dirs === null) want.all = true; else for (const d of dirs) want.dirs.add(d);
    if (git) want.git = true;
    if (context.busy) return;
    context.busy = true;
    cx.spawn(async cx => {
      try {
        while (context.want && this.context === context) {
          const w = context.want; context.want = null;
          let rels = w.all ? ["", ...this.folders] : [...w.dirs].filter(d => d === "" || this.entries.has(d) || this.folders.has(d));
          if (context.repo) {
            // git lists the whole repository in one quick call; only the folders it leaves out
            // (ignored, untracked) are read from disk, which on Windows means starting PowerShell.
            if (w.all || w.git) { const changed = await this.status(context); if (this.context === context) await this.gitTree(context, changed); }
            rels = rels.filter(r => this.isLazy(r));
            if (rels.length && this.context === context) await this.load(rels, context);
          } else {
            if (rels.length) await this.load(rels, context);
            if (w.git && this.context === context) await this.status(context);
          }
          if (this.context === context) this.error = null;
          cx.notify();
          // Read one level ahead, so opening a folder shows its contents at once.
          if (!context.want && this.context === context) {
            const ahead = this.ahead();
            if (ahead.length) { await this.load(ahead, context); cx.notify(); }
          }
        }
      } catch (e) { if (this.context === context) this.error = String(e?.message ?? e); }
      finally { context.busy = false; cx.notify(); }
    });
  }

  ahead() {
    const out = [];
    for (const folder of ["", ...this.folders]) {
      for (const e of this.entries.get(folder) ?? []) {
        const rel = folder ? `${folder}/${e.name}` : e.name;
        if (e.dir && !this.entries.has(rel)) out.push(rel);
        if (out.length >= PREFETCH) return out;
      }
    }
    return out;
  }

  async load(rels, context) {
    const lists = await listFolders(rels.map(r => this.join(r, context)), context.on, this.windows(context));
    if (this.context !== context) return;
    rels.forEach((rel, i) => {
      const list = lists[i];
      if (list === null) { this.entries.delete(rel); if (rel) this.folders.delete(rel); return; }
      if (list.length > PER_FOLDER) this.limited = true;
      this.entries.set(rel, sortEntries(list.slice(0, PER_FOLDER)));
    });
    this.version++;
  }

  // VS Code's letters: U untracked, A added, M modified, D deleted, C conflict. Folders take the
  // most important mark below them; ignored entries (--ignored=matching lists a folder once) are dimmed.
  // The repository's tree from `git ls-files`: tracked files (less those deleted on disk) and untracked
  // ones. A folder git doesn't list inside (an untracked folder, an ignored one from git status) is
  // "lazy": shown, and read from disk when opened.
  async gitTree(context, statusChanged = true) {
    const r = await exec("git", ["--no-optional-locks", "ls-files", "-z", "-t", "-c", "-d", "-o", "--exclude-standard", "--directory"], { cwd: context.root, on: context.on, timeout: 60000 });
    if (r.code !== 0) throw new Error(r.stderr || "git ls-files failed");
    // Most changes an agent makes edit file contents: same file list, same ignored entries
    // (from git status). Then there's nothing to rebuild, and nothing to redraw.
    if (!statusChanged && r.stdout === context.treeOut) return;
    context.treeOut = r.stdout;
    const items = r.stdout.split("\0"), removed = new Set();
    // -t tags each path: H tracked, R deleted on disk, S not checked out (sparse), ? untracked.
    for (const item of items) if (item.startsWith("R ")) removed.add(item.slice(2));
    const tree = new Map([["", new Map()]]), lazy = new Set();
    const add = (path, dir) => {
      const parts = path.split("/");
      let parent = "";
      for (let i = 0; i < parts.length; i++) {
        const last = i === parts.length - 1, rel = parent ? `${parent}/${parts[i]}` : parts[i];
        const siblings = tree.get(parent) ?? tree.set(parent, new Map()).get(parent);
        siblings.set(parts[i], last ? dir || siblings.get(parts[i]) === true : true);
        if (!last && !tree.has(rel)) tree.set(rel, new Map());
        parent = rel;
      }
    };
    let count = 0;
    for (const item of items) {
      if (!item || item.startsWith("R ") || item.startsWith("S ") || ++count > MAX_GIT_PATHS) continue;
      const path = item.slice(2);
      if (removed.has(path)) continue;
      if (path.endsWith("/")) { add(path.slice(0, -1), true); lazy.add(path.slice(0, -1)); }
      else add(path, false);
    }
    for (const { path, dir } of this.ignoredEntries) { add(path, dir); if (dir) lazy.add(path); }
    if (this.context !== context) return;
    const entries = new Map();
    let limited = count > MAX_GIT_PATHS;
    for (const [folder, names] of tree) {
      // A lazy folder's contents were never listed by git: leave it for the disk.
      if (lazy.has(folder)) continue;
      const list = sortEntries([...names].map(([name, dir]) => ({ name, dir })));
      if (list.length > PER_FOLDER) limited = true;
      entries.set(folder, list.slice(0, PER_FOLDER));
    }
    this.lazy = lazy;
    // Keep what was already read from disk for lazy folders (an opened node_modules).
    for (const [folder, list] of this.entries) if (!entries.has(folder) && this.isLazy(folder)) entries.set(folder, list);
    this.entries = entries;
    this.limited = limited;
    this.version++;
  }

  isLazy(rel) {
    for (let path = rel; path; path = path.slice(0, Math.max(path.lastIndexOf("/"), 0))) if (this.lazy.has(path)) return true;
    return false;
  }

  async status(context) {
    const marks = {}, folders = {}, ignored = new Set(), ignoredEntries = [];
    // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
    const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignored=matching"], { cwd: context.root, on: context.on }).catch(() => null);
    // Unchanged since last time: keep everything (and tell the tree its ignored entries are the same).
    if (r?.code === 0 && r.stdout === context.statusOut) return false;
    if (r?.code === 0) context.statusOut = r.stdout;
    // The root is the repository's top level, so git's paths are already relative to it.
    if (r?.code === 0) for (const entry of r.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
      const xy = entry.slice(0, 2), path = entry.slice(3).replace(/\/$/, "");
      // --ignored=matching names an ignored folder once, with a trailing slash.
      if (xy === "!!") { ignored.add(path); ignoredEntries.push({ path, dir: entry.endsWith("/") }); continue; }
      const mark = CONFLICTS.has(xy) ? "C" : xy === "??" ? "U" : xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
      marks[path] = mark;
      for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
        const folder = path.slice(0, i);
        if (RANK[mark] > (RANK[folders[folder]] ?? 0)) folders[folder] = mark;
      }
    }
    if (this.context === context) { this.marks = marks; this.folderMarks = folders; this.ignored = ignored; this.ignoredEntries = ignoredEntries; this.ignoredCache = new Map(); }
    return true;
  }

  isIgnored(path) {
    if (!this.ignored.size) return false;
    if (this.ignoredCache.has(path)) return this.ignoredCache.get(path);
    const slash = path.lastIndexOf("/");
    const result = this.ignored.has(path) || (slash > 0 && this.isIgnored(path.slice(0, slash)));
    this.ignoredCache.set(path, result);
    return result;
  }

  markColor(mark, t, fallback) {
    // VS Code's hues from the theme: green new, red deleted or conflicted, yellow modified.
    return mark === "U" || mark === "A" ? t.ansi2 : mark === "D" || mark === "C" ? t.ansi1 : mark === "M" ? t.ansi3 : fallback;
  }

  // --- Tree actions ------------------------------------------------------------------

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) this.folders.delete(folder);
    } else {
      this.folders.add(path);
      // Prefetched contents show now; read again in the background in case they changed.
      this.reload(cx, [path], false);
    }
    this.selected = path;
    this.version++;
    cx.notify();
  }

  // The visible rows in order, rebuilt only when the tree changes (render runs on every live-data change).
  flat() {
    if (this.flatCache?.version === this.version) return this.flatCache.rows;
    const rows = [], walk = (prefix, depth) => {
      // A new file or folder is named in a row at the top of its folder, as in VS Code.
      if (this.edit?.kind === "new" && this.edit.parent === prefix) rows.push({ path: `${prefix}${NEW_ROW}`, entry: { name: "", dir: this.edit.dir }, depth, parent: prefix, editing: true });
      for (const entry of this.entries.get(prefix) ?? []) {
        if (rows.length >= TOTAL || depth > 40) return;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        rows.push({ path, entry, depth, parent: prefix });
        if (entry.dir && this.folders.has(path)) walk(path, depth + 1);
      }
    };
    walk("", 0);
    this.flatCache = { version: this.version, rows };
    return rows;
  }

  // on_item_click reports no click count, so a second click on the same row within 400 ms is a double click.
  clicked(path, cx) {
    const row = this.flat().find(r => r.path === path);
    if (!row || row.editing || (this.edit?.kind === "rename" && this.edit.rel === path)) return;
    const now = Date.now(), double = this.lastClick?.path === path && now - this.lastClick.at < 400;
    this.lastClick = double ? null : { path, at: now };
    this.h.focus();
    // Every click toggles a folder, however fast: a double click is only a file's way to keep its tab.
    if (row.entry.dir) this.toggle(path, cx);
    else this.open(path, double, cx);
  }

  // --- Keyboard ----------------------------------------------------------------------

  select(rows, index) {
    const i = Math.max(0, Math.min(rows.length - 1, index));
    if (!rows[i]) return;
    this.selected = rows[i].path;
    this.scroll.scroll_to_item(i);
  }

  key(e, cx) {
    // While naming, keys belong to the input; Escape cancels, Enter arrives as its submit.
    if (this.edit) {
      if (e.key === "escape") { this.endEdit(cx); cx.stop_propagation(); }
      return;
    }
    const rows = this.flat(), i = rows.findIndex(r => r.path === this.selected), row = rows[i];
    let handled = true;
    switch (e.key) {
      case "down": this.select(rows, i + 1); break;
      case "up": this.select(rows, i === -1 ? 0 : i - 1); break;
      case "pagedown": this.select(rows, i + PAGE); break;
      case "pageup": this.select(rows, i - PAGE); break;
      case "home": this.select(rows, 0); break;
      case "end": this.select(rows, rows.length - 1); break;
      case "right":
        if (row?.entry.dir) { if (!this.folders.has(row.path)) this.toggle(row.path, cx); else this.select(this.flat(), i + 1); }
        break;
      case "left":
        if (row?.entry.dir && this.folders.has(row.path)) this.toggle(row.path, cx);
        else if (row?.parent) this.select(rows, rows.findIndex(r => r.path === row.parent));
        break;
      case "enter": if (row) row.entry.dir ? this.toggle(row.path, cx) : this.open(row.path, true, cx); break;
      case "space": if (row && !row.entry.dir) this.open(row.path, false, cx); break;
      case "escape": if (this.terminalPane) run("pane.focus", { pane: this.terminalPane }); break;
      case "f2": if (row) this.startRename(row.path, cx); break;
      case "delete": if (row) this.askDelete(row.path, row.entry.dir); break;
      default: handled = this.typeToFind(e, rows, i);
    }
    if (handled) { cx.stop_propagation(); cx.notify(); }
  }

  // Typing a name jumps to the next row starting with it, as in VS Code and Zed.
  typeToFind(e, rows, i) {
    const m = e.modifiers, ch = e.key_char;
    if (!ch || ch.length !== 1 || m.control || m.alt || m.platform || !rows.length) return false;
    const now = Date.now();
    this.typed = now - this.typedAt > 800 ? ch.toLowerCase() : this.typed + ch.toLowerCase();
    this.typedAt = now;
    // A repeated first letter cycles through matches; a longer prefix stays on the current row if it still matches.
    const start = this.typed.length === 1 ? i + 1 : Math.max(i, 0);
    for (let k = 0; k < rows.length; k++) {
      const j = (start + k) % rows.length;
      if (rows[j].entry.name.toLowerCase().startsWith(this.typed)) { this.select(rows, j); return true; }
    }
    return true;
  }

  // A single click opens a preview tab that the next single click replaces; a double click keeps it.
  open(rel, keep, cx) {
    this.selected = rel;
    const existing = this.tabs.find(t => t.rel === rel);
    if (existing) { if (keep) existing.preview = false; }
    else {
      const preview = this.tabs.findIndex(t => t.preview);
      const tab = { rel, preview: !keep };
      if (preview !== -1) { this.drop(this.tabs[preview].rel); this.tabs[preview] = tab; }
      else this.tabs.push(tab);
    }
    this.active = rel;
    this.fit();
    cx.notify();
  }

  closeTab(rel, cx) {
    const i = this.tabs.findIndex(t => t.rel === rel);
    if (i === -1) return;
    this.tabs.splice(i, 1);
    this.drop(rel);
    if (this.active === rel) this.active = this.tabs[Math.min(i, this.tabs.length - 1)]?.rel ?? null;
    this.fit();
    cx.notify();
  }

  // The panel is as wide as an editor while files are open, and as narrow as a tree otherwise.
  fit() {
    const wide = this.tabs.length > 0;
    if (wide === this.wide) return;
    this.wide = wide;
    run("layout.resize", wide ? { id: "panel", weight: 1.2 } : { id: "panel", px: NARROW });
  }

  // --- File views --------------------------------------------------------------------

  release(view) {
    view.code?.release();
    if (view.picture) fs.unlink(`${appHome()}/${view.picture}`).catch(() => {});
  }

  drop(rel) {
    const view = this.views.get(rel);
    if (view) { this.release(view); this.views.delete(rel); }
  }

  stale(rel, cx) {
    this.drop(rel);
    if (this.active === rel) cx.notify();
  }

  view(rel, cx) {
    let view = this.views.get(rel);
    if (view) return view;
    view = { code: null, picture: null, message: null };
    this.views.set(rel, view);
    const context = this.context, path = this.join(rel), ext = extension(rel);
    cx.spawn(async cx => {
      try {
        if (IMAGES.has(ext)) {
          const picture = context.on ? null : await this.copyImage(path, ext);
          if (this.views.get(rel) !== view) { if (picture) fs.unlink(`${appHome()}/${picture}`).catch(() => {}); return; }
          if (picture) view.picture = picture;
          else view.message = context.on ? "Image previews work for local files only" : "Can't read this image";
          return;
        }
        const text = await readTextFile(path, { on: context.on });
        if (this.views.get(rel) !== view) return;
        if (text === null) { view.message = "This file no longer exists"; return; }
        if (text.includes("\0")) { view.message = "Binary file: no preview"; return; }
        const t = theme();
        view.code = EditorState.new({ language: LANG[ext] ?? (ext || "txt"), readonly: true, value: text,
          font_family: settings().font_family, font_size: 13,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.views.get(rel) === view) view.message = "Can't preview this file: it's over 1 MB or unreadable"; }
      finally { cx.notify(); }
    });
    return view;
  }

  // GPUI's image loader reads only under the app folder, so local images are copied there first.
  async copyImage(path, ext) {
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`, dest = `${appHome()}/${CACHE}/${name}`;
    await fs.mkdir(`${appHome()}/${CACHE}`, { recursive: true });
    const r = window()?.platform === "windows"
      ? await exec("powershell", ["-NoProfile", "-Command", `Copy-Item -LiteralPath ${quote(path)} -Destination ${quote(dest)}`])
      : await exec("cp", ["--", path, dest]);
    return r.code === 0 ? `${CACHE}/${name}` : null;
  }

  async close() {
    for (const view of this.views?.values() ?? []) this.release(view);
  }

  // --- Settings ----------------------------------------------------------------------

  openSettings() {
    // Sized for two themes; the list scrolls if more are installed.
    openOverlay({ mod: NAME, kind: "popup", width: 260, height: 112, props: { menu: "settings", theme: this.icons?.name ?? null } });
  }

  // A theme picked in the menu: load it in place, keeping tabs and folders.
  followTheme(cx) {
    const want = shared(THEME_KEY);
    // A theme that fails to load falls back to Seti; try each choice once rather than on every render.
    if (typeof want !== "string" || !want || this.themeLoading || want === this.icons?.name || want === this.themeTried) return;
    this.themeLoading = true; this.themeTried = want;
    cx.spawn(async cx => {
      const icons = await loadIconTheme(want);
      if (icons) this.icons = icons;
      this.themeLoading = false;
      cx.notify();
    });
  }

  renderMenu(t) {
    if (this.menu.kind === "context") return renderContext(props(), t);
    if (this.menu.kind === "delete") return renderDelete(props(), t, this.menu.handle);
    return renderSettings(this.menu, t, name => setShared(THEME_KEY, name));
  }

  // --- File actions (right-click menu, F2, Delete) -----------------------------------

  // What the popups need to know about an entry ("" is the root folder).
  target(rel, dir) {
    const context = this.context;
    return { rel, dir, root: context.root, full: this.join(rel), relative: this.windows() ? rel.replace(/\//g, "\\") : rel, remote: Boolean(context.on) };
  }

  contextMenu(rel, cx) {
    if (!this.context || this.edit || rel.endsWith(NEW_ROW)) return;
    const row = rel ? this.flat().find(r => r.path === rel) : null;
    if (rel && !row) return;
    if (rel) this.selected = rel;
    const p = this.target(rel, row ? row.entry.dir : true);
    openOverlay({ mod: NAME, kind: "popup", width: 240, height: contextHeight(contextItems(p)), props: { ...p, menu: "context" } });
    cx.notify();
  }

  // The popups ask through shared state; act once on each new request for this tree.
  handleRequest(cx) {
    const r = shared(REQUEST);
    if (!r || r.id === this.lastRequest) return;
    this.lastRequest = r.id;
    if (!this.context || r.root !== this.context.root || this.context.on) return;
    // Rendering is no place to change state: act right after. A timer rather than cx.spawn: the
    // edit schedules its own timer, which a finished task's context drops.
    cx.timer.after(0, cx => {
      if (r.action === "open") this.open(r.rel, true, cx);
      else if (r.action === "rename") this.startRename(r.rel, cx);
      else if (r.action === "new-file" || r.action === "new-folder") this.startNew(r.folder ?? "", r.action === "new-folder", cx);
      else if (r.action === "delete") this.remove(r.rel, r.dir, cx);
      cx.notify();
    });
  }

  beginEdit(edit, value, cx) {
    const input = InputState.new({ value });
    edit.input = input; edit.error = null; edit.busy = false;
    input.on("submit", (_e, cx) => this.commitEdit(cx));
    input.on("change", (_e, cx) => { if (this.edit?.input === input) { this.edit.error = null; cx.notify(); } });
    // As in VS Code, clicking away keeps the name if it's valid.
    input.on("blur", (_e, cx) => { if (this.edit?.input === input && !this.edit.busy) this.commitEdit(cx, true); });
    this.edit = edit;
    this.version++;
    // The input exists once the row is drawn; select the name without its extension, like VS Code.
    cx.timer.after(30, () => {
      if (this.edit?.input !== input) return;
      input.focus();
      const dot = value.lastIndexOf(".");
      input.set_selected_range({ start: 0, end: !edit.dir && dot > 0 ? dot : value.length });
    });
    cx.notify();
  }

  startRename(rel, cx) {
    const row = this.flat().find(r => r.path === rel);
    if (!row || this.context?.on) return;
    this.selected = rel;
    this.beginEdit({ kind: "rename", rel, parent: row.parent, dir: row.entry.dir, name: row.entry.name }, row.entry.name, cx);
  }

  startNew(folder, dir, cx) {
    if (this.context?.on) return;
    if (folder && !this.folders.has(folder)) { this.folders.add(folder); this.reload(cx, [folder], false); }
    this.selected = `${folder}${NEW_ROW}`;
    this.beginEdit({ kind: "new", parent: folder, dir }, "", cx);
  }

  endEdit(cx) {
    this.edit = null;
    this.version++;
    this.h.focus();
    cx.notify();
  }

  commitEdit(cx, blurred = false) {
    const edit = this.edit;
    if (!edit || edit.busy) return;
    const name = edit.input.value().trim(), context = this.context;
    // Nothing typed, or the same name: nothing to do.
    if (!name || (edit.kind === "rename" && name === edit.name)) { this.endEdit(cx); return; }
    const caseOnly = edit.kind === "rename" && name.toLowerCase() === edit.name.toLowerCase();
    const fold = s => (this.windows() ? s.toLowerCase() : s);
    const taken = !caseOnly && (this.entries.get(edit.parent) ?? []).some(e => fold(e.name) === fold(name));
    const error = ops.invalidName(name) ?? (taken ? `“${name}” already exists here` : null);
    if (error) {
      // Leaving the field with a bad name drops the edit; Enter keeps it open to fix.
      if (blurred) { this.endEdit(cx); return; }
      edit.error = error; cx.notify(); return;
    }
    edit.busy = true;
    const parent = edit.parent, rel = parent ? `${parent}/${name}` : name, before = [...(this.entries.get(parent) ?? [])];
    // Show the result at once: on Windows each operation starts PowerShell, about 0.3 s.
    if (edit.kind === "rename") { this.setEntries(parent, before.map(e => (e.name === edit.name ? { name, dir: e.dir } : e))); this.moved(edit.rel, rel); }
    else if (edit.dir) this.setEntries(parent, [...before, { name, dir: true }]);
    this.edit = null;
    this.selected = rel;
    this.version++;
    this.h.focus();
    cx.notify();
    cx.spawn(async cx => {
      try {
        if (edit.kind === "rename") await ops.rename(this.join(edit.rel, context), name);
        else if (edit.dir) await ops.createFolder(this.join(rel, context));
        else await ops.createFile(this.join(rel, context));
      } catch (e) {
        if (this.context !== context) return;
        // Undo the early update and say why.
        if (edit.kind === "rename") this.moved(rel, edit.rel);
        this.setEntries(parent, before);
        this.selected = edit.kind === "rename" ? edit.rel : parent || null;
        notify({ title: edit.kind === "rename" ? `Couldn't rename ${edit.name}` : `Couldn't create ${name}`, body: String(e?.message ?? e), level: "error" });
        cx.notify();
        return;
      }
      if (this.context !== context) return;
      // A new file exists now (writeTextFile is quick): list and open it.
      if (edit.kind === "new" && !edit.dir) {
        this.setEntries(parent, [...(this.entries.get(parent) ?? []).filter(e => e.name !== name), { name, dir: false }]);
        this.open(rel, true, cx);
      }
      this.refreshAfter(cx, parent, context);
      cx.notify();
    });
  }

  // Changes a folder's listing in place, in the tree's order.
  setEntries(parent, list) {
    this.entries.set(parent, sortEntries(list));
    this.version++;
  }

  // After a change made here: git colors now. A watched tree's listing follows from the folder watch,
  // so it isn't read twice; an unwatched one (outside a repository, another machine) is read now.
  refreshAfter(cx, parent, context) {
    this.reload(cx, context.repo && !context.on && !context.poll ? [] : [parent], true);
  }

  // A rename moves everything under the old path: open tabs, expanded folders and loaded listings,
  // so a renamed folder keeps showing its contents.
  moved(from, to) {
    const map = p => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    for (const tab of this.tabs) { const next = map(tab.rel); if (next !== tab.rel) { this.drop(tab.rel); tab.rel = next; } }
    if (this.active) this.active = map(this.active);
    this.folders = new Set([...this.folders].map(map));
    this.entries = new Map([...this.entries].map(([key, list]) => [map(key), list]));
    this.version++;
  }

  askDelete(rel, dir) {
    if (!this.context || this.context.on || !rel) return;
    openDeleteDialog(this.target(rel, dir));
  }

  remove(rel, dir, cx) {
    const context = this.context, parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const name = base(rel), before = [...(this.entries.get(parent) ?? [])], gone = p => p === rel || p.startsWith(rel + "/");
    // Off the tree at once; the Recycle Bin move runs behind it.
    this.setEntries(parent, before.filter(e => e.name !== name));
    for (const tab of [...this.tabs]) if (gone(tab.rel)) this.closeTab(tab.rel, cx);
    this.folders = new Set([...this.folders].filter(f => !gone(f)));
    if (this.selected && gone(this.selected)) this.selected = parent || null;
    cx.notify();
    cx.spawn(async cx => {
      try { await ops.trash(this.join(rel, context), dir); }
      catch (e) {
        if (this.context === context) { this.setEntries(parent, before); cx.notify(); }
        notify({ title: `Couldn't delete ${name}`, body: String(e?.message ?? e), level: "error" });
        return;
      }
      if (this.context !== context) return;
      this.refreshAfter(cx, parent, context);
      cx.notify();
    });
  }

  // --- Drawing -----------------------------------------------------------------------

  // Material draws full-color images; Seti's glyphs are one-color SVGs tinted with its color for the file type.
  icon(name, dir, open, size, t) {
    const icon = this.icons ? resolveIcon(this.icons, name, dir, open, !settings().dark) : null;
    if (!icon) return null;
    return icon.image ? image(icon.image).size(size).flex_none() : svg(icon.glyph).size(size).flex_none().text_color(icon.color ?? t.muted);
  }

  row({ path, entry, depth, editing }, t, focused) {
    const naming = editing || (this.edit?.kind === "rename" && this.edit.rel === path);
    // A new entry's icon follows the name being typed.
    const shownName = editing ? this.edit.input.value() || (entry.dir ? "folder" : "file") : entry.name;
    const open = this.folders.has(path), selected = this.selected === path, icon = this.icon(shownName, entry.dir, open, 16, t);
    const mark = entry.dir ? this.folderMarks[path] : this.marks[path], ignored = !mark && this.isIgnored(path);
    const color = ignored ? t.dim : this.markColor(mark, t, t.foreground);
    // Rows are drawn during layout, where handlers throw: clicks arrive through the list's on_item_click.
    // Indent guides: one line per ancestor level, through each folder's arrow column.
    const guides = [];
    for (let level = 0; level < depth; level++) guides.push(div().absolute().top(0).bottom(0).left(4 + level * 16 + 6).w(1).bg(t.border));
    return h_flex().h(ROW).flex_none().mx(4).pl(4 + depth * 16).pr(8).gap(4).items_center().rounded(5).cursor_pointer().relative()
      .border_1().border_color(selected && focused ? t.accent : "#00000000")
      .when(selected, el => el.bg(t.selected)).hover(s => s.bg(selected ? t.selected : t.hover))
      .children(guides)
      // Folders get arrows, as in VS Code; a theme without folder icons (Seti) shows only the arrow.
      .child(entry.dir ? svg(`${MOD}/ui/chevron-${open ? "down" : "right"}.svg`).size(14).flex_none().text_color(t.muted) : div().w(14).flex_none())
      .when(Boolean(icon), el => el.child(ignored ? icon.opacity(0.5) : icon))
      .child(naming
        // The input belongs to the edit (made outside this renderer, where state can't be created).
        ? Input.new(this.edit.input).flex_1().min_w(0).h(20).px(4).rounded(3).border_1()
          .border_color(this.edit.error ? t.ansi1 : t.accent).bg(t.background).text_color(t.foreground)
        : div().flex_1().min_w(0).truncate().text_color(color).child(entry.name))
      // VS Code marks files with a letter and folders holding changes with a dot.
      .when(Boolean(mark), el => el.child(div().flex_none().text_size(11).text_color(color).child(entry.dir ? "●" : mark)));
  }

  tree(t) {
    const context = this.context, rows = context ? this.flat() : [], focused = this.h.is_focused();
    const name = context?.root.split(/[\\/]/).filter(Boolean).pop() ?? "";
    const empty = this.error || (context && !this.entries.has("") ? "Loading files…" : context ? "No files" : "No folder");
    return v_flex().id("explorer-tree-column").h_full().min_h(0).flex_none()
      .track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
      .when(this.tabs.length > 0, el => el.w(TREE_WIDTH).border_l(1).border_color(t.border)).when(!this.tabs.length, el => el.flex_1().min_w(0))
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(context && this.icon(name, true, true, 16, t)), el => el.child(this.icon(name, true, true, 16, t)))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(name || "Files"))
        .child(div().id("explorer-settings").w(24).h(24).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.openSettings()).child(svg(`${MOD}/ui/settings.svg`).size(14))))
      .when(rows.length > 0, el => el.child(div().id("explorer-tree-area").flex_1().min_h(0).relative().pt(4)
        // A right-click on a row reaches the row's handler first, then this one: only empty space means the root.
        .on_mouse_down("right", (_e, cx) => { if (Date.now() - (this.rowMenuAt ?? 0) > 100) this.contextMenu("", cx); })
        // Only the rows on screen are built, so a large repository stays smooth.
        .child(v_virtual_list("explorer-tree", rows.length, ROW, i => rows[i]?.path ?? String(i),
          range => rows.slice(range.start, range.end).map(r => this.row(r, t, focused)))
          .on_item_click((path, cx) => this.clicked(path, cx))
          .on_item_secondary_click((path, _e, cx) => { this.rowMenuAt = Date.now(); this.contextMenu(path, cx); })
          .track_scroll(this.scroll).size_full())
        .child(Scrollbar.vertical("explorer-tree").viewport_from_layout().absolute().inset_0())))
      .when(Boolean(this.edit?.error), el => el.child(div().px(12).py(6).flex_none().text_size(12).text_color(t.ansi1).border_t(1).border_color(t.border).child(this.edit.error)))
      .when(Boolean(this.error) || !rows.length, el => el.child(div().id("explorer-empty").p(12).text_size(12).text_color(t.dim)
        .on_mouse_down("right", (_e, cx) => this.contextMenu("", cx)).child(empty)))
      .when(this.limited, el => el.child(div().px(12).py(6).flex_none().text_size(11).text_color(t.dim).child(`Some folders show only their first ${PER_FOLDER} entries`)));
  }

  editor(t, cx) {
    const tabs = this.tabs.map(tab => {
      const on = tab.rel === this.active, mark = this.marks[tab.rel];
      const color = this.markColor(mark, t, on ? t.foreground : t.muted);
      return h_flex().id(`tab-${tab.rel}`).h_full().flex_none().pl(10).pr(6).gap(6).items_center().cursor_pointer()
        .border_r(1).border_color(t.border).bg(on ? t.background : t.chrome).hover(s => s.bg(on ? t.background : t.hover))
        .on_click((e, cx) => { this.active = tab.rel; if (e.click_count >= 2) tab.preview = false; cx.notify(); })
        .on_mouse_down("middle", (_e, cx) => this.closeTab(tab.rel, cx))
        .when(Boolean(this.icon(base(tab.rel), false, false, 14, t)), el => el.child(this.icon(base(tab.rel), false, false, 14, t)))
        .child(div().text_size(12).text_color(color).when(tab.preview, el => el.italic()).child(base(tab.rel)))
        .child(div().id(`close-${tab.rel}`).w(18).h(18).flex().items_center().justify_center().rounded(4).text_size(12)
          .text_color(on ? t.muted : t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.closeTab(tab.rel, cx); }).child("×"));
    });
    const active = this.active, view = active ? this.view(active, cx) : null;
    const parts = active ? active.split("/") : [];
    const crumbs = [];
    parts.forEach((part, i) => {
      if (i) crumbs.push(div().text_color(t.dim).child("›"));
      const last = i === parts.length - 1;
      crumbs.push(h_flex().gap(4).items_center()
        .when(last && Boolean(this.icon(part, false, false, 13, t)), el => el.child(this.icon(part, false, false, 13, t)))
        .child(div().text_color(last ? t.foreground : t.muted).child(part)));
    });
    const body = !view ? div()
      : view.code ? Editor.new(view.code).flex_1().min_h(0)
      : view.picture ? div().flex_1().min_h(0).p(16).flex().items_center().justify_center().child(image(view.picture).max_w_full().max_h_full())
      : div().p(16).text_color(t.dim).child(view.message ?? "Loading…");
    return v_flex().id("explorer-editor").flex_1().min_w(0).h_full().min_h(0)
      .child(h_flex().id("explorer-tabs").h(34).flex_none().bg(t.chrome).border_b(1).border_color(t.border).overflow_x_scrollbar().children(tabs))
      .child(h_flex().h(26).flex_none().px(12).gap(6).items_center().text_size(12).overflow_hidden().children(crumbs))
      .child(body);
  }

  render(cx) {
    if (this.menu) return this.renderMenu(theme());
    this.sync(cx);
    this.followTheme(cx);
    this.handleRequest(cx);
    // ctrl-shift-e shows the panel; give the tree the keyboard as it appears. The tab bar also
    // reopens it after a space switch, which must leave the keyboard in the terminal.
    const panel = findNode(layout(), "panel"), shown = Boolean(panel && !panel.hidden);
    if (shown && this.panelShown === false && Date.now() - (this.spaceChangedAt ?? 0) > 1500) this.h.focus();
    this.panelShown = shown;
    const t = theme();
    return h_flex().id("explorer").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .when(this.tabs.length > 0, el => el.child(this.editor(t, cx)))
      .child(this.tree(t));
  }
}
