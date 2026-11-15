# Herdr File Explorer

An IDE-style file explorer for [Herdr](https://herdr.dev): the space's repository as a tree with
file icons and git colors, and read-only editor tabs beside it, in the right-hand panel.

## Use

- **Tree:** click a folder to open it; click a file for a preview tab, double-click to keep it.
  Keys: arrows, Home/End, Page Up/Down, Enter, Space, typing jumps to a name, Escape returns to the terminal.
- **Git:** VS Code's letters and colors (U, A, M, D, C); folders holding changes get a dot; ignored files are dimmed.
- **Right-click** a file, a folder or empty space: Open, New File…, New Folder…, Copy Path,
  Copy Relative Path, Rename… (F2), Delete (Del, to the Recycle Bin or Trash after a confirmation),
  Reveal in File Explorer, Open in Terminal. Names are edited in place, as in VS Code.
  Spaces on another machine only offer the read-only actions.
- **Quick Open** (`ctrl-e`): find a file of the repository by name with fuzzy matching; before typing,
  the recently opened files. Enter opens it in the panel and reveals it in the tree.
- **Syntax colors:** VS Code's Dark Modern and Light Modern palettes, or the Herdr theme's, from the gear menu.
- **Editor font:** VS Code's default (Consolas 14 on Windows, Menlo 12 on macOS), the terminal's, or any installed
  monospace font, and its size, from the gear menu. `scripts/install.ps1 -EditorFont <vscode|terminal|name> -EditorFontSize <12-16>`
  sets the default for an install (`editorFont`, `editorFontSize` in its `config.json`); VS Code's font without them.

## Install

Run `scripts/install.ps1` (or copy `mods/file-explorer` into `~/.config/herdr-app/mods/`), merge
`keys.json` into yours, and point the `files` block of your layout's `panel` at the `file-explorer` mod.
`ctrl-shift-e` toggles the panel and `ctrl-e` opens Quick Open. Both replace keys you may use:
Herdr binds `ctrl-shift-e` to splitting a pane down, and terminal programs use `ctrl-e` to move to
the end of the line (the End key does the same).

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

- Started from Herdr's shipped `files` mod (Apache-2.0); folder arrows from it (Lucide).
- Seti icons: [seti-ui](https://github.com/jesseweed/seti-ui) by Jesse Weed (MIT), as shipped in VS Code;
  glyphs converted to SVG. See `icon-themes/seti/LICENSE-seti.txt`.
- Material icons: [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT).
  See `icon-themes/material/LICENSE-material-icon-theme.txt`.
- Language table: [VS Code](https://github.com/microsoft/vscode) (MIT). See `icon-themes/LICENSE-vscode.txt`.
