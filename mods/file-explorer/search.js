// Search in folder: the explorer panel's Search view, `git grep` results grouped by file. It runs on
// Enter; results stay until the next run.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec } from "herdr";

const MAX_RESULTS = 2000, MAX_LINE = 300, ROW = 24;
// QuickJS's toLocaleString adds no separators.
const count = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// One per folder, kept in the explorer's per-folder snapshot like its tabs.
export function newSearch(scope = "") {
  return { text: "", query: "", caseSensitive: false, scope, files: [], total: 0, running: false, error: null,
    ran: false, folded: new Set(), selected: -1, seq: 0, version: 0 };
}

// The text cut to a window around the first match (minified files have megabyte lines), with leading
// indentation dropped, and the matches inside that window. Only the window is lowercased and searched;
// the first match is found with a case-insensitive regex instead of lowercasing the whole line.
function excerpt(text, needle, caseSensitive) {
  const find = caseSensitive ? needle : needle.toLowerCase();
  const first = !needle ? -1 : caseSensitive ? text.indexOf(needle)
    : text.search(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  const indent = text.length - text.trimStart().length;
  const from = Math.max(indent, Math.min(Math.max(first, 0), text.length) - 60);
  const window = text.slice(from, from + MAX_LINE), hay = caseSensitive ? window : window.toLowerCase();
  const lead = from > indent ? 1 : 0;
  const shown = (lead ? "…" : "") + window + (from + MAX_LINE < text.length ? "…" : "");
  const marks = [];
  for (let i = find ? hay.indexOf(find) : -1; i !== -1; i = hay.indexOf(find, i + find.length)) {
    if (i + find.length <= window.length) marks.push([i + lead, i + lead + find.length]);
  }
  return { text: shown, marks, col: Math.max(first, 0) + 1 };
}

export class FolderSearch {
  // `explorer` brings the folder (context), the per-folder state (search), icons and opening files.
  constructor(explorer, cx) {
    this.ex = explorer;
    this.input = InputState.new({ placeholder: "Search in folder" });
    this.input.on("change", () => { if (this.ex.folderSearch) this.ex.folderSearch.text = this.input.value(); });
    this.input.on("submit", (_e, cx) => this.run(cx));
    this.input.on("focus", () => { this.inputFocused = true; });
    this.input.on("blur", () => { this.inputFocused = false; });
    this.inputFocused = false;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.cache = null;
  }

  // From an event (Enter, Aa, the scope's ×): its cx is gone once git answers, so the search runs
  // in a task with its own.
  run(cx) {
    cx.spawn(async cx => { await this.search(cx); });
  }

  async search(cx) {
    const s = this.ex.folderSearch, context = this.ex.context, query = this.input.value();
    if (!s || !context) return;
    s.text = query;
    if (!query.trim()) return;
    if (!context.repo) { s.error = "Search in folder works inside a git repository"; s.version++; cx.notify(); return; }
    const seq = ++s.seq;
    s.running = true; s.error = null; s.query = query; s.version++;
    cx.notify();
    // --literal-pathspecs: a folder named with [ * ? or a leading : is just a name.
    const args = ["--no-optional-locks", "--literal-pathspecs", "grep", "-n", "-I", "--null", "--no-color", "--untracked",
      ...(s.caseSensitive ? [] : ["-i"]), "-F", "-e", query, "--", ...(s.scope ? [s.scope] : [])];
    let r;
    try { r = await exec("git", args, { cwd: context.root, on: context.on, timeout: 30000 }); }
    catch (e) { r = { code: 2, stdout: "", stderr: String(e?.message ?? e) }; }
    if (seq !== s.seq || this.ex.folderSearch !== s) return;
    s.running = false; s.ran = true; s.version++;
    // git grep: 1 is "no match".
    if (r.code > 1) { s.error = (r.stderr || "git grep failed").trim().split("\n")[0]; s.files = []; s.total = 0; cx.notify(); return; }
    const out = r.stdout ?? "", files = new Map();
    let total = 0;
    // Records are path\0line\0text\n; a cut-off last record (output limit) has no newline and is dropped.
    for (let pos = 0, nl = out.indexOf("\n"); nl !== -1; pos = nl + 1, nl = out.indexOf("\n", pos)) {
      if (++total > MAX_RESULTS) continue;
      const a = out.indexOf("\0", pos), b = a === -1 ? -1 : out.indexOf("\0", a + 1);
      if (a === -1 || b === -1 || b > nl) continue;
      const rel = out.slice(pos, a), line = Number(out.slice(a + 1, b));
      let text = out.slice(b + 1, nl);
      if (text.endsWith("\r")) text = text.slice(0, -1);
      let lines = files.get(rel);
      if (!lines) files.set(rel, lines = []);
      lines.push({ line, ...excerpt(text, query, s.caseSensitive) });
    }
    s.files = [...files].map(([rel, lines]) => ({ rel, lines }));
    s.total = total; s.folded = new Set(); s.selected = -1;
    cx.notify();
  }

  // Headers and lines in display order, rebuilt only when the results or the folding change.
  rows() {
    const s = this.ex.folderSearch;
    if (this.cache?.state === s && this.cache.version === s.version) return this.cache.rows;
    const rows = [];
    for (const f of s.files) {
      rows.push({ key: `f:${f.rel}`, file: f });
      if (!s.folded.has(f.rel)) for (const l of f.lines) rows.push({ key: `l:${f.rel}:${l.line}`, file: f, hit: l });
    }
    this.cache = { state: s, version: s.version, rows };
    return rows;
  }

  // `keep`: a double click keeps the tab, as in the tree; otherwise it's a preview.
  choose(row, cx, keep = false) {
    const s = this.ex.folderSearch;
    if (!row.hit) {
      if (s.folded.has(row.file.rel)) s.folded.delete(row.file.rel); else s.folded.add(row.file.rel);
      s.version++;
      cx.notify();
      return;
    }
    this.ex.open(row.file.rel, keep, cx);
    this.ex.jumpTo(row.file.rel, row.hit.line, row.hit.col, s.query.length, cx);
  }

  // Keys inside the search tab: Down from the box into the results, then arrows and Enter.
  key(e, cx) {
    const s = this.ex.folderSearch, rows = this.rows();
    if (this.inputFocused) {
      if (e.key !== "down" || !rows.length) return false;
      this.select(0, cx);
      this.handle.focus();
      return true;
    }
    if (!this.handle.is_focused()) return false;
    if (e.key === "down") this.select(Math.min(s.selected + 1, rows.length - 1), cx);
    else if (e.key === "up") { if (s.selected <= 0) this.input.focus(); else this.select(s.selected - 1, cx); }
    else if (e.key === "enter" && rows[s.selected]) this.choose(rows[s.selected], cx);
    else return false;
    return true;
  }

  select(i, cx) {
    this.ex.folderSearch.selected = i;
    this.scroll.scroll_to_item(i);
    cx.notify();
  }

  // Ctrl+Shift+F or Find in Folder…: the box gets the keyboard with its text selected.
  focusInput() {
    this.input.focus();
    const n = this.input.value().length;
    this.input.set_selected_range({ start: 0, end: n });
  }

  // The panel's Search view, under its header.
  render(t, font) {
    const s = this.ex.folderSearch, rows = this.rows();
    const shownFiles = s.files.length, shown = Math.min(s.total, MAX_RESULTS);
    const summary = s.running ? "Searching…" : s.error ? s.error : !s.ran ? "Enter searches the folder"
      : !s.total ? "No results"
      : s.total > shown ? `Showing the first ${count(shown)} of ${count(s.total)} results, in ${count(shownFiles)} files`
      : `${count(s.total)} result${s.total > 1 ? "s" : ""} in ${count(shownFiles)} file${shownFiles > 1 ? "s" : ""}`;
    const toggle = h_flex().id("search-case").w(24).h(22).flex_none().items_center().justify_center().rounded(4).cursor_pointer()
      .text_size(12).text_color(s.caseSensitive ? t.foreground : t.muted).when(s.caseSensitive, el => el.bg(t.selected))
      .hover(st => st.bg(s.caseSensitive ? t.selected : t.hover)).tooltip("Match case")
      .on_click((_e, cx) => { s.caseSensitive = !s.caseSensitive; s.version++; if (s.ran) this.run(cx); else cx.notify(); }).child("Aa");
    const bar = v_flex().flex_none().px(8).py(6).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().h(28).px(6).gap(6).items_center().rounded(5).border_1().border_color(this.inputFocused ? t.accent : t.border).bg(t.background)
        .child(svg(`${this.ex.modPath}/ui/search.svg`).size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().min_w(0).h_full().text_color(t.foreground))
        .child(toggle))
      .child(h_flex().gap(8).items_center().text_size(11).text_color(s.error ? t.ansi1 : t.dim)
        .when(Boolean(s.scope), el => el.child(h_flex().id("search-scope").h(20).pl(6).pr(2).gap(4).items_center().rounded(4).bg(t.chrome).text_color(t.muted)
          .child(`in ${s.scope}`)
          .child(div().id("search-scope-clear").w(16).h(16).flex().items_center().justify_center().rounded(3).cursor_pointer()
            .hover(st => st.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { s.scope = ""; s.version++; if (s.ran) this.run(cx); else cx.notify(); }).child("×"))))
        .child(div().flex_1().min_w(0).truncate().child(summary))
        .when(s.ran && !s.running, el => el.child(div().id("search-clear").flex_none().px(4).rounded(3).cursor_pointer().text_color(t.muted)
          .hover(st => st.bg(t.hover).text_color(t.foreground)).tooltip("Clear the results")
          .on_click((_e, cx) => this.ex.closeSearch(cx)).child("Clear"))));
    const line = (row, i) => {
      const selected = i === s.selected && this.handle.is_focused();
      if (!row.hit) {
        const rel = row.file.rel, slash = rel.lastIndexOf("/"), folded = s.folded.has(rel), icon = this.ex.icon(rel.slice(slash + 1), false, false, 14, t);
        return h_flex().h(ROW).px(8).gap(6).items_center().cursor_pointer().text_size(12).when(selected, el => el.bg(t.selected))
          .child(svg(`${this.ex.modPath}/ui/chevron-${folded ? "right" : "down"}.svg`).size(13).flex_none().text_color(t.muted))
          .when(Boolean(icon), el => el.child(icon))
          .child(div().flex_none().text_color(t.foreground).child(rel.slice(slash + 1)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(slash === -1 ? "" : rel.slice(0, slash)))
          .child(div().flex_none().px(6).rounded(8).bg(t.chrome).text_size(11).text_color(t.muted).child(String(row.file.lines.length)));
      }
      const parts = [], { text, marks } = row.hit;
      let at = 0;
      for (const [a, b] of marks) {
        if (a > at) parts.push(div().child(text.slice(at, a)));
        parts.push(div().bg(t.selection).text_color(t.foreground).child(text.slice(a, b)));
        at = b;
      }
      if (at < text.length) parts.push(div().child(text.slice(at)));
      return h_flex().h(ROW).pl(22).pr(8).gap(8).items_center().cursor_pointer().whitespace_nowrap().overflow_hidden()
        .font_family(font.family).text_size(Math.max(font.size - 1, 10)).text_color(t.muted).when(selected, el => el.bg(t.selected))
        .child(div().w(32).flex_none().text_color(t.dim).child(String(row.hit.line)))
        .child(h_flex().min_w(0).overflow_hidden().children(parts));
    };
    return v_flex().id("explorer-search").flex_1().min_h(0).min_w(0)
      .child(bar)
      .child(v_flex().id("search-results").flex_1().min_h(0).relative().track_focus(this.handle)
        .when(rows.length > 0, el => el.child(v_virtual_list("search-rows", rows.length, ROW, i => rows[i].key,
          range => rows.slice(range.start, range.end).map((row, k) => line(row, range.start + k)))
          .track_scroll(this.scroll).size_full()
          // A list's clicks come without a count: the same row twice within half a second is a double click.
          .on_item_click((key, cx) => {
            const i = rows.findIndex(r => r.key === key), now = Date.now();
            const double = this.lastClick?.key === key && now - this.lastClick.at < 500;
            this.lastClick = double ? null : { key, at: now };
            if (i === -1) return;
            s.selected = i;
            // A header's second click would fold it straight back.
            if (double && !rows[i].hit) return;
            this.choose(rows[i], cx, double);
          }))));
  }
}
