// Search in folder: the explorer panel's Search view, `git grep` results grouped by file. It runs on
// Enter, or as you type once typing pauses; results stay until the next run.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec } from "herdr";

const MAX_RESULTS = 2000, MAX_LINE = 300, ROW = 24, TYPING_PAUSE = 300, TYPING_MIN = 2;
// QuickJS's toLocaleString adds no separators.
const count = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// One per folder, kept in the explorer's per-folder snapshot like its tabs. `from`: the options a
// cleared search keeps (toggles and file filters), as VS Code's Clear does.
export function newSearch(scope = "", from = null) {
  return { text: "", query: "", caseSensitive: from?.caseSensitive ?? false, wholeWord: from?.wholeWord ?? false,
    regex: from?.regex ?? false, include: from?.include ?? "", exclude: from?.exclude ?? "", details: from?.details ?? false,
    scope, files: [], total: 0, running: false, queued: false, error: null, ran: false, folded: new Set(), selected: -1, seq: 0, version: 0 };
}

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The search as a JS regex, to mark matches in the lines git returns. Whole word as git's -w: no word
// character just before or after.
function matcher(s, query) {
  const source = s.regex ? query : escapeRegex(query);
  return new RegExp(s.wholeWord ? `(?<!\\w)(?:${source})(?!\\w)` : source, s.caseSensitive ? "g" : "gi");
}

// "*.js, src/lib" as VS Code reads it: a pattern without a slash matches at any depth; each one
// matches a file, or a folder and everything in it. Git's glob pathspecs, under `prefix` (the scope).
const escapeGlob = s => s.replace(/[*?[\]\\]/g, "\\$&");
function globs(list, magic, prefix = "") {
  return splitTop(list).flatMap(p => braces(p)).map(p => p.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "")).filter(Boolean)
    .flatMap(p => { const g = prefix + (p.includes("/") ? p : `**/${p}`); return [`:(${magic})${g}`, `:(${magic})${g}/**`]; });
}

// Commas outside braces: "*.{ts,tsx}, src" is two patterns.
function splitTop(list) {
  const out = [];
  let depth = 0, from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "{") depth++;
    else if (list[i] === "}") depth = Math.max(depth - 1, 0);
    else if (list[i] === "," && !depth) { out.push(list.slice(from, i)); from = i + 1; }
  }
  out.push(list.slice(from));
  return out;
}

// Git's glob pathspecs have no braces: "*.{ts,tsx}" becomes "*.ts" and "*.tsx" (nested ones too,
// up to 64 patterns). An unmatched brace stays as typed.
function braces(p, budget = { left: 64 }) {
  const open = p.indexOf("{");
  if (open === -1) return [p];
  let depth = 0, close = -1;
  for (let i = open; i < p.length && close === -1; i++) {
    if (p[i] === "{") depth++;
    else if (p[i] === "}" && --depth === 0) close = i;
  }
  if (close === -1) return [p];
  const head = p.slice(0, open), tail = p.slice(close + 1);
  return splitTop(p.slice(open + 1, close)).flatMap(o => (budget.left-- > 0 ? braces(head + o + tail, budget) : []));
}

// The text cut to a window around the first match (minified files have megabyte lines), with leading
// indentation dropped, and the matches inside that window.
function excerpt(text, re) {
  if (re) re.lastIndex = 0;
  const hit = re ? re.exec(text) : null, first = hit ? hit.index : -1;
  const indent = text.length - text.trimStart().length;
  const from = Math.max(indent, Math.min(Math.max(first, 0), text.length) - 60);
  const window = text.slice(from, from + MAX_LINE);
  const lead = from > indent ? 1 : 0;
  const shown = (lead ? "…" : "") + window + (from + MAX_LINE < text.length ? "…" : "");
  const marks = [];
  if (re) re.lastIndex = 0;
  for (let m = re ? re.exec(window) : null; m; m = re.exec(window)) {
    // An empty match (`^`, `a*`) marks nothing and must not stall.
    if (!m[0].length) { re.lastIndex++; continue; }
    marks.push([m.index + lead, m.index + lead + m[0].length]);
  }
  return { text: shown, marks, col: Math.max(first, 0) + 1, length: hit ? hit[0].length : 0 };
}

// git's -P needs a git built with PCRE; without it, -E (POSIX extended) is close enough.
let pcre = true;

export class FolderSearch {
  // `explorer` brings the folder (context), the per-folder state (search), icons and opening files.
  constructor(explorer, cx) {
    this.ex = explorer;
    this.input = InputState.new({ placeholder: "Search in folder" });
    this.input.on("change", (_e, cx) => {
      const s = this.ex.folderSearch;
      if (!s) return;
      s.text = this.input.value();
      if (s.text.trim().length >= TYPING_MIN && s.text !== s.query) this.later(cx);
    });
    this.input.on("submit", (_e, cx) => this.run(cx));
    this.input.on("focus", () => { this.inputFocused = true; });
    this.input.on("blur", () => { this.inputFocused = false; });
    this.inputFocused = false;
    // Files to include and to exclude (the "…" button): comma-separated globs.
    this.include = InputState.new({ placeholder: "files to include (e.g. *.ts, src/)" });
    this.exclude = InputState.new({ placeholder: "files to exclude" });
    for (const [input, field] of [[this.include, "include"], [this.exclude, "exclude"]]) {
      input.on("change", (_e, cx) => {
        const s = this.ex.folderSearch;
        if (!s || s[field] === input.value()) return;
        s[field] = input.value();
        if (s.ran) this.later(cx);
      });
      input.on("submit", (_e, cx) => this.run(cx));
    }
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.cache = null;
  }

  // From an event (Enter, a toggle, the scope's ×): its cx is gone once git answers, so the search
  // runs in a task with its own.
  run(cx) {
    cx.spawn(async cx => { await this.search(cx); });
  }

  // Typing, or a file filter edited: a search once typing pauses.
  later(cx) {
    const s = this.ex.folderSearch, typed = this.typed = (this.typed ?? 0) + 1;
    cx.timer.after(TYPING_PAUSE, cx => { if (this.typed === typed && this.ex.folderSearch === s) this.run(cx); });
  }

  // The pathspecs: the scope (literal: a folder named with [ * ? or a leading : is just a name), or
  // the files to include under it, then the files to exclude.
  pathspecs(s) {
    const include = globs(s.include, "glob", s.scope ? `${escapeGlob(s.scope)}/` : "");
    return [...(include.length ? include : s.scope ? [`:(literal)${s.scope}`] : []), ...globs(s.exclude, "glob,exclude")];
  }

  async search(cx) {
    const s = this.ex.folderSearch, context = this.ex.context, query = this.input.value();
    if (!s || !context) return;
    s.text = query;
    if (!query.trim()) return;
    if (!context.repo) { s.error = "Search in folder works inside a git repository"; s.version++; cx.notify(); return; }
    // exec can't be stopped: a search asked for meanwhile waits for this one, then the latest runs.
    if (s.running) { s.queued = true; return; }
    // git judges the pattern (PCRE takes (?i), a++ and more than JavaScript); one JavaScript can't
    // compile only goes unmarked in the results.
    let re = null;
    try { re = matcher(s, query); } catch {}
    const seq = ++s.seq;
    s.running = true; s.queued = false; s.error = null; s.query = query; s.version++;
    cx.notify();
    const grep = mode => ["--no-optional-locks", "grep", "-n", "-I", "--null", "--no-color", "--untracked",
      ...(s.caseSensitive ? [] : ["-i"]), ...(s.wholeWord ? ["-w"] : []), mode, "-e", query, "--", ...this.pathspecs(s)];
    const git = async mode => {
      try { return await exec("git", grep(mode), { cwd: context.root, on: context.on, timeout: 30000 }); }
      catch (e) { return { code: 2, stdout: "", stderr: String(e?.message ?? e) }; }
    };
    let r = await git(!s.regex ? "-F" : pcre ? "-P" : "-E");
    if (s.regex && pcre && r.code === 128 && /pcre/i.test(r.stderr ?? "")) { pcre = false; r = await git("-E"); }
    if (seq !== s.seq) return;
    // The results belong to their folder even if another one is shown now (a space switch): they're
    // there when it comes back. Only a search asked for meanwhile in this view runs next.
    s.running = false; s.ran = true; s.version++;
    if (s.queued) { s.queued = false; if (this.ex.folderSearch === s) this.run(cx); }
    // git grep: 1 is "no match".
    if (r.code > 1) {
      const line = (r.stderr || "git grep failed").trim().split("\n")[0];
      // "fatal: -e option, '(': missing closing parenthesis"
      s.error = s.regex && r.code === 128 && /^fatal: -e option/.test(line) ? `Invalid regular expression: ${line.slice(line.lastIndexOf(": ") + 2)}` : line;
      s.files = []; s.total = 0; cx.notify(); return;
    }
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
      lines.push({ line, ...excerpt(text, re) });
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
    this.ex.jumpTo(row.file.rel, row.hit.line, row.hit.col, row.hit.length, cx);
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

  // The boxes show the folder's search (a space switch, Clear).
  load(s) {
    this.input.set_value(s?.text ?? "");
    this.include.set_value(s?.include ?? "");
    this.exclude.set_value(s?.exclude ?? "");
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
    const summary = s.running ? "Searching…" : s.error ? s.error : !s.ran ? "Type to search the folder"
      : !s.total ? "No results"
      : s.total > shown ? `Showing the first ${count(shown)} of ${count(s.total)} results, in ${count(shownFiles)} files`
      : `${count(s.total)} result${s.total > 1 ? "s" : ""} in ${count(shownFiles)} file${shownFiles > 1 ? "s" : ""}`;
    // A search toggle re-runs a search already shown, or one being typed.
    const toggle = (field, tip, label) => h_flex().id(`search-${field}`).w(22).h(22).flex_none().items_center().justify_center().rounded(4)
      .cursor_pointer().text_size(12).text_color(s[field] ? t.foreground : t.muted).when(s[field], el => el.bg(t.selected))
      .hover(st => st.bg(s[field] ? t.selected : t.hover)).tooltip(tip)
      .on_click((_e, cx) => {
        s[field] = !s[field]; s.version++;
        if (field !== "details" && (s.ran || this.input.value().trim().length >= TYPING_MIN)) this.run(cx);
        else cx.notify();
      })
      .child(label.endsWith(".svg") ? svg(`${this.ex.modPath}/ui/${label}`).size(14) : label);
    const filter = (id, input, tip) => h_flex().id(id).h(26).px(6).items_center().rounded(5).border_1().border_color(t.border)
      .bg(t.background).text_size(12).tooltip(tip).child(Input.new(input).flex_1().min_w(0).h_full().text_color(t.foreground));
    const bar = v_flex().flex_none().px(8).py(6).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(4).items_center()
        .child(h_flex().flex_1().min_w(0).h(28).pl(6).pr(3).gap(2).items_center().rounded(5).border_1()
          .border_color(this.inputFocused ? t.accent : t.border).bg(t.background)
          .child(svg(`${this.ex.modPath}/ui/search.svg`).size(13).flex_none().text_color(t.dim).mr(4))
          .child(Input.new(this.input).flex_1().min_w(0).h_full().text_color(t.foreground))
          .child(toggle("caseSensitive", "Match case", "Aa"))
          .child(toggle("wholeWord", "Match whole word", "whole-word.svg"))
          .child(toggle("regex", "Use regular expression", "regex.svg")))
        .child(toggle("details", "Files to include and exclude", "ellipsis.svg")))
      .when(s.details, el => el
        .child(filter("search-include", this.include, "Comma-separated globs, such as *.ts, src/"))
        .child(filter("search-exclude", this.exclude, "Comma-separated globs, such as *.min.js, dist/")))
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
