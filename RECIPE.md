# File Explorer

An IDE-style explorer in Herdr's right-hand panel, like VS Code's or Zed's. It shows the active space's
repository as a tree, with file icons and git colors. Clicking a file opens it in editor
tabs beside the tree, with syntax colors. `ctrl-e` finds any file of the repository by name.

![File Explorer](preview.png)

## What you see

- **Tree column** (the whole panel with no file open, 280px on the right once files are open):
  - A 36px header: the repository's folder icon and name (semibold), and a gear button (24px, 14px icon)
    on the right.
  - Rows of 24px, 16px per level of indent. Each folder has a chevron (14px, `muted`), and a 1px indent
    guide (`border`) runs through every ancestor level.
  - Each row shows a 16px icon, then the name, and on the right a git letter (11px) for files or a dot
    (`●`) for folders that contain changes.
  - The selected row has the `selected` background. It also gets a 1px `accent` border when the tree has
    the keyboard. The hovered row gets `hover`.
  - Ignored entries are drawn in `dim`, with their icon at 50% opacity.
  - When a folder lists more than 500 entries, a note at the bottom says "Some folders show only their
    first 500 entries".
- **Editor column**, left of the tree, present only while files are open:
  - A 34px tab strip on `chrome`. Each tab has a 14px icon, the name (12px), and a `×` button. The
    active tab has the `background` color; a preview tab's name is italic. A tab's name takes the
    file's git color.
  - A 26px breadcrumb row: the folders in `muted`, separated by `›`, then the file's icon and name in
    `foreground`.
  - The file in Herdr's code editor, with line numbers and folding. Its font is VS Code's
    default (Consolas 14 on Windows, Menlo 12 on macOS), with lines spaced at size × 1.35 (× 1.5 on
    macOS). Images are shown centered instead.
- **Git colors** follow VS Code's letters: U untracked and A added in `ansi2` (green), M modified in
  `ansi3` (yellow), D deleted and C conflict in `ansi1` (red).
- **Gear menu**, a 280px popup:
  - Icon theme: Seti (VS Code's default icons) or Material Icon Theme.
  - Syntax colors: VS Code's Dark/Light Modern, or the Herdr theme's.
  - Editor font: VS Code's, the terminal's, or any installed monospace font, each drawn in its own font.
    The list scrolls past 5 rows. Below it, sizes from 12 to 16.
- **Quick Open**: a 640px popup, 40px from the top, at 60% of the window's height. It has a search input
  with an `accent` border. Each result row is 30px: icon, name with the matched letters in `accent`
  semibold, then the folder in `dim`.

## How it behaves

- The tree follows the active space: it shows the repository of the space's terminal (its git top
  level), else that terminal's folder. Each space keeps its own open folders, selection and tabs.
- **Clicks:**
  - Clicking a folder opens or closes it.
  - Clicking a file opens a preview tab; the next preview replaces it. A double-click keeps the tab.
  - Clicking a tab shows it; double-clicking keeps it; a middle click or `×` closes it.
- **Editing** (local files; another machine's stay read-only, since Herdr writes only local files):
  - Typing edits the tab. The first edit keeps a preview tab. A tab with unsaved edits shows `●`
    instead of `×`.
  - `ctrl+s` saves with `writeTextFile(path, text, expected)`: Herdr writes only if the file still
    holds `expected`, the text the tab started from, so an agent's change in between is never
    overwritten. New lines get the file's line endings (a CRLF file stays CRLF). Herdr's editor keeps
    Ctrl+S, so it is bound like Ctrl+F (`ExplorerEditor > Input`).
  - The file changes on disk: a tab without unsaved edits reloads; one with edits keeps them and
    shows a bar, "This file changed on disk since you started editing." with Reload (the file as it
    is) and Keep mine (writes the tab over it). A refused save shows the same bar. A file whose text
    is already the tab's (your own save) isn't reloaded, so the cursor stays.
  - Closing a tab with unsaved edits (`×`, which shows `●`, or a middle click) opens a 460px dialog:
    "Save the changes to “name”?", "Your changes are lost if you don't save them.", and Cancel,
    Don't Save, Save (`solid`, Enter). Escape cancels. A refused save keeps the tab open, with its
    "changed on disk" bar. A tab not shown since a space switch saves from its draft.
  - Unsaved edits survive a space switch, a theme, color or font change and a catch-up: the editor
    is recreated from a draft (its undo history is lost; Herdr's editor can't be given one).
  - Find while editing: after Enter or `F3` the editor has the keyboard and Enter keeps stepping
    (a binding for `FindStepping > Input`, switched on by the editor area's `key_context`); a click
    or an edit in the text ends it. Letters always go to the file.
- **Go to line:** `ctrl+g` (from the editor or the tree, with a file tab open) shows a bar above the
  file: "Go to line", a box, and the file's range (`1–207`). A line number, or `line:column`, and Enter
  put the cursor there, in the middle of the editor, and give the editor the keyboard. Anything else
  turns the box's border red. Escape closes the bar. Herdr's editor scrolls only as far as a selection
  needs, so the jump selects half a screen below, then above, frame by frame, before the target.
- **Find in file:** `ctrl+f`, `F3` or the magnifier at the right of the path row shows a bar above the
  file: the box with `Aa` (match case), "3 of 14" (or "No results", with the box's border red),
  ↑ ↓ and `×`. A one-line selection fills the box.
  - Typing scrolls to the first match from the cursor (not highlighted yet: Herdr's editor draws a
    selection only while it has the keyboard). Enter or `F3` goes to the next match, Shift with either
    to the previous one: the match is selected in the middle of the editor, which gets the keyboard so
    it shows. From the editor, Enter keeps stepping until a click or an edit in the text (see
    Editing). In a read-only file, letters and Backspace edit the query and bring the keyboard back
    to the box. Escape closes the bar.
  - Plain text, up to 10,000 matches. Only the current match is highlighted: Herdr's editor can't
    mark several. Go to line and find share the place above the file; opening one closes the other.
  - Herdr's editor binds Ctrl+F to a search panel it never shows, and keeps the key. The explorer binds
    it again with `cx.bind_keys`, for `ExplorerEditor > Input` (its editor area declares that
    `key_context`), to an `explorer-find` action: a later binding for the same context wins.
- **Toolbar** (under the header, as in Visual Studio's Solution Explorer):
  - Filter in explorer (funnel icon): keeps the files and folders whose name contains the text
    (case-insensitive, not fuzzy), with the folders leading to them, open. A folder matching only by
    its own name shows closed; opened, it shows everything it holds. Files inside an untracked or
    ignored folder that was never opened aren't found: git doesn't list them.
  - Pending changes (toggle, highlighted while on): only entries with a git letter or dot. It combines
    with the filter.
  - Collapse: closes every folder, or every folder shown under a filter.
  - Under a filter, folders can still be closed and opened; the folders open without a filter come
    back when it's cleared. Escape in the box clears the filter; Down or Enter moves to the first
    match. Quick Open clears the filter when it would hide the chosen file.
  - The filter, like open folders and tabs, belongs to the space's folder: switching space and back
    restores it.
- **Search in folder** (as Zed's project search):
  - `ctrl+shift+f` from anywhere in the explorer, or right-click a folder or empty space → Find in
    Folder… (scoped to that folder; works on another machine's space too).
  - The panel's Search view, under its header: the box with a match-case toggle (`Aa`), a removable
    scope chip (`in mods/file-explorer ×`), a summary ("4 results in 3 files", or "Showing the first
    2,000 of 3,867 results, in 1,364 files") and Clear, which empties the view.
  - Enter runs `git --literal-pathspecs grep -n -I --null --untracked -F [-i] -e <query> -- [scope]`:
    plain text, tracked and untracked files, not ignored ones. Results stay until the next run.
  - Results grouped by file: a header (chevron to fold, icon, name, folder, count), then each line with
    its number and the matches on the `selection` color, in the editor font, cut to 300 characters
    around the first match.
  - A click, or Down from the box then arrows and Enter, opens the file in a preview tab with the
    match selected in the middle of the editor. A double click keeps the tab (the second click
    within 500 ms on the same row: a list's clicks carry no count).
  - A word selected in the open file fills the box. The results, and which view shows, belong to the
    space's folder, like its tabs. Outside a repository it says it needs one.
- **Bottom tabs** (as Visual Studio's tool windows): a 30px strip on `chrome` with Explorer (the tree and
  its toolbar) and Search. The shown one hangs from the panel on `background`: open at the top (the
  strip's top line is drawn in pieces around it), straight `border` sides the strip's full height.
  Search is `dim` until a search has run, and still opens the view.
- **Width:** with files open, the editor and the panel are an `h_resizable` pair: the line between them
  drags (200px to 1,200px). The panel starts at 280px; Herdr keeps a dragged width for the window.
- **Dragging** a file or folder onto a terminal types its quoted path there, without Enter
  (Herdr's `drag_paths`). Dropping anywhere else does nothing. A row being renamed and a file deleted
  on disk can't be dragged.
- **Keys in the tree:**
  - Up/Down, Page Up/Down and Home/End move the selection.
  - Right opens a folder, or moves into it if it's open. Left closes a folder, or moves to its parent.
  - Enter opens a file and keeps it, or toggles a folder. Space previews a file.
  - Typing letters jumps to the next name that starts with them.
  - F2 renames. Delete asks to confirm, then deletes.
  - Escape gives the keyboard back to the terminal.
- **Right-click** on a file, a folder or empty space:
  - Open
  - New File…, New Folder…
  - Copy Path, Copy Relative Path
  - Rename… (F2), Delete (Del)
  - Reveal in File Explorer (Finder; on Linux, Open Containing Folder)
  - Open in Terminal

  Spaces on another machine get only Open, Copy Path and Copy Relative Path.
- **Naming and deleting:**
  - Names are typed in place, in the row. A new entry's row appears at the top of its folder.
    Invalid names show their reason under the tree.
  - Delete moves the entry to the Recycle Bin or Trash, after a confirmation dialog (Enter confirms,
    Escape cancels).
  - The tree changes at once, then checks against the disk.
- **Panel width:** the panel widens to an editor's width (layout weight 1.2) while files are open, and
  goes back to 368px when the last tab closes.
- **Live updates:**
  - When anything changes in the repository, git colors and the tree refresh within half a second.
    An open file whose contents change on disk is read again.
  - Changes inside ignored folders (`node_modules`, `obj`) don't run git.
  - Outside a repository, and on other machines, the explorer polls every 10 seconds instead.
  - While the explorer is hidden (panel closed, or another tab of its stack shown), it does no work. It
    catches up when shown again.
- **Quick Open (`ctrl-e`):**
  - Before you type, it lists recently opened files. Typing ranks the repository's files by fuzzy
    match: letters at word starts and in a row score higher, and scattered letters lose points.
  - Up/Down choose a result, Enter or a click opens it, Escape closes the popup.
  - Choosing a file shows the panel, opens the file and reveals it in the tree.
- **`ctrl-shift-e`** shows or hides the panel. The tree takes the keyboard when the panel appears.
- Agent statuses (working, blocked, done, idle) don't change anything here.

## Built from

- **Layout:** a block `{ "content": { "mod": "file-explorer" } }`. In a clone of Herdr's `main` layout,
  it replaces the `files` block, which sits in the `panel-body` stack of the `panel` column. The mod
  finds its own place by walking `layout()` to the block whose mod is `file-explorer`. It doesn't
  assume node ids:
  - showing it selects each stack on that path and shows hidden nodes
  - the width it resizes is the nearest node on the path that sits in a row
- **Files** in `mods/file-explorer/`:
  - `main.js`: tree, editor and gear-menu wiring
  - `menus.js`: the gear, right-click, delete and unsaved-changes popups
  - `ops.js`: file actions
  - `quickopen.js`: Quick Open
  - `find.js`: go to line, find in file
  - `search.js`: search in folder (the panel's Search view)
  - `place.js`: layout lookups
  - `icon-themes/`: Seti and Material, VS Code icon-theme JSON plus SVGs, and VS Code's
    extension-to-language table
  - `ui/`: chevrons, the gear and the toolbar icons, from Lucide
  - `config.json`: install defaults
- **Popups:** the same mod opened with `openOverlay`, where `props().menu` picks the popup. With no menu
  and an `overlay` (from `mod.open`, using `mod.json`'s `overlay` spec), it opens as Quick Open. Popups
  talk to the explorer through `setShared("file-explorer.request", …)`.
- **Herdr:**
  - functions: `spaces`, `panes`, `focused`, `layout`, `exec`, `readTextFile`, `writeTextFile`,
    `watchFolder`, `theme`, `settings`, `fonts`, `window`, `openOverlay`, `closeOverlay`, `shared`,
    `setShared`, `props`, `nextCommand`, and `fs/promises` (for its own files)
  - commands: `layout.resize`, `layout.select`, `layout.show`, `pane.focus`, `terminal.open`
  - shared state: `file-explorer.iconTheme`, `.syntax`, `.font`, `.fontSize`, `.recent`, `.request`
- **Programs:**
  - `git`: `rev-parse`, `ls-files -t -c -o --exclude-standard --directory` and `status --porcelain=v1
    --ignored=matching`, run in parallel; `grep` for search in folder
  - on Windows, `powershell` lists folders git doesn't describe and performs file actions: `New-Item`,
    `Rename-Item`, Recycle Bin through `Microsoft.VisualBasic`, and `explorer /select`
  - on macOS and Linux, `sh` lists folders; `mkdir`/`mv`, `osascript`/`open` or `gio`/`xdg-open`
    perform file actions
  - no network
- **Syntax:** Herdr's editor names twelve colors (keyword, string, comment, function, type, number,
  constant, variable, operator, punctuation, boolean, string.escape). Languages it lacks are shown
  through a close relative: TypeScript as JavaScript, PowerShell/Dockerfile/`.env` as shell, Terraform
  as Ruby, Kotlin as Java, Swift as Rust, Razor/Vue/Svelte as HTML, MSBuild files as XML.
- **Art:**
  - Seti icons: VS Code's Seti font glyphs converted to SVG (MIT)
  - Material Icon Theme SVGs (MIT)
  - Lucide chevrons, gear and toolbar icons (ISC)
  - `scripts/build-icon-themes.py` regenerates the themes from upstream at pinned versions

## Watch out

- **Drawing rules:**
  - Don't create state while drawing: no `InputState.new` or `cx.focus_handle()` in a render. Make the
    rename input outside it, and defer with `cx.timer.after(0, …)`.
  - A finished `cx.spawn` drops timers it scheduled.
  - Rows inside a virtual list can't take click handlers. The tree draws its own absolutely positioned
    rows and handles the wheel and scrollbar itself.
  - Herdr drops pointer-leave events, so the hover highlight is computed from the pointer's position on
    a 120ms timer, not with `.hover()`.
- **Speed:**
  - Sorting with a regular expression per comparison costs ~130ms on a 1,400-file repository in QuickJS.
    Compute one key per name instead: folders first, lowercase, digit runs padded to 12.
  - On Windows, every `powershell` costs ~250–350ms to start. Inside a repository, build the tree from
    git and read only ignored or untracked folders from disk. Read one level ahead.
  - `fs.readdir` only reads inside the home folder. A grant in `mod.json` or `gpui-shell.json` is
    ignored (herdr-app#292).
  - Every redraw repaints the whole window. Call `cx.notify()` only when something shown changed. Skip
    the rebuild when git's output is unchanged.
- **Windows:**
  - `watchFolder` reports `\\?\C:\…` long paths. Strip that prefix before comparing with the root, or
    no change is ever seen.
  - Changes under `.git` (commits, staging) must still refresh the git colors.
  - Run PowerShell with `$ErrorActionPreference = 'Stop'`, or a failed .NET call exits 0.
  - Quote names for PowerShell with `-LiteralPath` and doubled apostrophes, including the curly ones.
- **Install:** Herdr docks a new mod folder into the shown layout unless its `mod.json`
  (`"place": "none"`) arrives first. Copy `mod.json` before the rest.
- **Keys:** `ctrl-shift-e` replaces Herdr's split-down binding and toggles the node `panel`; change the
  id for another layout. `ctrl-e` takes end-of-line from terminal programs.
- **Limits:**
  - 500 entries per folder; 200,000 paths from git.
  - Remote spaces can't be watched (polling instead), can't preview images, and offer only the
    read-only actions.
  - Unsaved edits live in the explorer: quitting Herdr or reloading the mod loses them (mods get no
    warning).

## Done when

- `herdr-app check mods/file-explorer` passes.
- In a repository, the tree shows tracked and untracked files. A modified file is yellow with `M`. An
  ignored folder is dimmed, and its contents appear when it's opened.
- Clicking a file opens a preview tab; a second file replaces it. Double-click keeps the tab. The panel
  widens, then narrows again when the last tab closes.
- Editing a file from a terminal turns it yellow within a second. An open tab of it shows the new text.
  Committing clears the color.
- Writing files inside `node_modules` or `obj` runs no git.
- Typing `chevron` in the filter box shows `mods/file-explorer/ui/` open on the two chevron icons;
  typing `file-explorer` shows that folder closed under `mods`, and opening it shows all its files;
  Pending changes on its own lists exactly the files `git status` shows; Collapse leaves only the top
  level.
- Dragging a file from the tree onto a terminal types its quoted path at the prompt; a plain click on
  the row still opens it.
- `ctrl-e`, then typing `mainjs`, ranks `main.js` first; Enter opens it and selects it in the tree.
- Right-click → New File…, typing a name, Enter: the file appears at once, in sort order. F2 renames.
  Del asks first, then moves the file to the Recycle Bin or Trash.
- The gear menu switches icon theme, syntax colors, font and size live, without closing open tabs.
- Hiding the panel stops all refreshes; showing it again catches up.
