// The popups the explorer opens: the settings menu (header gear), the right-click menu and the
// delete confirmation. Each is this mod opened as an overlay with props().menu naming which one.
// They change the explorer through a shared request it picks up (see Explorer.handleRequest).
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, openOverlay, setShared, run } from "herdr";
import { trashName, revealLabel, reveal } from "./ops.js";

export const NAME = "file-explorer", REQUEST = `${NAME}.request`;

export function request(action, p, extra = {}) {
  setShared(REQUEST, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), action, rel: p.rel, dir: p.dir, root: p.root, ...extra });
}

const close = () => closeOverlay(props().overlay);

function item(t, id, label, hint, onClick) {
  return h_flex().id(`item-${id}`).h(28).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
    .hover(s => s.bg(t.hover)).on_click(onClick)
    .child(div().flex_1().min_w(0).truncate().child(label))
    .when(Boolean(hint), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(hint)));
}

const separator = t => div().h(9).flex_none().flex().items_center().px(6).child(div().h(1).w_full().bg(t.border));

// --- Settings (gear) ----------------------------------------------------------------------

const heading = (t, text) => div().px(8).pt(4).pb(6).text_size(11).font_semibold().text_color(t.muted).child(text);

function choice(t, id, label, on, onClick, hint, family) {
  return h_flex().id(id).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
    .when(on, el => el.bg(t.selected)).hover(s => s.bg(t.hover)).on_click(onClick)
    .child(div().w(14).flex_none().text_color(t.accent).child(on ? "✓" : ""))
    .child(div().min_w(0).truncate().when(Boolean(family), el => el.font_family(family)).child(label))
    .when(Boolean(hint), el => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(hint)));
}

// The font and size stay open on a click, so several can be tried against the file behind.
export function renderSettings(menu, t, o) {
  const { themes, current } = menu;
  const fontRow = f => choice(t, `font-${f.name}`, f.label, f.name === o.font, () => o.onFont(f.name), f.hint, f.family);
  const sizeButton = n => div().id(`size-${n}`).h(24).flex_1().flex().items_center().justify_center().rounded(6).cursor_pointer()
    .when(n === o.size, el => el.bg(t.selected).text_color(t.accent).font_semibold()).hover(s => s.bg(t.hover))
    .on_click(() => o.onSize(n)).child(String(n));
  return v_flex().id("explorer-menu").size_full().p(6).gap(2).text_size(13).text_color(t.foreground)
    .child(heading(t, "ICON THEME"))
    .children(themes.map(th => choice(t, `theme-${th.name}`, th.label, th.name === current, () => { o.onTheme(th.name); close(); })))
    .when(!themes.length, el => el.child(div().px(8).text_color(t.dim).child("Loading…")))
    .child(div().h(6).flex_none())
    .child(heading(t, "SYNTAX COLORS"))
    .child(choice(t, "syntax-vscode", "VS Code", o.syntax === "vscode", () => { o.onSyntax("vscode"); close(); }))
    .child(choice(t, "syntax-theme", "Herdr theme", o.syntax === "theme", () => { o.onSyntax("theme"); close(); }))
    .child(div().h(6).flex_none())
    .child(heading(t, "EDITOR FONT"))
    .child(v_flex().id("font-list").flex_none().h(Math.min(o.fonts.length, o.fontRows) * 30).overflow_y_scroll().gap(2).children(o.fonts.map(fontRow)))
    .child(h_flex().h(28).flex_none().px(8).gap(2).items_center()
      .child(div().w(40).flex_none().text_color(t.muted).child("Size"))
      .children(o.sizes.map(sizeButton)));
}

// --- Right-click menu ---------------------------------------------------------------------

// p: { rel ("" for the root), dir, root, full (the OS path), relative (the OS relative path), remote }.
export function contextItems(p) {
  const local = !p.remote, items = [];
  if (p.rel && !p.dir) items.push({ id: "open", label: "Open", hint: "Enter" });
  if (local) items.push({ id: "new-file", label: "New File…" }, { id: "new-folder", label: "New Folder…" });
  items.push("-", { id: "copy-path", label: "Copy Path" });
  if (p.rel) items.push({ id: "copy-relative", label: "Copy Relative Path" });
  if (local && (p.rel || p.canPaste)) items.push("-");
  if (local && p.rel) items.push({ id: "cut", label: "Cut", hint: "Ctrl+X" });
  if (local && p.canPaste) items.push({ id: "paste", label: "Paste", hint: "Ctrl+V" });
  if (local && p.rel) items.push({ id: "rename", label: "Rename…", hint: "F2" }, { id: "delete", label: "Delete", hint: "Del" });
  if (local) items.push("-", { id: "reveal", label: revealLabel() }, { id: "terminal", label: "Open in Terminal" });
  if (p.dir || !p.rel) items.push("-", { id: "find-in-folder", label: "Find in Folder…", hint: "Ctrl+Shift+F" });
  // No separator first, last or twice in a row.
  return items.filter((it, i, all) => it !== "-" || (i > 0 && i < all.length - 1 && all[i - 1] !== "-"));
}

export const contextHeight = items => 12 + items.reduce((h, it) => h + (it === "-" ? 9 : 28), 0);

export function openDeleteDialog(p) {
  openOverlay({ mod: NAME, kind: "dialog", width: 440, height: 168, props: { ...p, menu: "delete" } });
}

export function renderContext(p, t) {
  const act = (id, cx) => {
    const parentDir = p.full.slice(0, Math.max(p.full.lastIndexOf("/"), p.full.lastIndexOf("\\")));
    switch (id) {
      case "open": case "rename": request(id, p); break;
      case "find-in-folder": request(id, p, { folder: p.rel }); break;
      case "cut": request(id, p); break;
      // Into a folder, or beside a file, as New File does.
      case "paste": request(id, p, { folder: p.dir ? p.rel : p.rel.slice(0, Math.max(p.rel.lastIndexOf("/"), 0)) }); break;
      // New entries go inside a folder, or beside a file.
      case "new-file": case "new-folder": request(id, p, { folder: p.dir ? p.rel : p.rel.slice(0, Math.max(p.rel.lastIndexOf("/"), 0)) }); break;
      case "delete": openDeleteDialog(p); break;
      case "copy-path": cx.write_to_clipboard(p.full); break;
      case "copy-relative": cx.write_to_clipboard(p.relative); break;
      case "reveal": reveal(p.full).catch(() => {}); break;
      case "terminal": run("terminal.open", { folder: p.dir ? p.full : parentDir, place: "down" }); break;
    }
    close();
  };
  return v_flex().id("explorer-context").size_full().p(6).text_size(13).text_color(t.foreground)
    .children(contextItems(p).map(it => it === "-" ? separator(t) : item(t, it.id, it.label, it.hint, (_e, cx) => act(it.id, cx))));
}

// --- Delete confirmation ------------------------------------------------------------------

export function renderDelete(p, t, handle) {
  const yes = () => { request("delete", p); close(); };
  const name = p.rel.slice(p.rel.lastIndexOf("/") + 1);
  const button = (id, label, primary, onClick) => h_flex().id(id).h(32).px(14).items_center().rounded(8).cursor_pointer()
    .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.popover).text_color(primary ? t.solid_foreground : t.foreground)
    .hover(s => s.opacity(0.88)).on_click(onClick).child(label);
  return v_flex().id("explorer-delete").track_focus(handle)
    .on_key_down((e, cx) => {
      if (e.key === "enter") yes();
      else if (e.key === "escape") close();
      else return;
      cx.stop_propagation();
    })
    .size_full().p(18).gap(10).text_size(13).text_color(t.foreground)
    .child(div().font_semibold().text_size(14).child(`Move “${name}” to the ${trashName()}?`))
    .child(div().text_color(t.muted).child(p.dir ? `The folder and everything in it can be restored from the ${trashName()}.` : `It can be restored from the ${trashName()}.`))
    .child(h_flex().flex_1().items_end().justify_end().gap(8)
      .child(button("delete-no", "Cancel", false, () => close()))
      .child(button("delete-yes", `Move to ${trashName()}`, true, () => yes())));
}

// --- Closing a tab with unsaved edits -----------------------------------------------------------

export function openUnsavedDialog(p) {
  openOverlay({ mod: NAME, kind: "dialog", width: 460, height: 168, props: { ...p, menu: "unsaved" } });
}

// Save, Don't Save or Cancel, as editors ask. Enter saves; Escape cancels.
export function renderUnsaved(p, t, handle) {
  const answer = action => { request(action, p); close(); };
  const name = p.rel.slice(p.rel.lastIndexOf("/") + 1);
  const button = (id, label, primary, onClick) => h_flex().id(id).h(32).px(14).items_center().rounded(8).cursor_pointer()
    .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.popover).text_color(primary ? t.solid_foreground : t.foreground)
    .hover(s => s.opacity(0.88)).on_click(onClick).child(label);
  return v_flex().id("explorer-unsaved").track_focus(handle)
    .on_key_down((e, cx) => {
      if (e.key === "enter") answer("close-save");
      else if (e.key === "escape") close();
      else return;
      cx.stop_propagation();
    })
    .size_full().p(18).gap(10).text_size(13).text_color(t.foreground)
    .child(div().font_semibold().text_size(14).child(`Save the changes to “${name}”?`))
    .child(div().text_color(t.muted).child("Your changes are lost if you don't save them."))
    .child(h_flex().flex_1().items_end().justify_end().gap(8)
      .child(button("unsaved-cancel", "Cancel", false, () => close()))
      .child(button("unsaved-discard", "Don't Save", false, () => answer("close-discard")))
      .child(button("unsaved-save", "Save", true, () => answer("close-save"))));
}

// --- Right-click in the editor ------------------------------------------------------------------

// The editor's own actions run in the explorer (it holds the editor): the popup asks for them.
export function editorItems(p) {
  const items = [];
  if (p.editable && p.selection) items.push({ id: "editor-cut", label: "Cut", hint: "Ctrl+X" });
  if (p.selection) items.push({ id: "editor-copy", label: "Copy", hint: "Ctrl+C" });
  if (p.editable) items.push({ id: "editor-paste", label: "Paste", hint: "Ctrl+V" });
  items.push("-", { id: "editor-reference", label: p.selection ? "Copy Reference to Lines" : "Copy Reference" },
    { id: "copy-path", label: "Copy Path" }, { id: "copy-relative", label: "Copy Relative Path" });
  items.push("-", { id: "editor-find", label: "Find in File", hint: "Ctrl+F" }, { id: "editor-goto", label: "Go to Line…", hint: "Ctrl+G" });
  if (p.editable && p.dirty) items.push("-", { id: "editor-save", label: "Save", hint: "Ctrl+S" });
  return items.filter((it, i, all) => it !== "-" || (i > 0 && i < all.length - 1 && all[i - 1] !== "-"));
}

export function openEditorMenu(p) {
  openOverlay({ mod: NAME, kind: "popup", width: 260, height: contextHeight(editorItems(p)), props: { ...p, menu: "editor" } });
}

// The editor stops drawing its selection while the menu has the keyboard, and Herdr sends the
// explorer no "focus" when this popup closes: closing without asking for an action (Escape, a click
// beside it, Copy Path) asks for the keyboard to go back to the editor. One request at a time: the
// shared slot keeps only the last one.
let editorMenuAsked = false;

export function editorMenuClosed(p) {
  if (!editorMenuAsked) request("editor-refocus", p);
  editorMenuAsked = false;
}

export function renderEditorContext(p, t) {
  const act = (id, cx) => {
    if (id === "copy-path") cx.write_to_clipboard(p.full);
    else if (id === "copy-relative") cx.write_to_clipboard(p.relative);
    else { request(id, p); editorMenuAsked = true; }
    close();
  };
  return v_flex().id("explorer-editor-context").size_full().p(6).text_size(13).text_color(t.foreground)
    .children(editorItems(p).map(it => it === "-" ? separator(t) : item(t, it.id, it.label, it.hint, (_e, cx) => act(it.id, cx))));
}

// --- Moving outside a git repository ------------------------------------------------------------

// A move git can't undo: asked first (inside a repository the explorer moves directly).
export function openMoveDialog(p) {
  openOverlay({ mod: NAME, kind: "dialog", width: 460, height: 168, props: { ...p, menu: "move" } });
}

export function renderMove(p, t, handle) {
  const yes = () => { request("move-confirmed", p, { folder: p.folder }); close(); };
  const name = p.rel.slice(p.rel.lastIndexOf("/") + 1), into = p.folder ? p.folder.slice(p.folder.lastIndexOf("/") + 1) : p.rootName;
  const button = (id, label, primary, onClick) => h_flex().id(id).h(32).px(14).items_center().rounded(8).cursor_pointer()
    .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.popover).text_color(primary ? t.solid_foreground : t.foreground)
    .hover(s => s.opacity(0.88)).on_click(onClick).child(label);
  return v_flex().id("explorer-move").track_focus(handle)
    .on_key_down((e, cx) => {
      if (e.key === "enter") yes();
      else if (e.key === "escape") close();
      else return;
      cx.stop_propagation();
    })
    .size_full().p(18).gap(10).text_size(13).text_color(t.foreground)
    .child(div().font_semibold().text_size(14).child(`Move “${name}” into “${into}”?`))
    .child(div().text_color(t.muted).child("This folder isn't in a git repository, so git can't undo the move."))
    .child(h_flex().flex_1().items_end().justify_end().gap(8)
      .child(button("move-no", "Cancel", false, () => close()))
      .child(button("move-yes", "Move", true, () => yes())));
}
