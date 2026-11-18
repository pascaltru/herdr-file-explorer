# File Explorer

An IDE-style explorer in Herdr's right-hand panel, like VS Code's or Zed's. It shows the active space's
repository as a tree, with file icons and git colors. Clicking a file opens it in editor
tabs beside the tree, with syntax colors, where it can be edited and saved. Find in file, search in
folder (`git grep`) and Quick Open (`ctrl-e`, any file of the repository by name) come with it.

![File Explorer](preview.png)

## What you see

- **Tree column** (the whole panel with no file open, on the right once files are open, at the width
  the person gave it):
  - A 36px header: the repository's folder icon and name (semibold), and a gear button (24px, 14px icon)
    on the right.
  - A toolbar under it: the "Filter in explorer" box, Pending changes and Collapse (see Toolbar).
  - Rows of 24px, 16px per level of indent. Each folder has a chevron (14px, `muted`), and a 1px indent
    guide (`border`) runs through every ancestor level.
  - Each row shows a 16px icon, then the name, and on the right a git letter (11px) for files or a dot
    (`●`) for folders that contain changes.
  - The selected row has the `selected` background. It also gets a 1px `accent` border when the tree has
    the keyboard. The hovered row gets `hover`.
  - Ignored entries are drawn in `dim`, with their icon at 50% opacity.
  - When a folder lists more than 500 entries, a note at the bottom says "Some folders show only their
    first 500 entries".
  - At the bottom, the Explorer and Search tabs (see Bottom tabs).
- **Editor column**, left of the tree, present only while files are open:
  - A 36px tab strip on `chrome`, as tall as the tree's header so their bottom lines meet. Each tab
    has a 14px icon, the name (13px, as the tree), and a 22px close button (Lucide's `x`, 14px; `●`
    with unsaved changes). The active tab has the `background` color; a preview tab's name is italic.
    A tab's name takes the file's git color.
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
    overwritten. A file whose line breaks are all CRLF stays CRLF (new lines too); a mixed file is
    saved as the editor holds it, so new lines there get LF. Herdr's editor keeps Ctrl+S, so it is
    bound like Ctrl+F (`ExplorerEditor > Input`).
  - The file changes on disk: a tab without unsaved edits reloads; one with edits keeps them and
    shows a bar, "This file changed on disk since you started editing." with Reload (the file as it
    is) and Keep mine (writes the tab over it). A refused save shows the same bar. A file whose text
    is already the tab's (your own save) isn't reloaded, so the cursor stays.
  - Closing a tab with unsaved edits (`×`, which shows `●`, or a middle click) opens a 460px dialog:
    "Save the changes to “name”?", "Your changes are lost if you don't save them.", and Cancel,
    Don't Save, Save (`solid`, Enter). Escape cancels. A refused save keeps the tab open, with its
    "changed on disk" bar. A tab not shown since a space switch saves from its draft.
  - Editors outlive a space switch, a catch-up, a rename and a move: each folder's snapshot keeps its
    `EditorState`s, so undo history, cursor and scroll come back with the space. Coming back, each
    one is checked against the disk as a change would be. At most 15 editors are kept in all; past
    that, the least recently shown ones of other spaces are let go. A rename that changes the
    language (`.txt` to `.js`) recreates the editor.
  - Unsaved edits still survive when an editor is let go, recreated for a theme, color or font change
    (also one made while its space wasn't shown), or for another language: it's made again from a
    draft, without its undo history (Herdr's editor can't be given one).
  - Find while editing: after Enter or `F3` the editor has the keyboard and Enter keeps stepping
    (a binding for `FindStepping > Input`, switched on by the editor area's `key_context`); a click
    or an edit in the text ends it. Letters always go to the file.
- **Right-click a tab:** a 240px popup at the pointer, as VS Code's: Close, Close Others, Close to the
  Right, Close Saved, Close All (items that don't apply are dimmed), Copy Path, Copy Relative Path. Close
  asks about unsaved edits as `×` does; the others close only saved tabs and leave the rest open, with a
  toast saying how many (no dialog per file). No shortcuts are shown: the explorer binds none of VS Code's.
- **Right-click in a file's text** (not its tabs or bars): a 260px popup at the pointer.
  - Cut, Copy, Paste (Cut and Paste in editable files, Cut and Copy with a selection).
  - Copy Reference (to Lines, with a selection): `@path#5-10` (`#5` for one line, the bare path
    without a selection), the form Claude Code's VS Code extension inserts; a toast confirms it.
    A selection ending at the start of a line doesn't take that line.
  - Copy Path, Copy Relative Path; Find in File, Go to Line…; Save (with unsaved edits).
  - The popup is this mod as an overlay: it asks the explorer, which holds the editor, through the
    shared request. While it's open the selection isn't drawn (it has the keyboard); when it
    closes, the editor gets the keyboard back so the selection shows again, or the box an action
    opened does. Herdr sends no "focus" when this popup closes: the popup's copy asks from its
    `close()` (`editor-refocus`) unless it already asked for an action.
- **Go to line:** `ctrl+g` (from the editor or the tree, with a file tab open) shows a bar above the
  file: "Go to line", a box, and the file's range (`1–207`). A line number, or `line:column`, and Enter
  put the cursor there, in the middle of the editor, and give the editor the keyboard. Anything else
  turns the box's border red. Escape closes the bar. Herdr's editor scrolls only as far as a selection
  needs, so the jump selects half a screen below, then above, frame by frame, before the target.
- **Find in file:** `ctrl+f`, `F3` or the magnifier at the right of the path row shows a bar above the
  file: the box with three toggles inside (Match case `Aa`, Match whole word and Use regular
  expression, as in the Search view), "3 of 14" (or "No results", or "Invalid regex" in `ansi1`, with
  the box's border red), ↑ ↓ and `×`. A one-line selection fills the box (escaped while the regex
  toggle is on). Regular expressions are JavaScript's, with `^` and `$` at each line; whole word means
  no letter, digit or `_` just before or after.
  - Typing scrolls to the first match from the cursor (not highlighted yet: Herdr's editor draws a
    selection only while it has the keyboard). Enter or `F3` goes to the next match, Shift with either
    to the previous one: the match is selected in the middle of the editor, which gets the keyboard so
    it shows. From the editor, Enter keeps stepping until a click or an edit in the text (see
    Editing). In a read-only file, letters and Backspace edit the query and bring the keyboard back
    to the box. Escape closes the bar.
  - Up to 10,000 matches. Only the current match is highlighted: Herdr's editor can't mark several.
    Go to line and find share the place above the file; opening one closes the other.
  - **Replace** (editable files): a chevron at the bar's left, or `ctrl+h` (bound like Ctrl+F, as
    `explorer-replace`), shows a second row: a Replace box, then Replace and Replace All buttons.
    The bar is two columns, as VS Code's: the find and Replace boxes, one width (up to 340px), then
    the count, arrows and `×` beside the first and the buttons beside the second. `ctrl+h` with a
    query already there puts the keyboard in the Replace box; `ctrl+f` shows find alone.
    - Replace (Enter in the box, or the button) types the replacement over the match shown, with
      `EditorState.replace` (one undo step), then selects the next match after it and gives the
      editor the keyboard, so that match is drawn (the editor draws a selection only while it has the
      keyboard). Enter then replaces it in turn, as find's stepping does: a binding for
      `ReplaceStepping > Input`, switched on by the editor area's `key_context`. A click in the text,
      a typed edit (not Replace's own, recognized by the text it left) or either box taking the
      keyboard ends it; letters typed meanwhile go into the file. If no match is selected (a click or
      an edit moved on), Replace first only shows the next match from the cursor, as VS Code does.
    - Replace All (`ctrl+alt+enter` in the box) replaces every match, past the 10,000 shown, each
      typed over on its own as Replace does: `ctrl+z` undoes them one at a time, the last first, as
      it would typing (one edit for them all would have to retype the whole stretch between the first
      and the last, and its undo would swap that whole stretch back). The replacements come from the
      text before the first edit. The cursor goes to the first one, and the count says "Replaced 12" until the text changes again.
    - The count follows edits to the file (typing, `ctrl+z`) once typing pauses (300 ms).
    - With the regex toggle, the replacement takes JavaScript's `$1`, `$&`, `$<name>` and `$$`.
  - Herdr's editor binds Ctrl+F to a search panel it never shows, and keeps the key. The explorer binds
    it again with `cx.bind_keys`, for `ExplorerEditor > Input` (its editor area declares that
    `key_context`), to an `explorer-find` action: a later binding for the same context wins.
- **Markdown preview:** a `.md` or `.markdown` tab has an eye button (Lucide `eye`, "Open Preview")
  left of the magnifier. It shows the text rendered by Herdr (`TextView.markdown`, selectable, 24px
  side margins) in a container with its own scrollbar (`overflow_y_scrollbar`): TextView's own,
  dragged, also selects the text it passes over. No find bar there: Herdr's rendered view can't be
  searched or given a selection, so find switches back to the text. Unsaved edits show in it; the
  button turns to `code` ("Show Source") to go back. The choice belongs to the tab and survives a space switch.
  - Links: a relative link or a `file://` link inside the folder opens that file in a preview tab,
    rendered if it's Markdown too (`#anchors` are dropped). `http`, `https` and `mailto` open in the
    browser; anything else, and links leading outside the folder, do nothing.
  - Find, Go to line and a search result's jump switch the tab back to its text first (F3 too). While
    it's rendered, a find bar left open from another tab is hidden, and Enter and Escape leave it alone.
  - Relative images don't show: GPUI loads images only from under the app folder.
- **Toolbar** (under the header, as in Visual Studio's Solution Explorer):
  - Filter in explorer (funnel icon): keeps the files and folders whose name contains the text
    (case-insensitive, not fuzzy), with the folders leading to them, open. A folder matching only by
    its own name shows closed; opened, it shows everything it holds.
  - Pending changes (toggle, highlighted while on): only entries with a git letter or dot. It combines
    with the filter.
  - Both filters find files inside untracked folders never opened: the tree's `ls-files --directory`
    lists such a folder as one entry, so while a filter is on, `git ls-files -z -o --exclude-standard`
    lists their files one by one, again on each git refresh. They fill in only the folders not read
    from disk, and go when the filter is cleared. Files in ignored folders never opened aren't found
    (`node_modules` would be huge).
  - Collapse: closes every folder, or every folder shown under a filter.
  - Under a filter, folders can still be closed and opened; the folders open without a filter come
    back when it's cleared. Escape in the box clears the filter; Down or Enter moves to the first
    match. Quick Open clears the filter when it would hide the chosen file.
  - The filter, like open folders and tabs, belongs to the space's folder: switching space and back
    restores it.
- **Search in folder** (as Zed's project search):
  - `ctrl+shift+f` from anywhere in the explorer, or right-click a folder or empty space → Find in
    Folder… (scoped to that folder; works on another machine's space too).
  - The panel's Search view, under its header: the box with three toggles inside, as VS Code's (Match
    case `Aa`, Match whole word and Use regular expression, Lucide `whole-word` and `regex`), and a `…`
    button beside it that shows two more boxes, files to include and files to exclude. Then a removable
    scope chip (`in mods/file-explorer ×`), a summary ("4 results in 3 files", or "Showing the first
    2,000 of 3,867 results, in 1,364 files") and Clear, which empties the view but keeps the toggles
    and the file boxes.
  - It runs `git grep -n -I --null --untracked [-i] [-w] -F|-P -e <query> -- <pathspecs>`: tracked and
    untracked files, not ignored ones. Enter runs it, and so does a pause of 300 ms in typing (2
    characters or more), a toggle, or an edit of a file box once a search has run. `exec` can't be
    stopped: a search asked for while one runs waits for it, and only the latest then runs. Results
    stay until the next run.
  - Regular expressions are PCRE (`-P`), or POSIX extended (`-E`) when git is built without PCRE. git judges the
    pattern: an invalid one shows "Invalid regular expression: <git's reason>", and one JavaScript
    can't compile (PCRE's `(?i)`, `a++`) still searches, its matches unmarked in the results. Whole word is
    git's `-w` (no letter, digit or `_` just before or after).
  - The file boxes take comma-separated globs read as VS Code does: `*.ts` or `docs` (no slash) at any
    depth, `src/lib` from the folder's top; each matches a file, or a folder and all it holds. Braces expand
    (`*.{ts,tsx}` is `*.ts` and `*.tsx`; git's globs have none), commas inside them don't split. They
    become `:(glob)` and `:(glob,exclude)` pathspecs, the includes under the scope; without includes
    the scope is `:(literal)` (a folder named with `[ * ?` or a leading `:` is just a name).
  - Results grouped by file: a header (chevron to fold, icon, name, folder, count), then each line with
    its number and the matches on the `selection` color, in the editor font, cut to 300 characters
    around the first match. The matches are marked with the same search as a JavaScript regex.
  - A click, or Down from the box then arrows and Enter, opens the file in a preview tab with the
    match selected in the middle of the editor. A double click keeps the tab (the second click
    within 500 ms on the same row: a list's clicks carry no count).
  - A word selected in the open file fills the box. The results, and which view shows, belong to the
    space's folder, like its tabs. Outside a repository it says it needs one.
- **Bottom tabs** (as Visual Studio's tool windows): a 30px strip on `chrome` with Explorer (the tree and
  its toolbar) and Search. The shown one hangs from the panel on `background`: open at the top (the
  strip's top line is drawn in pieces around it), straight `border` sides the strip's full height.
  Search is `dim` until a search has run, and still opens the view.
- **Dragging** a file or folder onto a terminal types its quoted path there, without Enter
  (Herdr's `drag_paths`). Dropping anywhere else does nothing. A row being renamed and a file deleted
  on disk can't be dragged.
- **Keys in the tree:**
  - Up/Down, Page Up/Down and Home/End move the selection.
  - Right opens a folder, or moves into it if it's open. Left closes a folder, or moves to its parent.
  - Enter opens a file and keeps it, or toggles a folder. Space previews a file.
  - Typing letters jumps to the next name that starts with them.
  - F2 renames (Herdr binds F2 to tab rename globally; a `cx.bind_keys` binding for the tree's
    `ExplorerTree` key context wins there). Delete asks to confirm, then deletes.
  - Escape gives the keyboard back to the terminal.
- **Right-click** on a file, a folder or empty space:
  - Open
  - New File…, New Folder…
  - Copy Path, Copy Relative Path
  - Cut (Ctrl+X), Paste (Ctrl+V, once something is cut), Rename… (F2), Delete (Del)
  - Reveal in File Explorer (Finder; on Linux, Open Containing Folder)
  - Open in Terminal

  Spaces on another machine get only Open, Copy Path and Copy Relative Path.
- **Moving** (Cut / Paste): Cut dims the row (45% opacity) until it's pasted; Escape in the tree
  forgets it. Paste puts it into the folder right-clicked or selected, or beside a file. Inside a git
  repository it moves at once; elsewhere a dialog asks first ("Move “x.txt” into “d”?", git can't
  undo it). Nothing moves into itself or over a name already in the target folder (a toast says
  why). Open tabs, open folders and unsaved edits follow the move, as for a rename; the target
  folder opens on it. Local spaces only.
- **Undo** (`ctrl+z` in the tree; in a file it undoes typing): the last move or rename made in this
  folder goes back, newest first, up to 20. It refuses, with a toast, when the entry isn't there
  anymore or its old name is taken again. Undoing isn't itself undone (no redo). Creating and
  deleting aren't undone here (deleted items are in the Recycle Bin or Trash).
- **Naming and deleting:**
  - Names are typed in place, in the row. A new entry's row appears at the top of its folder.
    Invalid names show their reason under the tree.
  - Delete moves the entry to the Recycle Bin or Trash, after a confirmation dialog (Enter confirms,
    Escape cancels).
  - The tree changes at once, then checks against the disk.
- **Panel width:** the tree keeps its width, as in VS Code. With files open, the editor and the tree
  are an `h_resizable` pair: the line between them drags (200px to 1,200px). The first file adds the
  editor beside it:
  the panel grows by the editor's width (640px at first, then its last width), up to the layout's
  maximum. Closing the last tab shrinks the panel back to the tree's width. A width dragged at the
  panel's edge, with or without files, is what the tree keeps. Each wide period gets a fresh
  `h_resizable` id, so Herdr's memory of an earlier split doesn't override the tree's width.
- **Live updates:**
  - When anything changes in the repository, git colors and the tree refresh within half a second.
    An open file whose contents change on disk is read again.
  - Changes inside ignored folders (`node_modules`, `obj`) don't run git.
  - Outside a repository, and on other machines, the explorer polls every 10 seconds instead.
  - While the explorer is hidden (panel closed, or another tab of its stack shown), it does no work. It
    catches up when shown again: the tree refreshes, and open files that changed meanwhile reload (or
    show the "changed on disk" bar).
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
  - `menus.js`: the gear, right-click (tree, editor and tab), delete, unsaved-changes and move popups
  - `ops.js`: file actions
  - `quickopen.js`: Quick Open
  - `find.js`: go to line, find in file
  - `search.js`: search in folder (the panel's Search view)
  - `place.js`: layout lookups
  - `icon-themes/`: Seti and Material, VS Code icon-theme JSON plus SVGs, and VS Code's
    extension-to-language table
  - `ui/`: chevrons, the gear, the toolbar and path-row icons, from Lucide
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
    `Rename-Item`, `Move-Item`, Recycle Bin through `Microsoft.VisualBasic`, and `explorer /select`
  - on macOS and Linux, `sh` lists folders; `mkdir`/`mv`, `osascript`/`open` or `gio`/`xdg-open`
    perform file actions
  - to open a web link from a Markdown preview: `rundll32 url.dll,FileProtocolHandler`, `open`
    or `xdg-open`, with the URL as an argument (no shell)
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
  - Files over 1 MiB don't open: Herdr's `readTextFile` refuses them (it doesn't cut them short), and
    the tab says so.
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
- In a new untracked folder `a/b/` holding `c.txt`, typing `c.txt` in the filter shows `a`, `b` and
  `c.txt` open without opening them first.
- Dragging a file from the tree onto a terminal types its quoted path at the prompt; a plain click on
  the row still opens it.
- `ctrl-e`, then typing `mainjs`, ranks `main.js` first; Enter opens it and selects it in the tree.
- Right-click → New File…, typing a name, Enter: the file appears at once, in sort order. F2 renames.
  Del asks first, then moves the file to the Recycle Bin or Trash.
- Ctrl+X on a file, then Ctrl+V on a folder, moves it there (in a repository without asking); Ctrl+Z
  moves it back.
- Typing in an open file shows `●` on its tab; `ctrl+s` saves and clears it. Changing the file from a
  terminal while it has unsaved edits shows the "changed on disk" bar instead of reloading.
- Opening `README.md` and clicking the eye shows it rendered; a relative link in it opens that file.
- `ctrl+f`, a word, Enter: the next match is selected in the middle of the editor, and "n of m" counts.
  `ctrl+g`, a line number, Enter: the cursor goes there.
- `ctrl+shift+f`, a word, Enter: the Search view lists the matches by file; clicking one opens the file
  at it.
- Typing in a file, switching to another space and back: `ctrl+z` still undoes the typing.
- The gear menu switches icon theme, syntax colors, font and size live, without closing open tabs.
- Hiding the panel stops all refreshes; showing it again catches up.
