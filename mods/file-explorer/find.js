// Go to line, and find and replace in the open file. Herdr's editor exposes only its text and its
// selection; setting the selection scrolls to it, and draws it only while the editor has the keyboard.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";

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
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A regular expression's replacement as JavaScript's String.replace reads it: $& the match, $1 a
// group, $<name> a named group, $$ a dollar.
function expand(template, m) {
  return template.replace(/\$(\$|&|`|'|<([^>]*)>|(\d{1,2}))/g, (all, what, name, digits) => {
    if (what === "$") return "$";
    if (what === "&") return m[0];
    if (name !== undefined) return m.groups?.[name] ?? "";
    if (digits !== undefined) {
      // $12 is group 12 if there is one, else group 1 followed by "2".
      if (Number(digits) < m.length) return m[Number(digits)] ?? "";
      if (digits.length === 2 && Number(digits[0]) < m.length) return (m[Number(digits[0])] ?? "") + digits[1];
      return all;
    }
    return all;
  });
}

// Find and replace in the open file. Only the current match can be highlighted, and only once the
// editor has the keyboard: typing scrolls to the match, Enter or F3 selects it and hands the editor
// the keyboard.
export class FindBar {
  // `explorer` brings the active file's editor (activeCode), whether it's editable, and showRange.
  constructor(explorer) {
    this.explorer = explorer;
    this.open = false; this.caseSensitive = false; this.wholeWord = false; this.regex = false;
    this.matches = []; this.index = -1; this.source = null; this.invalid = false;
    // The replace row (the chevron, or Ctrl+H), for editable files.
    this.replacing = false;
    // After Enter or F3 the editor has the keyboard, and Enter keeps stepping (a binding the explorer
    // switches on with this) until a click or an edit in the file.
    this.stepping = false;
    // After Replace, the same with the next match: the editor has the keyboard, so the match is
    // drawn, and Enter replaces it (ReplaceStepping) until a click, a typed edit or a box takes over.
    this.replaceStepping = false;
    this.input = InputState.new({ placeholder: "Find in file" });
    this.input.on("change", (_e, cx) => this.typed(cx));
    // Enter hands the editor the keyboard, so the match is drawn (in a read-only file, typeIntoBox
    // brings typing back here).
    this.input.on("submit", (e, cx) => this.step(e?.shift ? -1 : 1, cx));
    this.input.on("focus", (_e, cx) => { this.boxFocused = true; if (this.replaceStepping) { this.replaceStepping = false; cx?.notify(); } });
    this.input.on("blur", () => { this.boxFocused = false; });
    this.replaceInput = InputState.new({ placeholder: "Replace" });
    this.replaceInput.on("submit", (_e, cx) => this.replaceOne(cx));
    // Stepping's Enter binding covers every input of the editor area: off while this box is used.
    this.replaceInput.on("focus", (_e, cx) => {
      this.replaceFocused = true;
      if (this.stepping || this.replaceStepping) { this.stepping = false; this.replaceStepping = false; cx?.notify(); }
    });
    this.replaceInput.on("blur", () => { this.replaceFocused = false; });
  }

  // Ctrl+F, F3 or the magnifier (Ctrl+H: `replace`): a single-line selection becomes the query.
  show(cx, replace = false) {
    const code = this.explorer.activeCode();
    if (!code) return false;
    const range = code.selected_range(), picked = range.end > range.start ? code.value().slice(range.start, range.end) : "";
    if (picked && !picked.includes("\n") && picked.length <= 200) this.input.set_value(this.regex ? escapeRegex(picked) : picked);
    this.open = true; this.stepping = false; this.replaceStepping = false; this.replaced = null;
    this.replacing = replace;
    this.find();
    this.index = this.firstFrom(range.start);
    // Ctrl+H with a query already there: straight to the replacement.
    const box = replace && this.input.value() ? () => this.focusReplace() : () => this.focusInput();
    box();
    // The bar is drawn after this: ask again once it's there.
    cx.timer.after(50, box);
    cx.notify();
    return true;
  }

  hide(cx) {
    this.forget();
    cx.notify();
  }

  // Closed: the file's text and editor aren't kept (up to 1 MB, and a released editor).
  forget() {
    this.open = false; this.stepping = false; this.replaceStepping = false; this.beforeAll = null; this.source = null; this.matches = []; this.index = -1;
  }

  focusInput() {
    this.input.focus();
    this.input.set_selected_range({ start: 0, end: this.input.value().length });
  }

  focusReplace() {
    this.replaceInput.focus();
    this.replaceInput.set_selected_range({ start: 0, end: this.replaceInput.value().length });
  }

  // The query as a regex (null: plain text, searched with indexOf). Whole word as VS Code's: no
  // letter, digit or _ just before or after. `m`: ^ and $ at each line.
  pattern(query) {
    if (!this.regex && !this.wholeWord) return null;
    const source = this.regex ? query : escapeRegex(query);
    return new RegExp(this.wholeWord ? `(?<!\\w)(?:${source})(?!\\w)` : source, `gm${this.caseSensitive ? "" : "i"}`);
  }

  // Every match in `text`, as [start, end] pairs, up to `limit`. Empty matches (`^`, `a*`) are skipped.
  all(text, query, lower, limit) {
    const out = [];
    if (!query) return out;
    const re = this.pattern(query);
    if (!re) {
      const hay = this.caseSensitive ? text : lower ?? text.toLowerCase(), needle = this.caseSensitive ? query : query.toLowerCase();
      for (let i = hay.indexOf(needle); i !== -1 && out.length < limit; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
      return out;
    }
    for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
      if (!m[0].length) { re.lastIndex++; continue; }
      out.push([m.index, m.index + m[0].length]);
    }
    return out;
  }

  // The match offsets, recomputed when the file, the query or a toggle changed.
  find() {
    const code = this.explorer.activeCode(), text = code?.value() ?? "", query = this.input.value();
    const s = this.source, sameText = Boolean(s && s.code === code && s.text === text);
    const mode = `${this.caseSensitive}|${this.wholeWord}|${this.regex}`;
    if (sameText && s.query === query && s.mode === mode) return;
    // Lowercasing a large file costs more than the search: reused while only the query changes.
    const lower = sameText && s.lower ? s.lower : !this.caseSensitive && !this.regex && !this.wholeWord ? text.toLowerCase() : null;
    this.invalid = false;
    try { this.matches = this.all(text, query, lower, MAX_MATCHES); }
    catch { this.matches = []; this.invalid = true; }
    this.source = { code, text, lower, query, mode };
  }

  firstFrom(offset) {
    if (!this.matches.length) return -1;
    const i = this.matches.findIndex(m => m[0] >= offset);
    return i === -1 ? 0 : i;
  }

  // Typing: scroll to the first match from the cursor. No highlight: the box has the keyboard.
  typed(cx) {
    const code = this.explorer.activeCode();
    if (!code) return;
    this.replaced = null;
    this.find();
    this.index = this.firstFrom(code.selected_range().start);
    if (this.index !== -1) {
      const [start, end] = this.matches[this.index];
      code.set_selected_range({ start, end });
    }
    cx.notify();
  }

  // Enter / F3 (+1), Shift+Enter / Shift+F3 (-1): from the current match, or from the cursor if it
  // moved, in the middle of the editor. `focus`: the editor gets the keyboard, so the match shows.
  step(dir, cx, focus = true) {
    const code = this.explorer.activeCode();
    if (!code) return;
    this.replaced = null;
    this.find();
    const n = this.matches.length;
    if (!n) { cx.notify(); return; }
    const sel = code.selected_range();
    // From the boxes, or while a jump is still centering, the cursor is ours: count from the current
    // match. Otherwise from the cursor, which a click may have moved.
    let i = (this.boxFocused || this.replaceFocused || this.explorer.revealing) && this.index >= 0 && this.index < n ? this.index
      : this.matches.findIndex(m => m[0] === sel.start && m[1] === sel.end);
    if (i !== -1) i = (i + dir + n) % n;
    else if (dir > 0) { i = this.matches.findIndex(m => m[0] >= sel.end); if (i === -1) i = 0; }
    else {
      i = n - 1;
      while (i >= 0 && this.matches[i][1] > sel.start) i--;
      if (i === -1) i = n - 1;
    }
    this.index = i;
    this.stepping = focus; this.replaceStepping = false;
    this.explorer.showRange(code, this.matches[i][0], this.matches[i][1], focus, cx);
  }

  // What replaces the match at `start`: the box's text, with $1 and the like for a regex (`re`, made
  // once by Replace All for all its matches).
  replacement(text, start, re = this.regex ? this.pattern(this.input.value()) : null) {
    const template = this.replaceInput.value();
    if (!re) return template;
    re.lastIndex = start;
    const m = re.exec(text);
    return m && m.index === start ? expand(template, m) : template;
  }

  // Enter in the replace box: the match shown (selected) is replaced (typed over: Ctrl+Z undoes it),
  // and the next one is shown. With no match selected (a click or an edit moved on), it first shows
  // the next one from the cursor, as VS Code does. The keyboard stays in the box.
  replaceOne(cx) {
    const code = this.explorer.activeCode();
    if (!code || !this.explorer.activeEditable()) return;
    this.find();
    if (!this.matches.length) { cx.notify(); return; }
    this.replaced = null;
    const sel = code.selected_range(), shown = this.matches[this.index];
    // While a jump is still centering, the selection is elsewhere for a few frames.
    const current = shown && (this.explorer.revealing || (shown[0] === sel.start && shown[1] === sel.end));
    if (!current) {
      this.index = this.firstFrom(sel.start);
      this.showForReplace(code, cx);
      return;
    }
    const [start, end] = shown, text = code.value(), value = this.replacement(text, start);
    code.set_selected_range({ start, end });
    code.replace(value);
    this.find();
    // The next match after the replaced text (a replacement that matches again isn't replaced twice).
    this.index = this.firstFrom(start + value.length);
    // The edit Replace just made, which mustn't end the stepping (see the explorer's change handler).
    this.ownText = code.value();
    if (this.index !== -1) this.showForReplace(code, cx);
    else { this.replaceStepping = false; cx.notify(); }
  }

  // The match to replace next, selected and drawn: the editor takes the keyboard, and Enter replaces it.
  showForReplace(code, cx) {
    this.stepping = false; this.replaceStepping = true;
    this.explorer.showRange(code, this.matches[this.index][0], this.matches[this.index][1], true, cx);
  }

  // Every match at once, in one edit, as VS Code: Herdr's editor can't group several edits into one
  // undo step, so the stretch from the first match to the last is typed over, and one Ctrl+Z undoes
  // it all. That undo selects the whole stretch; undoneAll turns it into a cursor at the first match.
  replaceAll(cx) {
    const code = this.explorer.activeCode();
    if (!code || !this.explorer.activeEditable()) return;
    const text = code.value(), query = this.input.value();
    let matches;
    try { matches = this.all(text, query, null, Infinity); } catch { return; }
    if (!matches.length) return;
    const from = matches[0][0], to = matches[matches.length - 1][1];
    const re = this.regex ? this.pattern(query) : null;
    let out = "", at = from;
    for (const [start, end] of matches) { out += text.slice(at, start) + this.replacement(text, start, re); at = end; }
    this.beforeAll = { code, text, at: from };
    code.set_selected_range({ start: from, end: to });
    code.replace(out);
    code.set_selected_range({ start: from, end: from });
    this.replaced = matches.length; this.replacedText = code.value();
    this.find();
    this.index = this.firstFrom(matches[0][0]);
    cx.notify();
  }

  // An edit of the file: if it brought back the text from before Replace All (its Ctrl+Z), the
  // stretch the undo selected becomes a cursor at the first match, once the editor has set it.
  undoneAll(code, cx) {
    const before = this.beforeAll;
    if (!before || before.code !== code || code.value() !== before.text) return;
    this.beforeAll = null;
    cx.timer.after(0, () => code.set_selected_range({ start: before.at, end: before.at }));
  }

  // The file was edited (typing, Ctrl+Z after a Replace): count again, once typing pauses. The
  // current match stays if it's still there, else the next one from the cursor.
  refresh(cx) {
    const code = this.explorer.activeCode();
    if (!this.open || !code) return;
    const before = this.matches[this.index];
    // "Replaced 12" stays only as long as the text Replace All left.
    if (this.replaced != null && code.value() !== this.replacedText) this.replaced = null;
    this.find();
    const same = before ? this.matches.findIndex(m => m[0] === before[0] && m[1] === before[1]) : -1;
    this.index = same !== -1 ? same : this.firstFrom(code.selected_range().start);
    cx.notify();
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
    const editable = this.explorer.activeEditable(), replacing = this.replacing && editable;
    const count = this.invalid ? "Invalid regex" : this.replaced != null ? `Replaced ${this.replaced}`
      : !query ? "" : !n ? "No results" : `${this.index + 1} of ${n}${n >= MAX_MATCHES ? "+" : ""}`;
    const button = (id, child, tip, on, click) => div().id(id).w(24).h(22).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_size(12).text_color(on ? t.foreground : t.muted).when(on, el => el.bg(t.selected))
      .hover(s => s.bg(on ? t.selected : t.hover).text_color(t.foreground)).tooltip(tip).on_click((_e, cx) => click(cx)).child(child);
    const icon = name => svg(`${this.explorer.modPath}/ui/${name}.svg`).size(14);
    const toggle = (field, child, tip) => button(`find-${field}`, child, tip, this[field], cx => {
      this[field] = !this[field];
      this.typed(cx);
    });
    const textButton = (id, label, tip, click) => div().id(id).h(22).px(8).flex_none().flex().items_center().rounded(4).cursor_pointer()
      .border_1().border_color(t.border).text_color(n ? t.foreground : t.dim).hover(s => s.bg(t.hover)).tooltip(tip)
      .on_click((_e, cx) => click(cx)).child(label);
    // Two columns, as VS Code's: the boxes (one width), and what goes with each.
    const findBox = h_flex().h(24).pl(6).pr(1).gap(1).items_center().rounded(5).border_1()
      .border_color(missing || this.invalid ? t.ansi1 : t.accent).bg(t.background)
      .child(Input.new(this.input).flex_1().min_w(0).h_full().text_color(t.foreground))
      .child(toggle("caseSensitive", "Aa", "Match case"))
      .child(toggle("wholeWord", icon("whole-word"), "Match whole word"))
      .child(toggle("regex", icon("regex"), "Use regular expression"));
    const replaceBox = h_flex().h(24).px(6).items_center().rounded(5).border_1()
      .border_color(this.replaceFocused ? t.accent : t.border).bg(t.background)
      .child(Input.new(this.replaceInput).flex_1().min_w(0).h_full().text_color(t.foreground));
    const findControls = h_flex().h(24).gap(6).items_center()
      .child(div().flex_none().min_w(64).text_color(this.invalid ? t.ansi1 : t.dim).child(count))
      .child(button("find-prev", "↑", "Previous match (Shift+F3)", false, cx => this.step(-1, cx)))
      .child(button("find-next", "↓", "Next match (F3)", false, cx => this.step(1, cx)))
      .child(button("find-close", svg(`${this.explorer.modPath}/ui/x.svg`).size(12), "Close (Escape)", false, cx => {
        this.hide(cx);
        this.explorer.activeCode()?.focus();
      }));
    const replaceControls = h_flex().h(24).gap(6).items_center()
      .child(textButton("find-replace", "Replace", "Replace (Enter)", cx => this.replaceOne(cx)))
      .child(textButton("find-replace-all", "Replace All", "Replace All (Ctrl+Alt+Enter)", cx => this.replaceAll(cx)));
    return h_flex().id("explorer-find").flex_none().px(12).py(5).gap(6).items_start().border_b(1).border_color(t.border).text_size(12)
      .when(editable, el => el.child(button("find-toggle-replace", icon(`chevron-${replacing ? "down" : "right"}`), "Toggle Replace (Ctrl+H)", false, cx => {
        this.replacing = !replacing;
        if (this.replacing) this.focusReplace(); else this.focusInput();
        cx.notify();
      }).mt(1)))
      .child(v_flex().flex_1().min_w(0).max_w(340).gap(4).child(findBox).when(replacing, el => el.child(replaceBox)))
      .child(v_flex().flex_none().gap(4).child(findControls).when(replacing, el => el.child(replaceControls)));
  }
}
