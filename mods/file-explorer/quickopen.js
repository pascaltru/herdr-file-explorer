// Quick Open (Ctrl+E): find a file of the space's repository by name, as in VS Code. This mod opened
// with mod.open (mod.json's overlay) draws it; a chosen file opens in the explorer panel.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { exec, props, closeOverlay, run, shared, setShared } from "herdr";
import { NAME, REQUEST } from "./menus.js";

export const RECENT_KEY = `${NAME}.recent`;
const MAX_RESULTS = 50, MAX_RECENT = 20, MAX_FILES = 200000, ROW = 30;

// Files opened in a repository, most recent first: what Quick Open shows before anything is typed.
export function remember(root, rel) {
  const all = { ...(shared(RECENT_KEY) ?? {}) };
  all[root] = [rel, ...(all[root] ?? []).filter(r => r !== rel)].slice(0, MAX_RECENT);
  setShared(RECENT_KEY, all);
}

const SEPARATOR = /[\\/._\-\s]/;

// `query` as an in-order subsequence of `text`, or null. Characters at word starts (after a
// separator, or a capital in camelCase) and in a row score higher, as in VS Code's file picker.
function match(query, text) {
  const lower = text.toLowerCase(), positions = [];
  let score = 0, from = 0, previous = -2;
  for (const ch of query) {
    const i = lower.indexOf(ch, from);
    if (i === -1) return null;
    score += 1;
    if (i === previous + 1) score += 5;
    if (i === 0 || SEPARATOR.test(text[i - 1]) || (text[i] !== lower[i] && text[i - 1] === lower[i - 1])) score += 8;
    positions.push(i);
    previous = i;
    from = i + 1;
  }
  // Scattered letters are a weak match: two points off per character skipped between the first and last.
  score -= 2 * (positions[positions.length - 1] - positions[0] + 1 - query.length);
  return { score, positions };
}

// The better of a file name match (favored a little, and a lot when the name starts with or contains
// the query) and a path match. Without the gap penalty, "srcap" ranked folder-src-tauri-open.svg's
// scattered letters above src/app.ts.
export function scoreFile(query, rel) {
  const slash = rel.lastIndexOf("/"), base = rel.slice(slash + 1), lowerBase = base.toLowerCase();
  const inBase = match(query, base), inPath = match(query, rel);
  if (!inBase && !inPath) return null;
  const baseScore = inBase ? 10 + inBase.score + (lowerBase.startsWith(query) ? 60 : lowerBase.includes(query) ? 30 : 0) - base.length * 0.1 : -Infinity;
  const pathScore = inPath ? inPath.score - rel.length * 0.05 : -Infinity;
  return baseScore >= pathScore
    ? { score: baseScore, positions: inBase.positions.map(p => p + slash + 1) }
    : { score: pathScore, positions: inPath.positions };
}

export class QuickOpen {
  // `view` is the explorer opened as this overlay: it brings location, roots and icons.
  constructor(view, cx) {
    this.view = view;
    this.files = null; this.root = null; this.on = null; this.message = "Loading files…";
    this.results = []; this.index = 0; this.last = { query: "", matches: null };
    this.input = InputState.new({ placeholder: "Search files by name" });
    this.input.on("change", (_e, cx) => { this.search(); cx.notify(); });
    this.input.on("submit", () => this.choose(this.results[this.index]?.rel));
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.input.focus();
    // The popup may take the keyboard after this runs; ask again once it's shown.
    cx.timer.after(100, () => this.input.focus());
    cx.spawn(async cx => { await this.load(); cx.notify(); });
  }

  async load() {
    const loc = this.view.currentLocation();
    if (!loc.cwd) { this.message = "No folder"; return; }
    const { root, repo } = await this.view.resolveRoot(loc.cwd, loc.on);
    if (!repo) { this.message = "Quick Open works in git repositories"; return; }
    this.root = root; this.on = loc.on;
    // Tracked files less those deleted on disk (tagged R), and untracked ones, ignored excluded.
    const r = await exec("git", ["--no-optional-locks", "ls-files", "-z", "-t", "-c", "-d", "-o", "--exclude-standard"], { cwd: root, on: loc.on, timeout: 60000 }).catch(e => ({ code: 1, stderr: String(e) }));
    if (r.code !== 0) { this.message = r.stderr || "Couldn't list the files"; return; }
    const items = r.stdout.split("\0"), removed = new Set(), files = [];
    for (const item of items) if (item.startsWith("R ")) removed.add(item.slice(2));
    for (const item of items) {
      if (!item || item.startsWith("R ") || item.startsWith("S ")) continue;
      const rel = item.slice(2);
      if (!removed.has(rel)) files.push(rel);
      if (files.length >= MAX_FILES) break;
    }
    this.files = [...new Set(files)];
    this.message = null;
    this.search();
  }

  search() {
    if (!this.files) return;
    const query = this.input.value().toLowerCase().replace(/\s+/g, "");
    this.index = 0;
    if (!query) {
      // Before typing: recently opened files that still exist, else the first files.
      const known = new Set(this.files), recent = ((shared(RECENT_KEY) ?? {})[this.root] ?? []).filter(r => known.has(r));
      this.results = (recent.length ? recent : [...this.files].sort().slice(0, MAX_RESULTS)).map(rel => ({ rel, positions: [] }));
      this.recent = recent.length > 0;
      this.last = { query: "", matches: null };
      return;
    }
    this.recent = false;
    // Typing on narrows the previous matches instead of scanning every file again.
    const pool = this.last.matches && query.startsWith(this.last.query) ? this.last.matches : this.files;
    const matches = [];
    for (const rel of pool) { const m = scoreFile(query, rel); if (m) matches.push({ rel, ...m }); }
    matches.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
    this.last = { query, matches: matches.map(m => m.rel) };
    this.results = matches.slice(0, MAX_RESULTS);
  }

  // Shows the panel and has the explorer open and reveal the file (see Explorer.handleRequest).
  choose(rel) {
    if (!rel) return;
    run("layout.select", { stack: "panel-body", child: "files" });
    run("layout.show", { id: "panel" });
    setShared(REQUEST, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), action: "reveal", rel, root: this.root });
    closeOverlay(props().overlay);
  }

  key(e, cx) {
    const n = this.results.length;
    if (e.key === "escape") closeOverlay(props().overlay);
    else if (e.key === "down" && n) this.index = (this.index + 1) % n;
    else if (e.key === "up" && n) this.index = (this.index + n - 1) % n;
    else return;
    this.scroll.scroll_to_item(this.index);
    cx.stop_propagation();
    cx.notify();
  }

  // The name with its matched characters in the accent color, then the folder, dimmed.
  label(result, t) {
    const { rel, positions } = result, slash = rel.lastIndexOf("/"), lit = new Set(positions), parts = [];
    let run_ = "", on = false;
    const flush = () => { if (run_) parts.push(div().when(on, el => el.text_color(t.accent).font_semibold()).child(run_)); run_ = ""; };
    for (let i = slash + 1; i < rel.length; i++) {
      if (lit.has(i) !== on) { flush(); on = lit.has(i); }
      run_ += rel[i];
    }
    flush();
    return h_flex().flex_1().min_w(0).gap(8).items_center()
      .child(h_flex().flex_none().children(parts))
      .when(slash > 0, el => el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(rel.slice(0, slash))));
  }

  render(t) {
    const rows = this.results.map((r, i) => h_flex().id(`qo-${r.rel}`).h(ROW).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .when(i === this.index, el => el.bg(t.selected)).hover(s => s.bg(i === this.index ? t.selected : t.hover))
      .on_click(() => this.choose(r.rel))
      .when(Boolean(this.view.icon(r.rel.slice(r.rel.lastIndexOf("/") + 1), false, false, 16, t)), el => el.child(this.view.icon(r.rel.slice(r.rel.lastIndexOf("/") + 1), false, false, 16, t)))
      .child(this.label(r, t)));
    const note = this.message ?? (this.recent ? "Recently opened" : !this.results.length ? "No matching files" : null);
    return v_flex().id("quick-open").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).p(10).gap(8).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(h_flex().h(34).flex_none().px(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_color(t.foreground)))
      .when(Boolean(note), el => el.child(div().px(10).text_size(11).text_color(t.dim).child(note)))
      .child(v_flex().id("quick-open-results").flex_1().min_h(0).overflow_y_scroll().track_scroll(this.scroll).gap(1).children(rows));
  }
}
