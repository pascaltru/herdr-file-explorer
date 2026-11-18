# Herdr File Explorer

A mod for the Herdr desktop app: an IDE-style tree and editor tabs in the right-hand
panel, plus Quick Open. `README.md` covers use and install; `RECIPE.md` is the full description
(what you see, how it behaves, what it's built from, pitfalls, acceptance checks). Keep both true when
behavior changes.

## Layout of the code

- `mods/file-explorer/main.js` — the Explorer view: tree, git colors, folder watching, editor tabs.
- `menus.js` — gear menu, right-click menus (tree, editor, tabs), delete, unsaved-changes and move dialogs (this
  mod as an overlay, `props().menu`); they reach the explorer through a shared request (`Explorer.handleRequest`).
- `ops.js` — file operations (PowerShell on Windows, usual tools elsewhere); `quickopen.js` — Quick Open;
  `find.js` — go to line, find in file; `search.js` — search in folder (the panel's Search view);
  `place.js` — finds the explorer's block in the layout.
- `icon-themes/` is generated: never hand-edit; run `python scripts/build-icon-themes.py`
  (`--material <ver>` / `--vscode <ver>` to bump; versions pinned in `versions.json`).

## Herdr facts

- Herdr's home is `~/.config/herdr-app`. Its `AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts` are the API
  truth; Herdr rewrites them on start. `herdr-app --skill` and `hc --skill` print the CLI manuals.
- Mods run in QuickJS on the window's thread. Heavy JS freezes the window, and every `cx.notify()`
  repaints the whole window.
- `fs/promises` reads only inside the home folder. Capability grants in `mod.json` or
  `gpui-shell.json` are ignored (tested). Anything else goes through `exec` (see herdr-app#292).

## Workflow

- Edit here, then run `powershell -NoProfile -File scripts/install.ps1`. It mirrors
  `mods/file-explorer` into the Herdr home and runs `herdr-app check`. A passing check is required
  before calling anything done. Then `herdr-app status` must list no `errors`: the check passes
  files Herdr then refuses to reload (a NUL byte, for one).
- See the result with `herdr-app shot <file.png>`, then read the PNG. Never drive the mouse or keyboard
  on the user's display.
- To exercise clicks or state:
  - Add a temporary hook to the **installed** copy only, marked `/*TESTHOOK*/` (for example a
    `cx.timer` that writes JSON to `~/.config/herdr-app/cache/explorer-debug.json`).
  - Read that file.
  - Reinstall to remove the hook, and confirm `grep -c TESTHOOK` gives 0.
  - A hook runs only while the explorer is shown: the test space selected, its panel shown. The user
    may switch away meanwhile; `space.select` the test space before reading, then switch back.
  - Simulate typing with `code.replace(text)` (it fires `change`, after the call returns), not
    `set_value`, which fires none (nor does `InputState.set_value`).
- Popups: the "focus" command after a popup closes doesn't always come (it doesn't for the editor's
  right-click menu). A popup's copy gets `close()` when it closes, and can ask the explorer from there.
- A dialog opened by a test (an overlay) survives a reinstall: close it with
  `herdr-app do overlay.close '{}'`.
- Temporary test spaces are fine: `herdr-app do space.new '{"name":"x","folder":"C:/..."}'` (forward
  slashes; backslashes break the JSON). Close them afterwards with `space.close {id, confirmed:true}`,
  and `space.select` the user's previous space. A new space starts with the panel hidden; use
  `layout.show {"id":"panel"}`.
- **Commits:** one per change, after the check and a screenshot. **Don't push**: Claude Code's
  permission check blocks it; give the user the command (`! git push`).
- **Public repo:** tracked files and commit messages are published. Keep personal details out
  (usernames, machine or layout names, home paths, secrets); they go in the gitignored `CLAUDE.local.md`.
- **Deletions:** `rm -r` is denied; give the user the command instead.
- **Python edits on Windows:**
  - Use `read_bytes`/`write_bytes`; `write_text` turns the file into CRLF.
  - Use raw strings when the text has backslashes.
  - Prefer the Edit tool for JS. A script holding JS with backslashes goes in a file written with the
    Write tool: Bash heredocs mangle backslashes (one turned `"\0"` into a real NUL byte, another
    `'\r\n'` into line breaks).
- Git has `core.autocrlf=true`; CRLF warnings are expected.
- Comments explain only a non-obvious why, tersely.

## Runtime pitfalls (learned the hard way)

- **Drawing rules:**
  - No state creation in a render: no `InputState.new` or `cx.focus_handle()`.
  - Defer with `cx.timer.after(0, cx => …)`; a finished `cx.spawn` drops the timers it scheduled.
  - Never keep a `cx` for later; each callback gets its own. That includes an event handler's `cx`
    after an `await`: its `notify()` is dropped. Wait inside `cx.spawn(async cx => …)` instead.
  - A `cx.spawn` body that never really waits (only cached values) gives the tasks it starts a
    `cx` whose `notify()` is dropped. `await cx.sleep(0)` first (see `sync`).
- **Tree drawing:** rows inside a virtual list can't have click handlers, so the tree draws its own
  absolute rows. Herdr drops pointer-leave events, so hover comes from `window.mouse_position()` on a
  timer.
- **Windows paths and PowerShell:**
  - `watchFolder` reports `\\?\C:\…` long paths; `flush()` strips the prefix.
  - Changes under `.git` must still refresh the git colors (commits, staging).
  - PowerShell 5.1 (`powershell`) starts in ~250–350 ms. `pwsh` 7 is slower (~370 ms); `cmd /c dir`
    is 25 ms but can't take quoted paths. The decision: keep PowerShell for folder listing.
  - Run PowerShell with `$ErrorActionPreference='Stop'` and quote with `-LiteralPath` plus doubled
    apostrophes.
  - `herdr-app.exe` is a GUI program: pipe its output (`| Write-Output`) in PowerShell.
  - robocopy exit codes 1–7 mean success.
- **New mod folders:** Herdr docks a new mod folder into the layout unless `mod.json`
  (`"place": "none"`) is copied first.
- **Layout:**
  - Don't assume node ids: `place.js` finds the explorer's block by its mod.
- **Refreshes:** git runs `ls-files` and `status` in parallel. Deleted-on-disk files come from status,
  not `ls-files -d`. The tree is rebuilt only when the file list or the ignored or deleted entries
  change. Changes inside ignored folders run no git. Nothing refreshes while the explorer is hidden;
  it catches up when shown.
- **Herdr's editor** (`EditorState`, tested):
  - `set_selected_range` scrolls only as far as needed, and only for the last call in a frame.
  - A selection is drawn only while the editor has the keyboard (`code.focus()`).
  - With the editor focused, Ctrl+F never reaches `on_key_down` or `keys.json`: the editor binds it.
    `cx.bind_keys` with a context (`ExplorerEditor > Input`) out-binds it, because a later binding
    wins. Ctrl+G, F3, Ctrl+Shift+F and Escape do reach `on_key_down` on its parent.
  - Editable, it also keeps Enter, letters and Ctrl+S. A binding can be switched on and off by
    changing the parent's `key_context` ("ExplorerEditor FindStepping", "ReplaceStepping"). It keeps
    CRLF as read; `set_selected_range` fires no change event.
  - No API marks text without the keyboard (no decorations, no readable scroll offset): find can't
    highlight while its box has the keyboard. Routing typed keys from the editor to the box was
    rejected: unbound keys (accented letters of non-US layouts, dead keys) would type into the file.
  - `replace(text)` works without the keyboard and is one undo step; several can't be grouped. Its
    undo selects the whole replaced range (see `undoneAll`).
  - Kept `EditorState`s outlive space switches (`evictEditors`, 15 at most); a change handler reads
    `view.rel`, never the name it was created with.
- **Other Herdr APIs:**
  - `readTextFile` throws "Text file exceeds 1 MiB" rather than cutting a file short.
  - `TextView` is in "gpui-base". Its own scrollbar, dragged, selects text: scroll it in a
    `div().overflow_y_scrollbar()` instead.
  - An action handler gets only the action's name: one action per bound key.
- **Syntax:** Herdr's editor bundles few grammars. `LANG`/`LANG_BY_NAME` map other types to a close
  relative (TS→js, ps1/Dockerfile→sh, tf→ruby, kt→java, swift→rust, csproj→xml).

## Decisions

- Seti icons by default, Material as an option (gear menu; `config.json` from `install.ps1`).
- VS Code style throughout:
  - git letters U/A/M/D/C, with dots on folders
  - Dark/Light Modern syntax colors by default
  - VS Code's default font and 1.35 line height
- Delete goes to the Recycle Bin or Trash, after a confirmation.
- Keys: `ctrl-shift-e` toggles the panel (replacing Herdr's split-down); `ctrl-e` opens Quick Open
  (the user insisted, knowing it takes end-of-line from terminals).
- No native sidecar for now. If ever needed: a Go binary.
- Find and Replace show no match while their box has the keyboard (Herdr can't mark text otherwise).
  The user declined workarounds (a preview strip of the match line, a band drawn over the editor);
  after Enter or Replace the editor takes the keyboard so the match shows.
- Replace All is one undo step, as VS Code (tried one edit per match: too many Ctrl+Z).
