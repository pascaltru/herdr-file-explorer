// Go to line and find in the open file. Herdr's editor exposes only its text and its selection;
// setting the selection scrolls to it, and draws it only while the editor has the keyboard.
import { div, svg } from "gpui-kit";
import { h_flex, Input, InputState } from "gpui-base";

// The UTF-16 offset of a 1-based line and column, clamped to the text and to that line.
export function offsetOf(text, line, col = 1) {
  let start = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) break;
    start = nl + 1;
  }
  let end = text.indexOf("\n", start);
  if (end === -1) end = text.length;
  if (end > start && text[end - 1] === "\r") end--;
  return Math.min(start + Math.max(col - 1, 0), end);
}

// The 1-based line holding a UTF-16 offset.
export function lineAt(text, offset) {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

export function lineCount(text) {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

export class GoToLine {
  // `explorer` brings the active tab and jumpTo.
  constructor(explorer) {
    this.explorer = explorer;
    this.open = false; this.lines = 0; this.error = false;
    this.input = InputState.new({ placeholder: "Line, or line:column" });
    this.input.on("change", (_e, cx) => { if (this.error) { this.error = false; cx.notify(); } });
    this.input.on("submit", (_e, cx) => this.submit(cx));
  }

  show(code, cx) {
    this.open = true; this.error = false; this.lines = lineCount(code.value());
    this.input.set_value("");
    this.input.focus();
    // The bar is drawn after this: ask again once it's there.
    cx.timer.after(50, () => this.input.focus());
    cx.notify();
  }

  hide(cx) {
    this.open = false;
    cx.notify();
  }

  submit(cx) {
    const m = this.input.value().match(/^\s*(\d+)\s*(?:[:,]\s*(\d+))?\s*$/);
    if (!m || Number(m[1]) < 1) { this.error = true; cx.notify(); return; }
    this.open = false;
    this.explorer.jumpTo(this.explorer.active, Math.min(Number(m[1]), this.lines), Number(m[2] ?? 1), 0, cx);
  }

  render(t) {
    return h_flex().id("explorer-goto").h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
      .child(div().flex_none().text_color(t.muted).child("Go to line"))
      .child(h_flex().flex_1().min_w(0).max_w(260).h(24).px(6).items_center().rounded(5).border_1().border_color(this.error ? t.ansi1 : t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().min_w(0).h_full().text_color(t.foreground)))
      .child(div().flex_none().text_color(t.dim).child(`1–${this.lines}`));
  }
}

const MAX_MATCHES = 10000;

// Find in the open file. Only the current match can be highlighted, and only once the editor has the
// keyboard: typing scrolls to the match, Enter or F3 selects it and hands the editor the keyboard.
export class FindBar {
  // `explorer` brings the active file's editor (activeCode) and showRange.
  constructor(explorer) {
    this.explorer = explorer;
    this.open = false; this.caseSensitive = false; this.matches = []; this.index = -1; this.source = null;
    // After Enter or F3 the editor has the keyboard, and Enter keeps stepping (a binding the explorer
    // switches on with this) until a click or an edit in the file.
    this.stepping = false;
    this.input = InputState.new({ placeholder: "Find in file" });
    this.input.on("change", (_e, cx) => this.typed(cx));
    // Enter hands the editor the keyboard, so the match is drawn (in a read-only file, typeIntoBox
    // brings typing back here).
    this.input.on("submit", (e, cx) => this.step(e?.shift ? -1 : 1, cx));
    this.input.on("focus", () => { this.boxFocused = true; });
    this.input.on("blur", () => { this.boxFocused = false; });
  }

  // Ctrl+F, F3 or the magnifier: a single-line selection becomes the query.
  show(cx) {
    const code = this.explorer.activeCode();
    if (!code) return false;
    const range = code.selected_range(), picked = range.end > range.start ? code.value().slice(range.start, range.end) : "";
    if (picked && !picked.includes("\n") && picked.length <= 200) this.input.set_value(picked);
    this.open = true; this.stepping = false;
    this.find();
    this.index = this.firstFrom(range.start);
    this.focusInput();
    // The bar is drawn after this: ask again once it's there.
    cx.timer.after(50, () => this.focusInput());
    cx.notify();
    return true;
  }

  hide(cx) {
    this.open = false; this.stepping = false;
    cx.notify();
  }

  focusInput() {
    this.input.focus();
    this.input.set_selected_range({ start: 0, end: this.input.value().length });
  }

  // The match offsets, recomputed when the file, the query or the case setting changed.
  find() {
    const code = this.explorer.activeCode(), text = code?.value() ?? "", query = this.input.value();
    const s = this.source;
    if (s && s.code === code && s.text === text && s.query === query && s.caseSensitive === this.caseSensitive) return;
    const hay = this.caseSensitive ? text : text.toLowerCase(), needle = this.caseSensitive ? query : query.toLowerCase();
    const matches = [];
    for (let i = needle ? hay.indexOf(needle) : -1; i !== -1 && matches.length < MAX_MATCHES; i = hay.indexOf(needle, i + needle.length)) matches.push(i);
    this.matches = matches;
    this.source = { code, text, query, caseSensitive: this.caseSensitive };
  }

  firstFrom(offset) {
    if (!this.matches.length) return -1;
    const i = this.matches.findIndex(m => m >= offset);
    return i === -1 ? 0 : i;
  }

  // Typing: scroll to the first match from the cursor. No highlight: the box has the keyboard.
  typed(cx) {
    const code = this.explorer.activeCode();
    if (!code) return;
    this.find();
    this.index = this.firstFrom(code.selected_range().start);
    if (this.index !== -1) {
      const at = this.matches[this.index];
      code.set_selected_range({ start: at, end: at + this.input.value().length });
    }
    cx.notify();
  }

  // Enter / F3 (+1), Shift+Enter / Shift+F3 (-1): from the current match, or from the cursor if it
  // moved, in the middle of the editor. `focus`: the editor gets the keyboard, so the match shows.
  step(dir, cx, focus = true) {
    const code = this.explorer.activeCode(), len = this.input.value().length;
    if (!code) return;
    this.find();
    const n = this.matches.length;
    if (!n) { cx.notify(); return; }
    const sel = code.selected_range();
    // From the box, or while a jump is still centering, the cursor is ours: count from the current
    // match. Otherwise from the cursor, which a click may have moved.
    let i = (this.boxFocused || this.explorer.revealing) && this.index >= 0 && this.index < n ? this.index
      : this.matches.findIndex(m => m === sel.start && sel.end - sel.start === len);
    if (i !== -1) i = (i + dir + n) % n;
    else if (dir > 0) { i = this.matches.findIndex(m => m >= sel.end); if (i === -1) i = 0; }
    else {
      i = n - 1;
      while (i >= 0 && this.matches[i] + len > sel.start) i--;
      if (i === -1) i = n - 1;
    }
    this.index = i;
    this.stepping = focus;
    this.explorer.showRange(code, this.matches[i], this.matches[i] + len, focus, cx);
  }

  // While the editor has the keyboard (after Enter), letters and Backspace still edit the query: the
  // box takes them and the keyboard back, so it feels as if it never left.
  typeIntoBox(e, cx) {
    const m = e.modifiers, ch = e.key_char, value = this.input.value();
    let next;
    if (e.key === "backspace" && !m.control && !m.alt) next = value.slice(0, -1);
    else if (ch && ch.length === 1 && ch >= " " && !m.control && !m.alt && !m.platform) next = value + ch;
    else return false;
    this.input.set_value(next);
    this.input.focus();
    this.input.set_selected_range({ start: next.length, end: next.length });
    this.typed(cx);
    return true;
  }

  render(t) {
    const query = this.input.value(), n = this.matches.length, missing = Boolean(query) && !n;
    const count = !query ? "" : !n ? "No results" : `${this.index + 1} of ${n}${n >= MAX_MATCHES ? "+" : ""}`;
    const button = (id, child, tip, on, click) => div().id(id).w(24).h(22).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_size(12).text_color(on ? t.foreground : t.muted).when(on, el => el.bg(t.selected))
      .hover(s => s.bg(on ? t.selected : t.hover).text_color(t.foreground)).tooltip(tip).on_click((_e, cx) => click(cx)).child(child);
    return h_flex().id("explorer-find").h(34).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border).text_size(12)
      .child(h_flex().flex_1().min_w(0).max_w(300).h(24).px(6).gap(4).items_center().rounded(5).border_1().border_color(missing ? t.ansi1 : t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().min_w(0).h_full().text_color(t.foreground))
        .child(button("find-case", "Aa", "Match case", this.caseSensitive, cx => { this.caseSensitive = !this.caseSensitive; this.typed(cx); })))
      .child(div().flex_none().min_w(64).text_color(t.dim).child(count))
      .child(button("find-prev", "↑", "Previous match (Shift+F3)", false, cx => this.step(-1, cx)))
      .child(button("find-next", "↓", "Next match (F3)", false, cx => this.step(1, cx)))
      .child(button("find-close", svg(`${this.explorer.modPath}/ui/x.svg`).size(12), "Close (Escape)", false, cx => {
        this.hide(cx);
        this.explorer.activeCode()?.focus();
      }));
  }
}
