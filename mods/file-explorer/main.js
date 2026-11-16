// An IDE-style explorer for the space's repository: editor tabs on the left, the file tree on the right.
// Derived from the Herdr app's `files` mod (Apache-2.0, see LICENSE-Herdr.txt) and modified; see NOTICE.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState, h_resizable, resizable_panel } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, fonts, window, run, appHome, nextCommand, openOverlay, shared, setShared, props, notify, checking } from "herdr";
import * as fs from "fs/promises";
import { NAME, REQUEST, renderSettings, renderContext, renderDelete, renderUnsaved, contextItems, contextHeight, openDeleteDialog, openUnsavedDialog } from "./menus.js";
import * as ops from "./ops.js";
import { QuickOpen, remember } from "./quickopen.js";
import { shownIn, sizedNode } from "./place.js";
import { GoToLine, FindBar, offsetOf, lineAt } from "./find.js";
import { FolderSearch, newSearch } from "./search.js";

const PER_FOLDER = 500, TOTAL = 5000, PREFETCH = 40, MAX_GIT_PATHS = 200000, CACHE = "cache/file-explorer";
const MOD = `mods/${NAME}`, THEMES = `${MOD}/icon-themes`, DEFAULT_THEME = "seti";
// The settings menu's choice. Shared state rather than config.json: writing a file in the mod
// folder would hot-reload the explorer and close its tabs.
const THEME_KEY = `${NAME}.iconTheme`, SYNTAX_KEY = `${NAME}.syntax`, FONT_KEY = `${NAME}.font`, SIZE_KEY = `${NAME}.fontSize`;

// VS Code's default editor.fontFamily and editor.fontSize on each platform.
const VSCODE_FONT = { windows: ["Consolas", 14], macos: ["Menlo", 12], linux: ["Droid Sans Mono", 14] };
const FONT_SIZES = [12, 13, 14, 15, 16], FONT_ROWS = 5;
const MONOSPACE = /mono|code|consol|courier|cascadia|menlo|monaco|hack|fira|iosevka|inconsolata|lucida console/i;

function vscodeFont() {
  const [family, size] = VSCODE_FONT[window()?.platform] ?? VSCODE_FONT.linux;
  // Herdr ships JetBrains Mono; Droid Sans Mono is rarely installed on Linux nowadays.
  return { family: fonts().includes(family) ? family : "JetBrains Mono", size };
}

// The install's choices (config.json), read once; the menu's override them.
let installed = {};
async function loadConfig() {
  try { installed = await readJson(`${MOD}/config.json`); } catch { installed = {}; }
}

// "vscode" (the default), "terminal" (the terminal's font), or a font name.
const fontChoice = () => shared(FONT_KEY) || installed.editorFont || "vscode";

function editorFont() {
  const choice = fontChoice(), size = [shared(SIZE_KEY), installed.editorFontSize].find(n => FONT_SIZES.includes(n)) ?? vscodeFont().size;
  // VS Code's line height (editor.lineHeight 0): the size times 1.35, or 1.5 on macOS, rounded.
  // Herdr's editor spaces lines wider, 23px rather than 19px at 14.
  const lineHeight = Math.round(size * (window()?.platform === "macos" ? 1.5 : 1.35));
  return { family: choice === "vscode" ? vscodeFont().family : choice === "terminal" ? settings().font_family : choice, size, lineHeight };
}

// The gear menu's font list: VS Code's, the terminal's, then installed monospace fonts by name.
function fontChoices() {
  const vs = vscodeFont().family, term = settings().font_family;
  const others = [...new Set(fonts().filter(f => MONOSPACE.test(f) && f !== vs && f !== term))].sort((a, b) => a.localeCompare(b));
  // Each name is drawn in its own font.
  return [{ name: "vscode", label: `${vs} (VS Code)`, family: vs }, { name: "terminal", label: "Terminal font", hint: term, family: term },
    ...others.map(f => ({ name: f, label: f, family: f }))];
}

// VS Code's Dark Modern and Light Modern token colors, for the twelve categories Herdr's editor
// knows. VS Code tells control keywords (import, return: purple) from declarations (const,
// function: blue); Herdr has one keyword category, which takes VS Code's general keyword blue.
const VSCODE_SYNTAX = {
  dark: { keyword: "#569CD6", boolean: "#569CD6", string: "#CE9178", "string.escape": "#D7BA7D", comment: "#6A9955", function: "#DCDCAA",
    type: "#4EC9B0", number: "#B5CEA8", constant: "#4FC1FF", variable: "#9CDCFE", operator: "#D4D4D4", punctuation: "#CCCCCC" },
  light: { keyword: "#0000FF", boolean: "#0000FF", string: "#A31515", "string.escape": "#EE0000", comment: "#008000", function: "#795E26",
    type: "#267F99", number: "#098658", constant: "#0070C1", variable: "#001080", operator: "#000000", punctuation: "#3B3B3B" },
};

// "vscode" (the default) or "theme": colors taken from the Herdr theme's palette.
const syntaxMode = () => (shared(SYNTAX_KEY) === "theme" ? "theme" : "vscode");

function syntaxColors(t) {
  if (syntaxMode() === "vscode") return VSCODE_SYNTAX[settings().dark === false ? "light" : "dark"];
  return { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
}
const TREE_WIDTH = 280, NARROW = 368, ROW = 24, PAGE = 10;
// The key of the row where a new file or folder is named; real paths never hold "//".
const NEW_ROW = "//new";
const CONFLICTS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]), RANK = { U: 1, A: 2, D: 3, M: 4, C: 5 };
// Herdr's editor highlights a fixed set of languages, named by extension. A language it lacks is
// shown as its nearest relative there, which colors at least comments, strings and numbers.
// Tested: TypeScript, TOML, PowerShell, Terraform, Dockerfile, Kotlin and Swift show as plain text.
const LANG = {
  ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", bicep: "js",
  toml: "yaml", jsonc: "json", json5: "json", svelte: "html", vue: "html", razor: "html", cshtml: "html",
  kt: "java", kts: "java", gradle: "java", swift: "rust",
  ps1: "sh", psm1: "sh", psd1: "sh", dockerfile: "sh", env: "sh",
  tf: "ruby", tfvars: "ruby", hcl: "ruby",
  csproj: "xml", fsproj: "xml", vbproj: "xml", props: "xml", targets: "xml", xaml: "xml", resx: "xml", config: "xml", plist: "xml",
};
// Files known by their name rather than an extension.
const LANG_BY_NAME = { dockerfile: "sh", containerfile: "sh", ".env": "sh" };
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
const KEYS = new Map();
function sortKey(e) {
  const id = (e.dir ? "0" : "1") + e.name;
  let key = KEYS.get(id);
  if (key === undefined) {
    // A tree rebuild makes new entries for the same names: compute each name's key once.
    if (KEYS.size > 200000) KEYS.clear();
    key = id[0] + e.name.toLowerCase().replace(/\d+/g, d => d.replace(/^0+/, "").padStart(12, "0"));
    KEYS.set(id, key);
  }
  return key;
}

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
    // Open files are read again once it's in, if it names another font (see render).
    cx.spawn(async cx => { await loadConfig(); cx.notify(); });
    // The same mod opened as an overlay draws only that popup (menus.js).
    const p = props();
    if (p?.menu === "settings") {
      this.menu = { kind: "settings", themes: [], current: p.theme ?? null };
      cx.spawn(async cx => { this.menu.themes = await listThemes(); this.menu.current ??= await preferredTheme(); cx.notify(); });
      return;
    }
    // Opened by mod.open (Ctrl+E) with no menu named: Quick Open.
    if (p?.overlay && !p.menu) {
      this.roots = new Map(); this.icons = null;
      cx.spawn(async cx => { this.icons = await loadIconTheme(await preferredTheme()); cx.notify(); });
      this.quick = new QuickOpen(this, cx);
      return;
    }
    if (p?.menu === "context" || p?.menu === "delete" || p?.menu === "unsaved") {
      this.menu = { kind: p.menu };
      if (p.menu !== "context") { this.menu.handle = cx.focus_handle(); this.menu.handle.focus(); }
      return;
    }
    // Requests are kept in shared state across restarts: only act on ones made from now on.
    this.lastRequest = shared(REQUEST)?.id ?? null;
    this.edit = null;
    this.saved = new Map(); this.roots = new Map(); this.context = null; this.locKey = null; this.wide = null;
    this.h = cx.focus_handle(); this.panelShown = null; this.icons = null;
    this.themeLoading = true;
    cx.spawn(async cx => { this.icons = await loadIconTheme(await preferredTheme()); this.themeLoading = false; cx.notify(); });
    this.version = 0; this.flatCache = null; this.typed = ""; this.typedAt = 0; this.terminalPane = null;
    this.reset();
    // The toolbar's filters (kept per space, see reset): a name search and changed files only.
    this.searchFocused = false;
    this.search = InputState.new({ placeholder: "Filter in explorer" });
    this.search.on("change", (_e, cx) => {
      const query = this.search.value().trim().toLowerCase();
      if (query !== this.query) { this.query = query; this.refilter(cx); }
    });
    this.search.on("focus", () => { this.searchFocused = true; });
    this.search.on("blur", () => { this.searchFocused = false; });
    this.search.on("submit", (_e, cx) => this.intoResults(cx));
    // A jump waits here until its file's editor exists (a tab opened from a search result reads first).
    this.goto = new GoToLine(this); this.findBar = new FindBar(this); this.pendingJump = null;
    // Herdr's editor binds Ctrl+F to a search it never shows, and keeps the key. The keymap is the
    // app's: a binding for an input inside this explorer's editor area, made later, wins over it.
    // Ctrl+S and, while find is stepping through matches, Enter the same way: an editable editor keeps
    // those keys too.
    if (!checking()) cx.bind_keys([
      { keystroke: "ctrl-f", action: "explorer-find", context: "ExplorerEditor > Input" },
      { keystroke: "ctrl-s", action: "explorer-save", context: "ExplorerEditor > Input" },
      { keystroke: "enter", action: "explorer-find-next", context: "FindStepping > Input" },
      { keystroke: "shift-enter", action: "explorer-find-previous", context: "FindStepping > Input" },
    ]);
    this.modPath = MOD; this.finder = new FolderSearch(this, cx);
    // Remote spaces can't be watched, and a failed watch falls back to polling.
    // Herdr keeps a hidden panel's mod running: it refreshes once shown again instead (see render).
    cx.timer.every(10000, cx => {
      const context = this.context;
      if (!context || !(context.on || context.poll)) return;
      if (shownIn()) this.reload(cx, null, true); else context.missed = true;
    });
    // pane.go (alt+arrows) hands the keyboard to this panel.
    // The copy gets "focus" when a popup over it closes: after Find in Folder…, the search box keeps it.
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") { const want = this.wantFocus; this.wantFocus = null; if (want) want(); else this.h.focus(); }
        cx.notify();
      }
    });
  }

  reset(saved) {
    this.entries = saved?.entries ?? new Map(); this.folders = saved?.folders ?? new Set(); this.marks = saved?.marks ?? {}; this.folderMarks = saved?.folderMarks ?? {}; this.ignored = saved?.ignored ?? new Set(); this.ignoredCache = new Map();
    this.ignoredEntries = saved?.ignoredEntries ?? []; this.deleted = saved?.deleted ?? new Set(); this.lazy = saved?.lazy ?? new Set();
    this.selected = saved?.selected ?? null; this.tabs = saved?.tabs ?? []; this.active = saved?.active ?? null;
    // Under a filter, folders leading to a match show open unless closed there (filterClosed); a folder
    // matching by name alone shows closed unless opened there (filterOpened). The folders open
    // without a filter stay in `folders` for when it's cleared.
    this.query = saved?.query ?? ""; this.changesOnly = saved?.changesOnly ?? false;
    this.filterClosed = saved?.filterClosed ?? new Set(); this.filterOpened = saved?.filterOpened ?? new Set(); this.startClosed = new Set();
    this.search?.set_value(saved?.searchText ?? "");
    // The search tab's query and results (search.js).
    this.folderSearch = saved?.folderSearch ?? null; this.panelView = saved?.panelView ?? "files";
    // Unsaved edits of tabs whose editor was let go (see release).
    this.drafts = saved?.drafts ?? new Map();
    this.finder?.input.set_value(this.folderSearch?.text ?? "");
    this.views = new Map(); this.changed = new Set(); this.flushing = false; this.error = null; this.cut = new Set(); this.gitLimited = false;
    this.version++;
  }

  windows(context = this.context) { return !context?.on && window()?.platform === "windows"; }

  // Where the active space's terminal is (Quick Open asks, as the explorer does).
  currentLocation() { return location(); }

  join(rel, context = this.context) {
    if (!rel) return context.root;
    return this.windows(context) ? `${context.root}\\${rel.replace(/\//g, "\\")}` : `${context.root}/${rel}`;
  }

  // --- Where the tree is -------------------------------------------------------------

  sync(cx) {
    // `herdr-app check` draws the mod for real: no git, PowerShell or folder watch for it.
    if (checking()) return;
    const loc = location(), k = JSON.stringify([loc.space, loc.on, loc.cwd]);
    this.terminalPane = loc.pane;
    if (loc.space !== this.space) { this.space = loc.space; this.spaceChangedAt = Date.now(); }
    if (k === this.locKey) return;
    this.locKey = k;
    if (!loc.cwd) { this.switchTo(null, null, false, cx); return; }
    cx.spawn(async cx => {
      // A task that ends without ever waiting (a root already resolved) gives the tasks it starts
      // a context whose cx.notify() is dropped: live refresh would stop after a space switch.
      await cx.sleep(0);
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
    // Coming back reloads in full, so the old folder's watch would only hold one of Herdr's 64 slots.
    old?.watch?.cancel();
    if (old) {
      for (const [rel, view] of this.views) this.release(view, rel);
      this.saved.set(`${old.on ?? ""}|${old.root}`, { entries: this.entries, folders: this.folders, marks: this.marks, folderMarks: this.folderMarks, ignored: this.ignored, ignoredEntries: this.ignoredEntries, deleted: this.deleted, lazy: this.lazy, selected: this.selected, tabs: this.tabs, active: this.active,
        query: this.query, searchText: this.search.value(), changesOnly: this.changesOnly, filterClosed: this.filterClosed, filterOpened: this.filterOpened,
        folderSearch: this.folderSearch, panelView: this.panelView, drafts: this.drafts });
    }
    if (!root) { this.context = null; this.reset(); this.fit(); return; }
    this.reset(this.saved.get(`${on ?? ""}|${root}`));
    // Outside a repository (a terminal in the home folder), a recursive watch would see every file on disk: poll instead.
    this.context = { root, on, repo, want: null, busy: false, poll: !repo, watched: false, watch: null };
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
          const changed = await (context.watch = watchFolder(context.root));
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
    if (!shownIn()) { context.missed = true; return; }
    const rootSlash = context.root.replace(/\\/g, "/"), windows = this.windows(context);
    const fold = s => windows ? s.toLowerCase() : s, rootKey = fold(rootSlash);
    const dirs = new Set();
    let all = false, git = false;
    for (const p of paths) {
      // Windows reports long-path forms (\\?\C:\x, \\?\UNC\server\share\x), which never match the root.
      const slash = p.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").replace(/\\/g, "/");
      if (fold(slash) === rootKey) { all = true; break; }
      if (!fold(slash).startsWith(rootKey + "/")) continue;
      const rel = slash.slice(rootSlash.length + 1);
      // A commit, a stage or a checkout changes only .git: the colors may change, not the folders shown.
      if (rel === ".git" || rel.startsWith(".git/")) { git = true; continue; }
      const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      // Inside an ignored folder (node_modules, obj, dist), git's answers can't change: a build
      // or a dev server writing there would otherwise run git every 400 ms.
      if (!this.isIgnored(parent)) git = true;
      // Re-read only folders on screen; one only read ahead is dropped and read again when needed.
      if (parent === "" || this.folders.has(parent) || this.filterOpened.has(parent)) dirs.add(parent);
      else if (this.entries.has(parent) && this.isLazy(parent)) { this.entries.delete(parent); this.version++; }
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
      // A mod's redraw repaints the whole window: only ask for one when something shown changed.
      const seen = () => [this.version, this.marks, this.error, this.gitLimited];
      let before = seen();
      const notifyIfChanged = () => { const now = seen(); if (now.some((v, i) => v !== before[i])) { before = now; cx.notify(); } };
      try {
        while (context.want && this.context === context) {
          const w = context.want; context.want = null;
          let rels = w.all ? ["", ...this.folders] : [...w.dirs].filter(d => d === "" || this.entries.has(d) || this.folders.has(d) || this.filterOpened.has(d));
          if (context.repo) {
            // git lists the whole repository in one quick call; only the folders it leaves out
            // (ignored, untracked) are read from disk, which on Windows means starting PowerShell.
            if (w.all || w.git) {
              // Both git calls at once: the tree needs the status's ignored and deleted entries.
              const [structure, list] = await Promise.all([this.status(context), this.listFiles(context)]);
              if (this.context === context) this.gitTree(context, structure, list);
            }
            rels = rels.filter(r => this.isLazy(r));
            if (rels.length && this.context === context) await this.load(rels, context);
          } else {
            if (rels.length) await this.load(rels, context);
            if (w.git && context.repo && this.context === context) await this.status(context);
          }
          if (this.context === context) this.error = null;
          notifyIfChanged();
          // Read one level ahead, so opening a folder shows its contents at once.
          if (!context.want && this.context === context) {
            const ahead = this.ahead();
            if (ahead.length) { await this.load(ahead, context); notifyIfChanged(); }
          }
        }
      } catch (e) { if (this.context === context) this.error = String(e?.message ?? e); }
      finally { context.busy = false; notifyIfChanged(); }
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
      if (list === null) {
        if (this.entries.delete(rel)) this.version++;
        if (rel) this.folders.delete(rel);
        return;
      }
      if (list.length > PER_FOLDER) this.cut.add(rel); else this.cut.delete(rel);
      const fresh = sortEntries(list.slice(0, PER_FOLDER)), old = this.entries.get(rel);
      // Polling outside a repository reads the same folders every 10 seconds: keep what didn't change.
      if (old && old.length === fresh.length && fresh.every((e, j) => e.name === old[j].name && e.dir === old[j].dir)) return;
      this.entries.set(rel, fresh);
      this.version++;
    });
  }

  // VS Code's letters: U untracked, A added, M modified, D deleted, C conflict. Folders take the
  // most important mark below them; ignored entries (--ignored=matching lists a folder once) are dimmed.
  // The repository's tree from `git ls-files`: tracked files (less those deleted on disk) and untracked
  // ones. A folder git doesn't list inside (an untracked folder, an ignored one from git status) is
  // "lazy": shown, and read from disk when opened.
  // Tracked and untracked files. Not -d (deleted on disk): it costs about half as much again on a
  // 1,300-file repository, and git status reports those files anyway.
  async listFiles(context) {
    const r = await exec("git", ["--no-optional-locks", "ls-files", "-z", "-t", "-c", "-o", "--exclude-standard", "--directory"], { cwd: context.root, on: context.on, timeout: 60000 });
    if (r.code !== 0) throw new Error(r.stderr || "git ls-files failed");
    return r.stdout;
  }

  gitTree(context, structureChanged, stdout) {
    // Most changes an agent makes edit file contents: same file list, same ignored and deleted
    // entries (from git status). Then there's nothing to rebuild, even when a file's git color changed.
    if (!structureChanged && stdout === context.treeOut) return;
    context.treeOut = stdout;
    // -t tags each path: H tracked, S not checked out (sparse), ? untracked.
    const items = stdout.split("\0"), removed = this.deleted;
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
      if (!item || item.startsWith("S ") || ++count > MAX_GIT_PATHS) continue;
      const path = item.slice(2);
      if (removed.has(path)) continue;
      if (path.endsWith("/")) { add(path.slice(0, -1), true); lazy.add(path.slice(0, -1)); }
      else add(path, false);
    }
    for (const { path, dir } of this.ignoredEntries) { add(path, dir); if (dir) lazy.add(path); }
    if (this.context !== context) return;
    const entries = new Map();
    const cut = new Set();
    for (const [folder, names] of tree) {
      // A lazy folder's contents were never listed by git: leave it for the disk.
      if (lazy.has(folder)) continue;
      const list = sortEntries([...names].map(([name, dir]) => ({ name, dir })));
      if (list.length > PER_FOLDER) cut.add(folder);
      entries.set(folder, list.slice(0, PER_FOLDER));
    }
    this.lazy = lazy;
    // Keep what was already read from disk for lazy folders (an opened node_modules).
    for (const [folder, list] of this.entries) if (!entries.has(folder) && this.isLazy(folder)) entries.set(folder, list);
    this.entries = entries;
    for (const folder of this.cut) if (entries.has(folder) && this.isLazy(folder)) cut.add(folder);
    this.cut = cut;
    this.gitLimited = count > MAX_GIT_PATHS;
    this.version++;
  }

  isLazy(rel) {
    for (let path = rel; path; path = path.slice(0, Math.max(path.lastIndexOf("/"), 0))) if (this.lazy.has(path)) return true;
    return false;
  }

  async status(context) {
    const marks = {}, folders = {}, ignored = new Set(), ignoredEntries = [], deleted = new Set();
    // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
    const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignored=matching"], { cwd: context.root, on: context.on }).catch(() => null);
    // Unchanged since last time: keep everything (and tell the tree its ignored entries are the same).
    if (r?.code === 0 && r.stdout === context.statusOut) return false;
    if (r?.code === 0) context.statusOut = r.stdout;
    // The root is the repository's top level, so git's paths are already relative to it.
    let count = 0;
    if (r?.code === 0) for (const entry of r.stdout.split("\0")) {
      if (!entry) continue;
      const xy = entry.slice(0, 2), path = entry.slice(3).replace(/\/$/, "");
      // --ignored=matching names an ignored folder once, with a trailing slash. Never capped: a big
      // untracked folder listed first would otherwise push node_modules out of the tree.
      if (xy === "!!") { ignored.add(path); ignoredEntries.push({ path, dir: entry.endsWith("/") }); continue; }
      // Deleted on disk but still in the index: ls-files lists it, the tree leaves it out.
      if (xy[1] === "D") deleted.add(path);
      if (++count > MAX_GIT_PATHS) continue;
      const mark = CONFLICTS.has(xy) ? "C" : xy === "??" ? "U" : xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
      marks[path] = mark;
      for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
        const folder = path.slice(0, i);
        if (RANK[mark] > (RANK[folders[folder]] ?? 0)) folders[folder] = mark;
      }
    }
    // What the tree is built from (the ignored and deleted entries); the marks only change colors.
    const structure = JSON.stringify([ignoredEntries, [...deleted]]), structureChanged = structure !== context.structure;
    context.structure = structure;
    if (this.context === context) { this.marks = marks; this.folderMarks = folders; this.ignored = ignored; this.ignoredEntries = ignoredEntries; this.deleted = deleted; this.ignoredCache = new Map(); }
    return structureChanged;
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

  filtering() { return Boolean(this.query) || this.changesOnly; }

  isOpen(path) {
    if (!this.filtering()) return this.folders.has(path);
    return this.startClosed.has(path) ? this.filterOpened.has(path) : !this.filterClosed.has(path);
  }

  refilter(cx) {
    this.filterClosed.clear(); this.filterOpened.clear();
    this.scrollTop = 0;
    this.version++;
    cx.notify();
  }

  clearFilter() {
    this.query = ""; this.changesOnly = false; this.filterClosed.clear(); this.filterOpened.clear();
    this.search.set_value("");
    this.version++;
  }

  toggleChanges(cx) {
    this.changesOnly = !this.changesOnly;
    this.refilter(cx);
  }

  collapseAll(cx) {
    if (this.filtering()) { for (const r of this.flat()) if (r.entry.dir) this.filterClosed.add(r.path); this.filterOpened.clear(); }
    else this.folders.clear();
    this.scrollTop = 0;
    this.version++;
    cx.notify();
  }

  // Enter or Down in the search box: the keyboard goes to the tree, on the first match.
  intoResults(cx) {
    const rows = this.flat(), i = rows.findIndex(r => r.match);
    this.h.focus();
    if (i !== -1) this.select(rows, i);
    cx.notify();
  }

  toggle(path, cx) {
    if (this.filtering()) {
      if (this.startClosed.has(path)) {
        if (this.filterOpened.has(path)) this.filterOpened.delete(path);
        else {
          this.filterOpened.add(path);
          // An untracked or ignored folder's contents come from disk.
          if (!this.entries.has(path)) this.reload(cx, [path], false);
        }
      } else if (this.filterClosed.has(path)) this.filterClosed.delete(path); else this.filterClosed.add(path);
      this.selected = path;
      this.version++;
      cx.notify();
      return;
    }
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
    // Under a filter, as in Visual Studio: the files and folders matching by name, and the folders
    // leading to them. A folder matching only by its own name starts closed; opened, it shows all it
    // holds. Only folders already read count: an unopened untracked or ignored folder isn't searched.
    let shown = null, matched = null;
    if (this.filtering()) {
      shown = new Set(); matched = new Set(); this.startClosed = new Set();
      const matches = (path, entry) => (!this.query || entry.name.toLowerCase().includes(this.query))
        && (!this.changesOnly || Boolean(entry.dir ? this.folderMarks[path] : this.marks[path]));
      const find = (prefix, depth) => {
        let any = false;
        for (const entry of this.entries.get(prefix) ?? []) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          const self = matches(path, entry), below = entry.dir && depth < 40 && find(path, depth + 1);
          if (self) matched.add(path);
          if (self && entry.dir && !below) this.startClosed.add(path);
          if (self || below) { shown.add(path); any = true; }
        }
        return any;
      };
      find("", 0);
    }
    const rows = [], walk = (prefix, depth, inside) => {
      // A new file or folder is named in a row at the top of its folder, as in VS Code.
      if (this.edit?.kind === "new" && this.edit.parent === prefix) rows.push({ path: `${prefix}${NEW_ROW}`, entry: { name: "", dir: this.edit.dir }, depth, parent: prefix, editing: true });
      for (const entry of this.entries.get(prefix) ?? []) {
        if (rows.length >= TOTAL || depth > 40) return;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (shown && !inside && !shown.has(path)) continue;
        if (inside && entry.dir) this.startClosed.add(path);
        rows.push({ path, entry, depth, parent: prefix, match: matched?.has(path) });
        if (entry.dir && this.isOpen(path)) walk(path, depth + 1, inside || this.startClosed.has(path));
      }
    };
    walk("", 0);
    this.flatCache = { version: this.version, rows };
    return rows;
  }

  clicked(path, cx, double) {
    const row = this.flat().find(r => r.path === path);
    if (!row || row.editing || (this.edit?.kind === "rename" && this.edit.rel === path)) return;
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
    this.ensureVisible(i);
  }

  key(e, cx) {
    // While naming, keys belong to the input; Escape cancels, Enter arrives as its submit.
    if (this.edit) {
      if (e.key === "escape") { this.endEdit(cx); cx.stop_propagation(); }
      return;
    }
    // The search box sits inside the tree's column: its typing isn't for the tree's keys.
    if (this.searchFocused) {
      if (e.key === "escape") { this.clearFilter(); this.h.focus(); cx.stop_propagation(); cx.notify(); }
      else if (e.key === "down") { this.intoResults(cx); cx.stop_propagation(); }
      return;
    }
    if (this.editorKey(e, cx)) return;
    if (this.panelView === "search") { if (this.finder.key(e, cx)) { cx.stop_propagation(); cx.notify(); } return; }
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
        if (row?.entry.dir) { if (!this.isOpen(row.path)) this.toggle(row.path, cx); else this.select(this.flat(), i + 1); }
        break;
      case "left":
        if (row?.entry.dir && this.isOpen(row.path)) this.toggle(row.path, cx);
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

  // Keys for the open file, from the tree or the editor area (Ctrl+F from the text comes as an action).
  editorKey(e, cx, fromEditor = false) {
    const m = e.modifiers;
    // A read-only file with the find bar open (after Enter): Enter keeps stepping, and typing goes to
    // the box. An editable file keeps its letters and Enter; its stepping Enter is a binding.
    const view = this.active ? this.views.get(this.active) : null;
    if (fromEditor && this.findBar.open && !this.findBar.boxFocused && view?.code && !view.editable) {
      if (e.key === "enter" && !m.control && !m.alt) { this.findBar.step(m.shift ? -1 : 1, cx); cx.stop_propagation(); return true; }
      if (this.findBar.typeIntoBox(e, cx)) { cx.stop_propagation(); return true; }
    }
    if (e.key === "g" && m.control && !m.shift && !m.alt && this.showGoTo(cx)) { cx.stop_propagation(); return true; }
    if (e.key === "f" && m.control && m.shift && !m.alt && this.context) { this.openSearch(null, cx); cx.stop_propagation(); return true; }
    if (e.key === "f3" && !m.control && !m.alt) {
      if (this.findBar.open && this.activeCode()) this.findBar.step(m.shift ? -1 : 1, cx);
      else if (!this.showFind(cx)) return false;
      cx.stop_propagation();
      return true;
    }
    if (e.key === "f" && m.control && !m.shift && !m.alt && this.showFind(cx)) { cx.stop_propagation(); return true; }
    if (e.key === "s" && m.control && !m.shift && !m.alt && this.activeCode()) {
      const rel = this.active;
      cx.spawn(async cx => { await this.save(rel, cx); });
      cx.stop_propagation();
      return true;
    }
    if (e.key === "escape" && (this.goto.open || this.findBar.open)) {
      if (this.goto.open) this.goto.hide(cx); else this.findBar.hide(cx);
      this.activeCode()?.focus();
      cx.stop_propagation();
      return true;
    }
    return false;
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
    if (this.context) remember(this.context.root, rel);
    this.fit();
    cx.notify();
  }

  // Selects `length` characters at a 1-based line and column of a file tab, and gives the editor the
  // keyboard: only then is a selection drawn.
  jumpTo(rel, line, col, length, cx) {
    this.pendingJump = { rel, line, col, length };
    cx.spawn(async cx => { await this.applyJump(rel, cx); });
  }

  async applyJump(rel, cx) {
    const jump = this.pendingJump, code = this.views.get(rel)?.code;
    if (!jump || jump.rel !== rel || !code) return;
    this.pendingJump = null;
    const start = offsetOf(code.value(), jump.line, jump.col);
    await this.revealRange(code, start, start + jump.length, true, cx);
  }

  activeCode() { return this.active ? this.views.get(this.active)?.code ?? null : null; }

  // From an event: the selection needs frames to come, so it runs in a task.
  showRange(code, start, end, focus, cx) {
    cx.spawn(async cx => { await this.revealRange(code, start, end, focus, cx); });
  }

  // Selects [start, end) in the middle of the editor. It scrolls only as far as a selection needs,
  // leaving it at an edge, and only for the last one of a frame: selecting half a screen below,
  // then above, frame by frame, first puts the target in the middle, as VS Code does. A newer call
  // (F3 held down) takes over.
  async revealRange(code, start, end, focus, cx) {
    const seq = this.revealSeq = (this.revealSeq ?? 0) + 1;
    this.revealing = true;
    const text = code.value(), line = lineAt(text, start);
    const half = Math.floor(((this.editorHeight ?? 600) - 60) / editorFont().lineHeight / 2);
    for (const l of [line + half, Math.max(1, line - half)]) {
      const at = offsetOf(text, l, 1);
      code.set_selected_range({ start: at, end: at });
      cx.notify();
      await cx.sleep(20);
      if (seq !== this.revealSeq) return;
    }
    this.revealing = false;
    code.set_selected_range({ start, end });
    if (focus) code.focus();
    cx.notify();
  }

  conflictBar(rel, t) {
    const button = (id, label, click) => div().id(id).h(22).px(8).flex().items_center().rounded(4).cursor_pointer()
      .border_1().border_color(t.border).hover(s => s.bg(t.hover)).on_click((_e, cx) => click(cx)).child(label);
    return h_flex().id("explorer-conflict").h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .bg(t.chrome).text_size(12)
      .child(div().flex_1().min_w(0).truncate().text_color(t.ansi3).child("This file changed on disk since you started editing."))
      .child(button("conflict-reload", "Reload", cx => this.reloadFile(rel, cx)))
      .child(button("conflict-keep", "Keep mine", cx => cx.spawn(async cx => { await this.save(rel, cx, true); })));
  }

  // Ctrl+G: the active tab's text must be there to count its lines.
  showGoTo(cx) {
    const code = this.activeCode();
    if (!code) return false;
    this.findBar.open = false;
    this.goto.show(code, cx);
    return true;
  }

  // F3, Ctrl+F or the magnifier.
  showFind(cx) {
    if (!this.activeCode()) return false;
    this.goto.open = false;
    return this.findBar.show(cx);
  }

  // Quick Open's choice: open the folders down to the file, select it, scroll to it, open it.
  reveal(rel, cx) {
    const parents = [];
    for (let i = rel.indexOf("/"); i !== -1; i = rel.indexOf("/", i + 1)) parents.push(rel.slice(0, i));
    if (this.filtering()) {
      for (const f of parents) { this.filterClosed.delete(f); this.filterOpened.add(f); }
      this.version++;
      if (!this.flat().some(r => r.path === rel)) this.clearFilter();
    }
    const closed = parents.filter(f => !this.folders.has(f));
    for (const f of closed) this.folders.add(f);
    // Folders git doesn't list inside are read from disk; the rest are already known.
    if (closed.length) this.reload(cx, closed, false);
    this.version++;
    this.open(rel, true, cx);
    const i = this.flat().findIndex(r => r.path === rel);
    if (i !== -1) this.ensureVisible(i);
    this.h.focus();
  }

  // `force`: without asking about unsaved edits (Don't Save, or after saving them).
  closeTab(rel, cx, force = false) {
    const i = this.tabs.findIndex(t => t.rel === rel);
    if (i === -1) return;
    if (!force && (this.views.get(rel)?.dirty || this.drafts.has(rel))) {
      openUnsavedDialog({ rel, dir: false, root: this.context?.root });
      return;
    }
    this.tabs.splice(i, 1);
    this.drop(rel, true);
    if (this.active === rel) this.active = this.tabs[Math.min(i, this.tabs.length - 1)]?.rel ?? null;
    this.fit();
    cx.notify();
  }

  hasTabs() { return this.tabs.length > 0; }

  // Ctrl+Shift+F, or Find in Folder… (`scope`: a folder, "" for all; null keeps the last one).
  openSearch(scope, cx) {
    if (!this.context) return;
    const s = this.folderSearch ??= newSearch(scope ?? "");
    if (scope !== null && scope !== s.scope) { s.scope = scope; s.version++; }
    // A word selected in the open file is what you're looking for, as in VS Code.
    const code = this.active ? this.views.get(this.active)?.code : null;
    const range = code?.selected_range(), picked = range && range.end > range.start ? code.value().slice(range.start, range.end) : "";
    if (picked && !picked.includes("\n") && picked.length <= 200) s.text = picked;
    this.finder.input.set_value(s.text);
    this.panelView = "search";
    this.finder.focusInput();
    // The box is drawn after this: ask again once it's there.
    cx.timer.after(50, () => this.finder.focusInput());
    cx.notify();
  }

  // Clear: the Search tab goes dim again, and the view stays, empty, for a new query.
  closeSearch(cx) {
    this.folderSearch = newSearch();
    this.finder.input.set_value("");
    this.finder.focusInput();
    cx.notify();
  }

  // The panel's bottom tabs: the tree ("files") or search in folder ("search").
  showPanelView(view, cx) {
    this.panelView = view;
    if (view === "search") this.openSearch(null, cx);
    else { this.h.focus(); cx.notify(); }
  }

  // The panel is as wide as an editor while files are open, and as narrow as a tree otherwise.
  fit() {
    const wide = this.hasTabs(), node = sizedNode();
    if (wide === this.wide || !node) return;
    this.wide = wide;
    run("layout.resize", wide ? { id: node.id, weight: 1.2 } : { id: node.id, px: NARROW });
  }

  // --- File views --------------------------------------------------------------------

  // A view with unsaved edits leaves its text behind as a draft, which the next view of the file
  // starts from: switching space, a new font or colors, or a catch-up recreate views.
  release(view, rel) {
    if (rel && view.code && view.dirty) this.drafts.set(rel, { text: view.code.value(), base: view.base, crlf: view.crlf });
    view.code?.release();
    if (view.picture) fs.unlink(`${appHome()}/${view.picture}`).catch(() => {});
  }

  // `discard`: unsaved edits go too (Reload, or closing the tab).
  drop(rel, discard = false) {
    const view = this.views.get(rel);
    if (view) { this.release(view, discard ? null : rel); this.views.delete(rel); }
    if (discard) this.drafts.delete(rel);
  }

  // The file changed on disk. A tab without unsaved edits reloads; one with edits keeps them and
  // shows the "changed on disk" bar; one whose text is already what's on disk (our own save) is
  // left alone, cursor and all.
  stale(rel, cx) {
    const view = this.views.get(rel);
    if (!view?.code) { this.drop(rel); if (this.active === rel) cx.notify(); return; }
    const context = this.context;
    cx.spawn(async cx => {
      const disk = await readTextFile(this.join(rel, context), { on: context.on }).catch(() => null);
      if (this.context !== context || this.views.get(rel) !== view) return;
      if (disk === view.base) return;
      if (view.dirty) view.conflict = true;
      else this.drop(rel);
      cx.notify();
    });
  }

  // Unsaved edits: the text compared with what was read or last saved, line endings as the file has them.
  edited(rel, view, cx) {
    const dirty = this.fileText(view) !== view.base;
    if (dirty === view.dirty) return;
    view.dirty = dirty;
    // Editing keeps a preview tab, as in VS Code.
    if (dirty) { const tab = this.tabs.find(t => t.rel === rel); if (tab) tab.preview = false; }
    cx.notify();
  }

  // What saving writes: the editor's text, with new lines in the file's own line endings.
  fileText(view) {
    const text = view.code.value();
    return view.crlf ? text.replace(/\r?\n/g, "\r\n") : text;
  }

  // Ctrl+S. Herdr writes only if the file still holds what the tab started from (`expected`), so an
  // agent's change in between isn't overwritten: the "changed on disk" bar shows instead. `force`
  // (Keep mine) writes over the file as it is now.
  async save(rel, cx, force = false) {
    const view = this.views.get(rel), context = this.context, draft = this.drafts.get(rel);
    // A tab not shown since a space switch holds its edits as a draft, with no editor.
    if (!view?.code && draft && !context.on) {
      const text = draft.crlf ? draft.text.replace(/\r?\n/g, "\r\n") : draft.text;
      try { await writeTextFile(this.join(rel, context), text, draft.base); this.drafts.delete(rel); } catch {}
      cx.notify();
      return;
    }
    if (!view?.code || !view.editable || (!view.dirty && !force)) return;
    const path = this.join(rel, context), text = this.fileText(view);
    try {
      const expected = force ? await readTextFile(path) : view.base;
      await writeTextFile(path, text, expected);
      if (this.views.get(rel) !== view) return;
      view.base = text; view.conflict = false;
      this.edited(rel, view, cx);
    } catch (e) {
      if (this.views.get(rel) !== view) return;
      // Most often a stale snapshot: the file changed since it was read.
      view.conflict = true;
    }
    cx.notify();
  }

  // The "changed on disk" bar's Reload: the file as it is now, unsaved edits dropped.
  reloadFile(rel, cx) {
    this.drop(rel, true);
    cx.notify();
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
        const draft = this.drafts.get(rel);
        if (text === null && !draft) { view.message = "This file no longer exists"; return; }
        if (text?.includes("\0")) { view.message = "Binary file: no preview"; return; }
        const t = theme();
        const language = LANG_BY_NAME[base(rel).toLowerCase()] ?? LANG[ext] ?? (ext || "txt");
        const font = editorFont();
        // Herdr writes only local files: another machine's files stay read-only.
        view.editable = !context.on;
        view.base = draft ? draft.base : text;
        view.crlf = draft ? draft.crlf : text.includes("\r\n");
        view.code = EditorState.new({ language, readonly: !view.editable, value: draft ? draft.text : text,
          font_family: font.family, font_size: font.size,
          syntax: syntaxColors(t) });
        this.drafts.delete(rel);
        view.dirty = Boolean(draft);
        // The file changed while the edits waited as a draft.
        view.conflict = Boolean(draft) && text !== draft.base;
        view.code.on("change", (_e, cx) => {
          if (this.views.get(rel) !== view) return;
          this.findBar.stepping = false;
          this.edited(rel, view, cx);
        });
        cx.notify();
        await this.applyJump(rel, cx);
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
    // Sized for two icon themes; the font list scrolls past FONT_ROWS.
    const height = 296 +Math.min(fontChoices().length, FONT_ROWS) * 30;
    openOverlay({ mod: NAME, kind: "popup", width: 280, height, props: { menu: "settings", theme: this.icons?.name ?? null } });
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
    if (this.menu.kind === "unsaved") return renderUnsaved(props(), t, this.menu.handle);
    return renderSettings(this.menu, t, {
      onTheme: name => setShared(THEME_KEY, name),
      syntax: syntaxMode(), onSyntax: mode => setShared(SYNTAX_KEY, mode),
      font: fontChoice(), fonts: fontChoices(), fontRows: FONT_ROWS, onFont: name => setShared(FONT_KEY, name),
      size: editorFont().size, sizes: FONT_SIZES, onSize: size => setShared(SIZE_KEY, size),
    });
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
    // Quick Open can show the panel and ask at once: give the tree a few seconds to find its folder.
    const fresh = Date.now() - (r.at ?? 0) < 5000;
    if ((!this.context || r.root !== this.context.root) && fresh) return;
    this.lastRequest = r.id;
    if (!this.context || r.root !== this.context.root) return;
    // Another machine's space only reads: no file changes there.
    if (this.context.on && !["open", "reveal", "find-in-folder"].includes(r.action)) return;
    // Rendering is no place to change state: act right after. A timer rather than cx.spawn: the
    // edit schedules its own timer, which a finished task's context drops.
    cx.timer.after(0, cx => {
      if (r.action === "open") this.open(r.rel, true, cx);
      else if (r.action === "reveal") this.reveal(r.rel, cx);
      else if (r.action === "rename") this.startRename(r.rel, cx);
      else if (r.action === "new-file" || r.action === "new-folder") this.startNew(r.folder ?? "", r.action === "new-folder", cx);
      else if (r.action === "delete") this.remove(r.rel, r.dir, cx);
      else if (r.action === "close-discard") this.closeTab(r.rel, cx, true);
      else if (r.action === "close-save") {
        const rel = r.rel;
        cx.spawn(async cx => {
          await this.save(rel, cx);
          // A refused save (changed on disk) keeps the tab, with its bar.
          if (!this.views.get(rel)?.dirty && !this.drafts.has(rel)) this.closeTab(rel, cx, true);
        });
      }
      else if (r.action === "find-in-folder") {
        this.openSearch(r.folder ?? "", cx);
        // The closing menu hands the copy "focus" afterwards: keep it in the search box.
        this.wantFocus = () => this.finder.focusInput();
      }
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
    this.drafts = new Map([...this.drafts].map(([rel, draft]) => [map(rel), draft]));
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

  row({ path, entry, depth, editing }, t, focused, hovered) {
    const naming = editing || (this.edit?.kind === "rename" && this.edit.rel === path);
    // A new entry's icon follows the name being typed.
    const shownName = editing ? this.edit.input.value() || (entry.dir ? "folder" : "file") : entry.name;
    const open = this.isOpen(path), selected = this.selected === path, icon = this.icon(shownName, entry.dir, open, 16, t);
    const mark = entry.dir ? this.folderMarks[path] : this.marks[path], ignored = !mark && this.isIgnored(path);
    const color = ignored ? t.dim : this.markColor(mark, t, t.foreground);
    // Indent guides: one line per ancestor level, through each folder's arrow column.
    const guides = [];
    for (let level = 0; level < depth; level++) guides.push(div().absolute().top(0).bottom(0).left(4 + level * 16 + 6).w(1).bg(t.border));
    return h_flex().id(`row-${path}`).h(ROW).flex_none().mx(4).pl(4 + depth * 16).pr(8).gap(4).items_center().rounded(5).cursor_pointer().relative()
      .border_1().border_color(selected && focused ? t.accent : "#00000000")
      // The hover highlight comes from the pointer's position (see pointerMoved), not GPUI's hover.
      .when(selected, el => el.bg(t.selected)).when(hovered && !selected, el => el.bg(t.hover))
      .on_click((e, cx) => this.clicked(path, cx, e.click_count >= 2))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.contextMenu(path, cx); })
      // Dropped on a terminal, Herdr types the quoted path there (into an agent's prompt, say).
      .when(!naming && !this.deleted.has(path), el => el.drag_paths([this.join(path)], { on: this.context.on }))
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

  // --- The list -------------------------------------------------------------------------
  // Herdr's virtual list can't give rows handlers of their own, and its rows can keep a hover
  // highlight after the pointer has gone (Herdr drops some leave events). This list draws only the
  // rows in view, in render, and lights the row under the pointer from the pointer's position.

  zoom() { return Number(settings()?.zoom) || 1; }

  maxScroll(count) { return Math.max(0, count * ROW - (this.listHeight ?? 0)); }

  ensureVisible(i) {
    const h = this.listHeight, top = this.scrollTop ?? 0;
    if (!h) return;
    if (i * ROW < top) this.scrollTop = i * ROW;
    else if ((i + 1) * ROW > top + h) this.scrollTop = (i + 1) * ROW - h;
  }

  hoveredRow() {
    return this.pointerY === undefined ? -1 : Math.floor((this.pointerY + (this.scrollTop ?? 0)) / ROW);
  }

  pointerMoved(e, cx) {
    this.pointerBounds = e.bounds;
    const before = this.hoveredRow();
    this.pointerY = e.local_position.y / this.zoom();
    if (this.hoveredRow() !== before) cx.notify();
    if (this.hoverWatch) return;
    // A missed leave event would keep a row lit: while the pointer is over the list, check it's still there.
    this.hoverWatch = cx.timer.every(120, cx => {
      const p = globalThis.window?.mouse_position?.(), b = this.pointerBounds;
      if (p && b && p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) return;
      this.pointerLeft(cx);
    });
  }

  pointerLeft(cx) {
    this.hoverWatch?.cancel();
    this.hoverWatch = null;
    if (this.pointerY === undefined) return;
    this.pointerY = undefined;
    cx.notify();
  }

  list(rows, t, focused) {
    const count = rows.length, h = this.listHeight, max = this.maxScroll(count);
    const top = (this.scrollTop = Math.max(0, Math.min(this.scrollTop ?? 0, max)));
    // Until the list is measured, draw a tall screen's worth.
    const first = Math.floor(top / ROW), end = Math.min(count, Math.ceil((top + (h ?? 2000)) / ROW) + 1);
    const hovered = this.hoveredRow(), drawn = [];
    for (let i = first; i < end; i++) drawn.push(this.row(rows[i], t, focused, i === hovered).absolute().left(0).right(0).top(i * ROW - top));
    const thumb = h && max > 0 ? Math.max(24, (h * h) / (count * ROW)) : 0;
    return div().id("explorer-list").flex_1().min_h(0).relative().overflow_hidden()
      .on_size_change((size, cx) => { const height = size.height / this.zoom(); if (height !== this.listHeight) { this.listHeight = height; cx.notify(); } })
      .on_mouse_move((e, cx) => this.pointerMoved(e, cx))
      .on_hover((on, cx) => { if (!on) this.pointerLeft(cx); })
      // From the scroll as it is now: a trackpad sends several events between two renders.
      .on_scroll_wheel((e, cx) => {
        cx.stop_propagation();
        const next = Math.max(0, Math.min((this.scrollTop ?? 0) - e.delta.y / this.zoom(), this.maxScroll(count)));
        if (next !== this.scrollTop) { this.scrollTop = next; cx.notify(); }
      })
      // Rows stop their own right-click: one reaching here was on empty space, meaning the root.
      .on_mouse_down("right", (_e, cx) => this.contextMenu("", cx))
      .children(drawn)
      .when(thumb > 0, el => el.child(div().absolute().right(2).w(6).rounded(3).bg(t.border).h(thumb).top((top / max) * (h - thumb))));
  }

  tree(t) {
    const context = this.context, rows = context ? this.flat() : [], focused = this.h.is_focused();
    const name = context?.root.split(/[\\/]/).filter(Boolean).pop() ?? "";
    const empty = this.error || (context && !this.entries.has("") ? "Loading files…"
      : context && this.filtering() ? (this.changesOnly && !this.query ? "No changes" : "No matching files")
      : context ? "No files" : "No folder");
    const button = (id, icon, tip, on, click) => div().id(id).w(26).h(26).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, el => el.bg(t.selected)).hover(s => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
      .tooltip(tip).on_click((_e, cx) => click(cx)).child(svg(`${MOD}/ui/${icon}.svg`).size(15));
    const toolbar = h_flex().h(38).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border)
      .child(h_flex().id("explorer-search").flex_1().min_w(0).h(26).px(6).gap(6).items_center().rounded(5).border_1()
        .border_color(this.searchFocused ? t.accent : t.border).bg(t.background)
        .child(svg(`${MOD}/ui/funnel.svg`).size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.search).flex_1().min_w(0).h_full().text_color(t.foreground))
        .when(Boolean(this.query), el => el.child(div().id("explorer-search-clear").w(18).h(18).flex_none().flex().items_center().justify_center().rounded(3)
          .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.query = ""; this.search.set_value(""); this.refilter(cx); }).child(svg(`${MOD}/ui/x.svg`).size(12)))))
      .child(button("explorer-changes", "file-diff", "Pending changes", this.changesOnly, cx => this.toggleChanges(cx)))
      .child(button("explorer-collapse", "copy-minus", "Collapse folders", false, cx => this.collapseAll(cx)));
    // Only about what's on screen: Material's 1,000-icon folder, read ahead but closed, is no news.
    const limit = this.gitLimited ? `Large repository: only its first ${MAX_GIT_PATHS.toLocaleString()} files are shown`
      : [...this.cut].some(f => f === "" || this.folders.has(f)) ? `Some open folders show only their first ${PER_FOLDER} entries` : null;
    const searching = this.panelView === "search" && Boolean(context && this.folderSearch);
    // Visual Studio's tool window tabs: the shown one hangs from the panel, open at the top and
    // outlined below; Search is dim until a search has run. The strip's top line is drawn piece by
    // piece around it, since a border paints over what's inside it.
    const line = el => el.h_full().border_t(1).border_color(t.border);
    // The panel's own edges are the first tab's left and every tab's bottom: no second line there.
    const bottomTab = (id, label, on, lit, view, first) => div().id(id).px(16).flex().items_center().cursor_pointer().text_size(12)
      .when(on, el => el.h_full().bg(t.background).border_r(1).when(!first, el => el.border_l(1)).border_color(t.border))
      .when(!on, el => el.h_full().border_t(1).border_color(t.border))
      .text_color(on ? t.foreground : lit ? t.muted : t.dim).hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => this.showPanelView(view, cx)).child(label);
    const files = v_flex().flex_1().min_h(0)
      .when(Boolean(context), el => el.child(toolbar))
      .when(rows.length > 0, el => el.child(this.list(rows, t, focused)))
      .when(Boolean(this.edit?.error), el => el.child(div().px(12).py(6).flex_none().text_size(12).text_color(t.ansi1).border_t(1).border_color(t.border).child(this.edit.error)))
      .when(Boolean(this.error) || !rows.length, el => el.child(div().id("explorer-empty").flex_1().p(12).text_size(12).text_color(t.dim)
        .on_mouse_down("right", (_e, cx) => this.contextMenu("", cx)).child(empty)))
      .when(Boolean(limit), el => el.child(div().px(12).py(6).flex_none().text_size(11).text_color(t.dim).child(limit)));
    return v_flex().id("explorer-tree-column").size_full().min_h(0).min_w(0)
      .track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
      .when(this.hasTabs(), el => el.border_l(1).border_color(t.border))
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(context && this.icon(name, true, true, 16, t)), el => el.child(this.icon(name, true, true, 16, t)))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(name || "Files"))
        .child(div().id("explorer-settings").w(24).h(24).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.openSettings()).child(svg(`${MOD}/ui/settings.svg`).size(14))))
      .child(searching ? this.finder.render(t, editorFont()) : files)
      .when(Boolean(context), el => el.child(h_flex().h(30).flex_none().items_start().bg(t.chrome)
        .child(bottomTab("explorer-view-files", "Explorer", !searching, true, "files", true))
        .child(bottomTab("explorer-view-search", "Search", searching, Boolean(this.folderSearch?.ran), "search", false))
        .child(line(div().flex_1()))));
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
          .on_click((_e, cx) => { cx.stop_propagation(); this.closeTab(tab.rel, cx); })
          .child(this.views.get(tab.rel)?.dirty || this.drafts.has(tab.rel) ? "●" : "×"));
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
      : view.code ? Editor.new(view.code).flex_1().min_h(0).line_height(`${editorFont().lineHeight}px`)
      : view.picture ? div().flex_1().min_h(0).p(16).flex().items_center().justify_center().child(image(view.picture).max_w_full().max_h_full())
      : div().p(16).text_color(t.dim).child(view.message ?? "Loading…");
    return v_flex().id("explorer-editor").flex_1().min_w(0).h_full().min_h(0)
      .key_context(this.findBar.open && this.findBar.stepping ? "ExplorerEditor FindStepping" : "ExplorerEditor")
      .on_action("explorer-find", (_e, cx) => this.showFind(cx))
      .on_action("explorer-save", (_e, cx) => { const rel = this.active; if (rel) cx.spawn(async cx => { await this.save(rel, cx); }); })
      .on_action("explorer-find-next", (_e, cx) => this.findBar.step(1, cx))
      .on_action("explorer-find-previous", (_e, cx) => this.findBar.step(-1, cx))
      // A click in the text ends find's stepping: Enter is a new line again.
      .on_mouse_down("left", () => { this.findBar.stepping = false; })
      .on_key_down((e, cx) => this.editorKey(e, cx, true))
      .on_size_change(size => { this.editorHeight = size.height / this.zoom(); })
      .child(h_flex().id("explorer-tabs").h(34).flex_none().bg(t.chrome).border_b(1).border_color(t.border).overflow_x_scrollbar().children(tabs))
      .child(h_flex().h(26).flex_none().pl(12).pr(6).gap(6).items_center().text_size(12).overflow_hidden().children(crumbs)
        .when(Boolean(view?.code), el => el.child(div().flex_1()).child(div().id("explorer-find-open").w(22).h(22).flex_none().flex().items_center()
          .justify_center().rounded(4).cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Find in file (Ctrl+F)").on_click((_e, cx) => this.showFind(cx)).child(svg(`${MOD}/ui/search.svg`).size(13)))))
      .when(this.goto.open && Boolean(view?.code), el => el.child(this.goto.render(t)))
      .when(this.findBar.open && Boolean(view?.code), el => el.child(this.findBar.render(t)))
      .when(Boolean(view?.conflict), el => el.child(this.conflictBar(active, t)))
      .child(body);
  }

  render(cx) {
    if (this.quick) return this.quick.render(theme());
    if (this.menu) return this.renderMenu(theme());
    this.sync(cx);
    this.followTheme(cx);
    // Open files are colored when they're read: a new syntax choice, font or appearance reads them again.
    const font = editorFont(), syntax = `${syntaxMode()}-${settings().dark}-${font.family}-${font.size}`;
    if (this.syntaxSeen !== undefined && syntax !== this.syntaxSeen) for (const tab of this.tabs) this.drop(tab.rel);
    this.syntaxSeen = syntax;
    this.handleRequest(cx);
    // Changes seen or polls skipped while hidden: catch up now that it's drawn.
    if (this.context?.missed && shownIn()) {
      this.context.missed = false;
      this.reload(cx, null, true);
      for (const tab of this.tabs) this.drop(tab.rel);
    }
    // ctrl-shift-e shows the panel; give the tree the keyboard as it appears. The tab bar also
    // reopens it after a space switch, which must leave the keyboard in the terminal.
    const shown = shownIn();
    if (shown && this.panelShown === false && Date.now() - (this.spaceChangedAt ?? 0) > 1500) this.h.focus();
    this.panelShown = shown;
    const t = theme();
    return h_flex().id("explorer").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      // With files open, the line between the editor and the panel drags; Herdr keeps where it's left.
      .child(this.hasTabs()
        ? h_resizable("explorer-split").size_full()
          .child(resizable_panel().child(this.editor(t, cx)))
          .child(resizable_panel().size(TREE_WIDTH).size_range(200, 1200).child(this.tree(t)))
        : this.tree(t));
  }
}
