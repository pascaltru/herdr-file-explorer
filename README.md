# Herdr File Explorer

An IDE-style file explorer for [Herdr](https://herdr.dev), in the right-hand panel: the space's
repository as a tree with file icons and git colors, and editor tabs beside it to read and edit files,
with find in file, search in folder and Quick Open.

![File Explorer](preview.png)

## Use

**The tree**

- Click a folder to open it; click a file for a preview tab, double-click to keep it.
  Keys: arrows, Home/End, Page Up/Down, Enter, Space, typing jumps to a name, Escape returns to the terminal.
- **Git:** VS Code's letters and colors (U, A, M, D, C); folders holding changes get a dot; ignored files are dimmed.
- **Toolbar:** the filter box (funnel) shows only the files and folders whose name contains the text, as in
  Visual Studio. Pending changes shows only changed files (it combines with the filter). Collapse closes
  every folder. In the filter box, Escape clears it and Down or Enter moves into the results. Each
  folder keeps its own filter.
- **Right-click** a file, a folder or empty space: Open, New File…, New Folder…, Copy Path,
  Copy Relative Path, Cut and Paste (Ctrl+X / Ctrl+V: moves it; outside a git repository it asks
  first), Rename… (F2), Delete (Del, to the Recycle Bin or Trash after a confirmation),
  Reveal in File Explorer, Open in Terminal, Find in Folder…. Names are edited in place, as in VS Code.
  Ctrl+Z in the tree undoes the last move or rename.
  Spaces on another machine only offer the read-only actions.
- **Drag** a file or folder onto a terminal to type its path there, for example into an agent's prompt.

**Files**

- **Editing:** type in an open file; a dot on its tab marks unsaved changes, and `ctrl+s` saves. If
  the file changes on disk meanwhile (an agent), the tab keeps your edits and offers Reload or Keep
  mine; a save never overwrites a change it didn't see. Closing a tab with unsaved changes asks: Save,
  Don't Save or Cancel. Files on another machine are read-only.
- **Right-click in a file:** Cut, Copy, Paste; Copy Reference (to the selected lines, `@path#5-10`,
  to paste in an agent's prompt), Copy Path, Copy Relative Path; Find in File, Go to Line; Save.
- **Right-click a tab:** Close, Close Others, Close to the Right, Close Saved, Close All, Copy Path,
  Copy Relative Path. Only Close asks about unsaved changes; the others leave those tabs open.
- **Go to line:** `ctrl+g` in an open file, then a line number or `line:column` and Enter.
- **Find in file:** `ctrl+f`, `F3`, or the magnifier above the file. Enter or `F3` goes to the next
  match (Shift: the previous one), and Enter keeps stepping until you click or type in the file;
  Escape closes. Only the current match is highlighted.

**Searching**

- **Search in folder:** `ctrl+shift+f` (from the explorer), or right-click a folder → Find in Folder…, or
  the Search tab at the bottom of the panel (next to Explorer). Enter searches (git grep: tracked and
  untracked files, not ignored ones). Results are grouped by file; a click opens the file at the match,
  a double click keeps its tab. Repositories only.
- **Quick Open** (`ctrl-e`): find a file of the repository by name with fuzzy matching; before typing,
  the recently opened files. Enter opens it in the panel and reveals it in the tree.

**Look**

- **Width:** the tree keeps the width you give it (at the panel's edge, or on the line between the
  editor and the tree); opening a file adds the editor beside it.
- **Syntax colors:** VS Code's Dark Modern and Light Modern palettes, or the Herdr theme's, from the gear menu.
- **Editor font:** VS Code's default (Consolas 14 on Windows, Menlo 12 on macOS), the terminal's, or any installed
  monospace font, and its size, from the gear menu. `scripts/install.ps1 -EditorFont <vscode|terminal|name> -EditorFontSize <12-16>`
  sets the default for an install (`editorFont`, `editorFontSize` in its `config.json`); VS Code's font without them.

## Install

Needs Herdr 0.1.16 or newer.

**With an agent** (Herdr's usual way): in a terminal in Herdr, ask your coding agent:

> Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/pascaltru/herdr-file-explorer

**By hand:**

1. Copy `mods/file-explorer` into `~/.config/herdr-app/mods/`. On Windows, `scripts/install.ps1` does it
   and runs `herdr-app check`. Copying by hand, copy `mod.json` first: Herdr docks a new mod folder into
   the shown layout unless its `mod.json` is already there.
2. Put it in a layout. Herdr's own layouts are read-only, so clone yours first, for example
   `herdr-app do layout.clone '{"name":"main","as":"my-main"}'`. In the clone, the right-hand panel's
   `files` block becomes `"content": { "mod": "file-explorer" }`. Any block works: the explorer finds
   its place in the layout by itself.
3. Merge `keys.json` into `~/.config/herdr-app/keys.json`:
   - `ctrl-shift-e` toggles the node `panel` (the right-hand panel of Herdr's `main` layout; use your
     node's id in another layout). It replaces Herdr's split-down binding.
   - `ctrl-e` opens Quick Open. Terminal programs use it to move to the end of the line; the End key
     does the same.

**What it runs:** `git` in the space's repository. On Windows it also runs `powershell` to list folders
git doesn't describe and for file actions (Recycle Bin, rename, reveal); on macOS and Linux it runs
`sh`, `mv`, `mkdir`, `open`/`osascript` or `gio`/`xdg-open`. It reads the repository's files to show
them, and writes only when you save, create, rename, move or delete something. No network.

### Icon themes

- `seti` (default): VS Code's default file icons; folders show arrows only.
- `material`: Material Icon Theme, with folder icons.

Switch any time from the gear (⚙) in the explorer's header. `scripts/install.ps1 -IconTheme material`
sets the default for a fresh install (`iconTheme` in the installed `mods/file-explorer/config.json`);
the menu's choice overrides it. Themes live in `mods/file-explorer/icon-themes/<name>/theme.json`.

## Develop

Edit here, then run `scripts/install.ps1` to copy the mod into the Herdr home and check it.
`python scripts/build-icon-themes.py` regenerates `icon-themes/` from upstream at the versions pinned in
`icon-themes/versions.json` (needs git and network). Pass `--material <version>` or `--vscode <tag>` to update one source.

## License

MIT (`LICENSE`). Third-party parts keep their own licenses; see `NOTICE`.

## Credits

- Started from Herdr's shipped `files` mod (Apache-2.0); folder arrows from it, toolbar icons from Lucide.
- Seti icons: [seti-ui](https://github.com/jesseweed/seti-ui) by Jesse Weed (MIT), as shipped in VS Code;
  glyphs converted to SVG. See `icon-themes/seti/LICENSE-seti.txt`.
- Material icons: [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT).
  See `icon-themes/material/LICENSE-material-icon-theme.txt`.
- Language table: [VS Code](https://github.com/microsoft/vscode) (MIT). See `icon-themes/LICENSE-vscode.txt`.
