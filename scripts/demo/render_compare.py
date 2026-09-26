"""Render a side-by-side benchmark (two tools, same task, same agent) from two tab recordings made
with scripts/demo/peek-record.mjs, in the PawBrowse demo style.

Frames are the real captures at their real timestamps; the video plays at SPEED× and each clock shows
real elapsed time. Milestones tick when the tab's own URL shows them (e.g. results page, filter param),
so nothing is estimated.

    python3 scripts/demo/render_compare.py <config.json>
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
cfg = json.loads(Path(sys.argv[1]).read_text())
SPEED, FPS, HOLD = cfg.get("speed", 8), 15, 2600  # hold in video-ms at the end
W, H = 1536, 1000
BG, PANEL, EDGE = "#0b1119", "#111a26", "#1f2a38"
INK, MUTED, DIM = "#f1f5f9", "#8b98a9", "#4b5a6d"


def font(n, bold=False):
    for p in (["/System/Library/Fonts/Supplemental/Arial Bold.ttf"] if bold else []) + ["/System/Library/Fonts/Supplemental/Arial.ttf"]:
        if Path(p).exists():
            return ImageFont.truetype(p, n)
    return ImageFont.load_default(n)


def mono(n):
    p = "/System/Library/Fonts/Menlo.ttc"
    return ImageFont.truetype(p, n) if Path(p).exists() else ImageFont.load_default(n)


class Run:
    def __init__(self, c):
        self.c = c
        d = Path(c["dir"])
        self.start = int((d / "start.txt").read_text())
        self.end = int((d / "end.txt").read_text())
        frames = json.loads((d / "frames.json").read_text())
        self.frames = [(f["t"] - self.start, d / "frames" / f["file"], f["url"]) for f in frames]
        fin = Path(c["final_dir"]) / "frames"
        self.final = Image.open(sorted(fin.glob("*.jpg"))[-1]).convert("RGB") if fin.exists() else None
        self.elapsed = self.end - self.start
        # milestone times: first frame whose URL contains the marker
        self.miles = []
        for m in c["milestones"]:
            t = next((ts for ts, _, u in self.frames if 0 <= ts and m["url_has"] in u), None) if m.get("url_has") else self.elapsed
            self.miles.append((m["name"], t if t is not None else self.elapsed))
        self.cache = {}

    def frame_at(self, t):
        if t >= self.elapsed and self.final is not None:
            return self.final
        cand = [p for ts, p, _ in self.frames if ts <= t] or [self.frames[0][1]]
        p = cand[-1]
        if p not in self.cache:
            self.cache = {p: Image.open(p).convert("RGB")}
        return self.cache[p]


runs = [Run(c) for c in cfg["runs"]]
longest = max(r.elapsed for r in runs)
total = round((longest / SPEED + HOLD) * FPS / 1000)
out = Path(cfg["out_dir"]) / "compare-frames"
if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)
paw = Image.open(ROOT / "extension/icons/icon-128.png").convert("RGBA").resize((30, 30), Image.LANCZOS)

COLW, GAP, X0 = 724, 16, 36
PW = COLW
for i in range(total):
    t = i * 1000 / FPS * SPEED  # real ms
    c = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(c)
    c.paste(paw, (36, 22), paw)
    d.text((76, 24), "PawBrowse", font=font(23, True), fill=INK)
    d.text((76 + d.textlength("PawBrowse", font=font(23, True)) + 10, 27), "benchmark", font=font(19), fill=MUTED)
    badge = f"REAL CHROME  ·  {SPEED}× SPEED  ·  CLOCKS IN REAL TIME"
    bw = d.textlength(badge, font=font(13, True)) + 36
    d.rounded_rectangle((W - 36 - bw, 22, W - 36, 54), radius=16, outline="#22c55e", width=2)
    d.text((W - 36 - bw + 18, 31), badge, font=font(13, True), fill="#22c55e")
    d.text((36, 70), cfg["title"], font=font(36, True), fill=INK)
    d.text((38, 118), cfg["subtitle"], font=font(18), fill=MUTED)

    for k, r in enumerate(runs):
        x = X0 + k * (COLW + GAP)
        col = r.c["color"]
        tt = min(t, r.elapsed)
        done = t >= r.elapsed
        d.text((x, 160), r.c["name"], font=font(24, True), fill=col)
        clock = f"{tt / 1000:6.1f} s"
        d.text((x + COLW - d.textlength(clock, font=mono(30)), 156), clock, font=mono(30), fill=INK if not done else col)
        # frame
        fy = 202
        img = r.frame_at(tt)
        ph = round(img.height * PW / img.width)
        ph = min(ph, 520)
        d.rounded_rectangle((x - 1, fy - 1, x + PW + 1, fy + ph + 1), radius=10, fill=PANEL, outline=EDGE)
        c.paste(img.resize((PW, round(img.height * PW / img.width)), Image.LANCZOS).crop((0, 0, PW, ph)), (x, fy))
        # checklist
        cy = fy + ph + 22
        for j, (name, mt) in enumerate(r.miles):
            y = cy + j * 34
            ok = tt >= mt
            if ok:
                d.ellipse((x, y, x + 22, y + 22), fill=col)
                d.line([(x + 6, y + 11), (x + 10, y + 15), (x + 17, y + 7)], fill=BG, width=3)
            else:
                d.ellipse((x, y, x + 22, y + 22), outline=DIM, width=2)
            d.text((x + 34, y), name, font=font(19, ok), fill=INK if ok else MUTED)
            if ok:
                ts = f"{mt / 1000:.1f} s"
                d.text((x + COLW - d.textlength(ts, font=mono(15)), y + 3), ts, font=mono(15), fill=MUTED)
        # result box
        by = cy + len(r.miles) * 34 + 10
        d.rounded_rectangle((x, by, x + COLW, by + 86), radius=10, fill=PANEL if not done else "#0f2a1c" if k == 0 else "#2a1a12", outline=EDGE if not done else col)
        if done:
            d.text((x + 16, by + 12), f"Done in {r.elapsed / 1000:.1f} s", font=font(22, True), fill=col)
            d.text((x + 16, by + 46), r.c["result"], font=font(16), fill=INK)
        else:
            d.text((x + 16, by + 30), "working…", font=font(18), fill=DIM)

    d.line((36, 944, 1500, 944), fill=EDGE, width=2)
    d.line((36, 944, 36 + 1464 * min(1, t / longest), 944), fill="#22c55e", width=3)
    d.text((36, 956), cfg["footnote"], font=font(13), fill=MUTED)
    d.text((36, 974), cfg["footnote2"], font=font(13), fill=MUTED)
    c.save(out / f"{i:05d}.png")

dest = ROOT / "assets"
c.save(dest / "benchmark-result.png")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(out / "%05d.png"), "-c:v", "libx264",
                "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", str(dest / "benchmark.mp4")], check=True)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(dest / "benchmark.mp4"), "-vf",
                "fps=10,scale=1152:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
                "-loop", "0", str(dest / "benchmark.gif")], check=True)
print("rendered", total, "frames ->", dest / "benchmark.gif")
