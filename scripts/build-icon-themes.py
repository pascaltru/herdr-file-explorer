"""Builds mods/file-explorer/icon-themes/ from upstream sources.

  seti      VS Code's default file icons (theme-seti, MIT). The icon font's glyphs become SVGs,
            tinted at run time with Seti's color for each file type.
  material  Material Icon Theme (MIT), from its npm package: full-color SVGs.
  languages.json  VS Code's built-in language table (file extensions and names to language ids),
            which both themes use for files they map by language.

The versions come from icon-themes/versions.json. To update one source, pass its new version;
the file is rewritten with it, so the commit shows what changed:
  python scripts/build-icon-themes.py                      rebuild both at the pinned versions
  python scripts/build-icon-themes.py --material 5.41.0    update Material only
  python scripts/build-icon-themes.py --vscode 1.147.0     update Seti and languages.json only
  python scripts/build-icon-themes.py --only seti          rebuild one theme at its pinned version
Needs git and network access.
"""
import argparse, io, json, os, shutil, struct, subprocess, sys, tarfile, tempfile, urllib.request, zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "mods", "file-explorer", "icon-themes")


def lower_keys(m):
    return {k.lower(): v for k, v in (m or {}).items()}


# --- VS Code sources -------------------------------------------------------------------

def fetch_vscode(ref, tmp):
    repo = os.path.join(tmp, "vscode")
    run = lambda *a: subprocess.run(a, cwd=repo if os.path.isdir(repo) else tmp, check=True, capture_output=True)
    run("git", "clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", "--branch", ref, "https://github.com/microsoft/vscode", repo)
    run("git", "sparse-checkout", "set", "--no-cone", "/extensions/theme-seti/", "/extensions/*/package.json", "/LICENSE.txt")
    sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
    return repo, sha


def build_languages(repo, sha):
    exts, names = {}, {}
    base = os.path.join(repo, "extensions")
    for ext in sorted(os.listdir(base)):
        p = os.path.join(base, ext, "package.json")
        if not os.path.isfile(p):
            continue
        for lang in json.load(open(p, encoding="utf-8")).get("contributes", {}).get("languages", []):
            for e in lang.get("extensions", []):
                exts.setdefault(e.lower().lstrip("."), lang["id"])
            for n in lang.get("filenames", []):
                names.setdefault(n.lower(), lang["id"])
    data = {"source": f"microsoft/vscode@{sha} extensions/*/package.json (MIT)", "extensions": exts, "fileNames": names}
    json.dump(data, open(os.path.join(OUT, "languages.json"), "w", encoding="utf-8"), separators=(",", ":"))
    shutil.copy(os.path.join(repo, "LICENSE.txt"), os.path.join(OUT, "LICENSE-vscode.txt"))
    print(f"languages: {len(exts)} extensions, {len(names)} file names")


# --- TrueType glyphs to SVG ------------------------------------------------------------

def woff_tables(data):
    num = struct.unpack(">H", data[12:14])[0]
    out = {}
    for i in range(num):
        tag, off, comp, orig, _ = struct.unpack(">4sIIII", data[44 + 20 * i:64 + 20 * i])
        raw = data[off:off + comp]
        out[tag.decode()] = zlib.decompress(raw) if comp < orig else raw
    return out


def cmap_format4(cmap):
    n = struct.unpack(">H", cmap[2:4])[0]
    for i in range(n):
        pid, eid, off = struct.unpack(">HHI", cmap[4 + 8 * i:12 + 8 * i])
        if (pid, eid) == (3, 1) and struct.unpack(">H", cmap[off:off + 2])[0] == 4:
            seg = struct.unpack(">H", cmap[off + 6:off + 8])[0] // 2
            arr = lambda k: struct.unpack(f">{seg}H", cmap[off + 14 + k * 2 * seg + (2 if k else 0):][:2 * seg])
            ends, starts = arr(0), arr(1)
            deltas = struct.unpack(f">{seg}h", cmap[off + 16 + 4 * seg:][:2 * seg])
            ro_at = off + 16 + 6 * seg
            ros = struct.unpack(f">{seg}H", cmap[ro_at:ro_at + 2 * seg])
            out = {}
            for s in range(seg):
                for c in range(starts[s], ends[s] + 1):
                    if c == 0xFFFF:
                        continue
                    if ros[s] == 0:
                        g = (c + deltas[s]) & 0xFFFF
                    else:
                        at = ro_at + 2 * s + ros[s] + 2 * (c - starts[s])
                        g = struct.unpack(">H", cmap[at:at + 2])[0]
                        g = (g + deltas[s]) & 0xFFFF if g else 0
                    out[c] = g
            return out
    raise SystemExit("seti.woff: no Windows Unicode (3,1) format 4 cmap")


def glyph_contours(glyf, loca, gid):
    start, end = loca[gid], loca[gid + 1]
    if start == end:
        return []
    g = glyf[start:end]
    n = struct.unpack(">h", g[0:2])[0]
    if n < 0:  # composite: components placed at x/y offsets
        contours, p = [], 10
        while True:
            flags, sub = struct.unpack(">HH", g[p:p + 4]); p += 4
            if flags & 1:
                dx, dy = struct.unpack(">hh", g[p:p + 4]); p += 4
            else:
                dx, dy = struct.unpack(">bb", g[p:p + 2]); p += 2
            if flags & 8: p += 2
            elif flags & 0x40: p += 4
            elif flags & 0x80: p += 8
            for c in glyph_contours(glyf, loca, sub):
                contours.append([(x + dx, y + dy, on) for x, y, on in c])
            if not flags & 0x20:
                return contours
    ends = struct.unpack(f">{n}H", g[10:10 + 2 * n])
    p = 10 + 2 * n
    p += 2 + struct.unpack(">H", g[p:p + 2])[0]
    count = ends[-1] + 1
    flags = []
    while len(flags) < count:
        f = g[p]; p += 1
        flags.append(f)
        if f & 8:
            flags.extend([f] * g[p]); p += 1
    def coords(short, same):
        vals, v = [], 0
        nonlocal p
        for f in flags[:count]:
            if f & short:
                d = g[p]; p += 1
                v += d if f & same else -d
            elif not f & same:
                v += struct.unpack(">h", g[p:p + 2])[0]; p += 2
            vals.append(v)
        return vals
    xs, ys = coords(2, 16), coords(4, 32)
    pts = [(xs[i], ys[i], bool(flags[i] & 1)) for i in range(count)]
    out, s = [], 0
    for e in ends:
        out.append(pts[s:e + 1]); s = e + 1
    return out


def contour_path(c, flip):
    """Quadratic TrueType contour to an SVG path; consecutive off-curve points imply an on-curve midpoint."""
    if not c:
        return ""
    pts = [(x, flip(y), on) for x, y, on in c]
    start = next((i for i, p in enumerate(pts) if p[2]), None)
    if start is None:  # all off-curve: start at the midpoint of the first two
        a, b = pts[0], pts[1]
        pts = [((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, True)] + pts
        start = 0
    pts = pts[start:] + pts[:start]
    fmt = lambda v: f"{v:g}"
    d = [f"M{fmt(pts[0][0])} {fmt(pts[0][1])}"]
    i, n = 1, len(pts)
    while i <= n:
        p = pts[i % n]
        if p[2]:
            d.append(f"L{fmt(p[0])} {fmt(p[1])}"); i += 1
        else:
            q = pts[(i + 1) % n]
            end = (q[0], q[1]) if q[2] else ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
            d.append(f"Q{fmt(p[0])} {fmt(p[1])} {fmt(end[0])} {fmt(end[1])}")
            i += 2 if q[2] else 1
    return "".join(d) + "Z"


def build_seti(repo, sha):
    src = os.path.join(repo, "extensions", "theme-seti", "icons")
    theme = json.load(open(os.path.join(src, "vs-seti-icon-theme.json"), encoding="utf-8"))
    t = woff_tables(open(os.path.join(src, "seti.woff"), "rb").read())
    upm = struct.unpack(">H", t["head"][18:20])[0]
    asc = struct.unpack(">h", t["hhea"][4:6])[0]
    long_loca = struct.unpack(">h", t["head"][50:52])[0] == 1
    loca = struct.unpack(f">{len(t['loca']) // 4}I", t["loca"]) if long_loca else [v * 2 for v in struct.unpack(f">{len(t['loca']) // 2}H", t["loca"])]
    cmap = cmap_format4(t["cmap"])
    dest = os.path.join(OUT, "seti")
    shutil.rmtree(dest, ignore_errors=True); os.makedirs(os.path.join(dest, "icons"))
    icons, written = {}, set()
    for name, d in theme["iconDefinitions"].items():
        code = int(d["fontCharacter"].lstrip("\\"), 16)
        file = f"icons/{code:04x}.svg"
        if code not in written:
            contours = glyph_contours(t["glyf"], loca, cmap[code])
            path = "".join(contour_path(c, lambda y: asc - y) for c in contours)
            # VS Code draws Seti at 150% of the text size; cropping the em box to 2/3 matches it.
            crop = upm / 1.5; inset = (upm - crop) / 2
            svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{inset:g} {inset:g} {crop:g} {crop:g}"><path fill="currentColor" d="{path}"/></svg>'
            open(os.path.join(dest, file), "w").write(svg)
            written.add(code)
        icons[name] = {"svg": file, "color": d.get("fontColor")}
    light = theme.get("light", {})
    out = {
        "label": "Seti (VS Code default)", "source": f"microsoft/vscode@{sha} extensions/theme-seti", "render": "glyph",
        # VS Code's default theme draws folders with arrows only.
        "folders": False, "icons": icons, "file": theme.get("file"),
        "fileNames": lower_keys(theme.get("fileNames")), "fileExtensions": lower_keys(theme.get("fileExtensions")),
        "languageIds": theme.get("languageIds", {}),
        "light": {"fileNames": lower_keys(light.get("fileNames")), "fileExtensions": lower_keys(light.get("fileExtensions")),
                  "languageIds": light.get("languageIds", {}), "file": light.get("file")},
    }
    json.dump(out, open(os.path.join(dest, "theme.json"), "w", encoding="utf-8"), separators=(",", ":"))
    shutil.copy(os.path.join(repo, "extensions", "theme-seti", "ThirdPartyNotices.txt"), os.path.join(dest, "LICENSE-seti.txt"))
    print(f"seti: {len(icons)} icons, {len(written)} glyphs")


# --- Material Icon Theme ---------------------------------------------------------------

def build_material(version):
    url = f"https://registry.npmjs.org/material-icon-theme/-/material-icon-theme-{version}.tgz"
    tar = tarfile.open(fileobj=io.BytesIO(urllib.request.urlopen(url).read()), mode="r:gz")
    files = {m.name: m for m in tar.getmembers() if m.isfile()}
    theme = json.load(tar.extractfile(files["package/dist/material-icons.json"]))
    dest = os.path.join(OUT, "material")
    shutil.rmtree(dest, ignore_errors=True); os.makedirs(os.path.join(dest, "icons"))
    for name, m in files.items():
        if name.startswith("package/icons/") and name.endswith(".svg") and "/" not in name[len("package/icons/"):]:
            open(os.path.join(dest, "icons", os.path.basename(name)), "wb").write(tar.extractfile(m).read())
    open(os.path.join(dest, "LICENSE-material-icon-theme.txt"), "wb").write(tar.extractfile(files["package/LICENSE"]).read())
    icons = {k: "icons/" + v["iconPath"].split("/")[-1] for k, v in theme["iconDefinitions"].items()}
    section = lambda s: {"fileNames": lower_keys(s.get("fileNames")), "fileExtensions": lower_keys(s.get("fileExtensions")),
                         "folderNames": lower_keys(s.get("folderNames")), "folderNamesExpanded": lower_keys(s.get("folderNamesExpanded")),
                         "languageIds": s.get("languageIds", {})}
    out = {"label": "Material Icon Theme", "source": f"material-icon-theme@{version} (npm)", "render": "image", "folders": True,
           "icons": icons, "file": theme["file"], "folder": theme["folder"], "folderExpanded": theme["folderExpanded"],
           **section(theme), "light": {**section(theme.get("light", {})), "file": theme.get("light", {}).get("file")}}
    json.dump(out, open(os.path.join(dest, "theme.json"), "w", encoding="utf-8"), separators=(",", ":"))
    print(f"material {version}: {len(icons)} icons")


def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("--only", choices=["seti", "material"], help="seti also rebuilds languages.json")
    a.add_argument("--vscode", help="VS Code release tag for Seti and languages.json, e.g. 1.146.0")
    a.add_argument("--material", help="material-icon-theme npm version, e.g. 5.40.0")
    args = a.parse_args()
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "versions.json")
    versions = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    if args.vscode: versions["vscode"] = args.vscode
    if args.material: versions["material"] = args.material
    # A version given on the command line selects that source alone, so updating one never moves the other.
    only = args.only or ("seti" if args.vscode and not args.material else "material" if args.material and not args.vscode else None)
    missing = [k for k, t in (("vscode", "seti"), ("material", "material")) if only in (None, t) and not versions.get(k)]
    if missing:
        raise SystemExit(f"no version for {', '.join(missing)}: pass --{missing[0]} or add it to {path}")
    tmp = tempfile.mkdtemp(prefix="icon-themes-")
    try:
        if only in (None, "seti"):
            repo, sha = fetch_vscode(versions["vscode"], tmp)
            sha = f"{versions['vscode']} ({sha})"
            build_languages(repo, sha)
            build_seti(repo, sha)
        if only in (None, "material"):
            build_material(versions["material"])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(versions, indent=2) + "\n")


if __name__ == "__main__":
    sys.exit(main())
