// Go to line in the open file. Herdr's editor exposes only its text and its selection; setting the
// selection scrolls to it, and draws it only while the editor has the keyboard.
import { div } from "gpui-kit";
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
