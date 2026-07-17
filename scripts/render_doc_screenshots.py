from pathlib import Path
from textwrap import wrap

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "evidence"
OUT = ROOT / "docs" / "assets" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)

PANELS = [
    ("01-dashboard-scope.txt", "Dashboard Scope", "01-dashboard-scope.png"),
    ("02-synthetic-load.txt", "Synthetic Load Generation", "02-synthetic-load.png"),
    ("03-log-analysis.txt", "MongoDB Log Analysis", "03-log-analysis.png"),
    ("04-performance-checking.txt", "Performance Checking", "04-performance-checking.png"),
    ("05-bottlenecks.txt", "Memory and Storage Bottlenecks", "05-bottlenecks.png"),
    ("06-profiler-slow-query.txt", "Profiler and Slow Query", "06-profiler-slow-query.png"),
    ("07-dashboard-runner.txt", "Dashboard Runner Model", "07-dashboard-runner.png"),
    ("08-docker-run.txt", "Docker Run", "08-docker-run.png"),
]


def load_font(name, size):
    path = Path("C:/Windows/Fonts") / name
    if path.exists():
        return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


TITLE = load_font("segoeuib.ttf", 34)
META = load_font("segoeui.ttf", 18)
BODY = load_font("consola.ttf", 20)


def render(source, title, image_name):
    text = (EVIDENCE / source).read_text(encoding="utf-8", errors="replace")
    lines = []
    for line in text.splitlines():
        if not line.strip():
            lines.append("")
        else:
            lines.extend(wrap(line, width=105, replace_whitespace=False, drop_whitespace=False) or [""])

    width = 1480
    header_h = 108
    line_h = 31
    height = header_h + 78 + max(1, len(lines)) * line_h
    img = Image.new("RGB", (width, height), "#f6f8fb")
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, width, header_h), fill="#123b63")
    draw.text((34, 24), title, fill="white", font=TITLE)
    draw.text((36, 72), f"source: performance-all-round/evidence/{source}", fill="#cfe7ff", font=META)
    draw.rounded_rectangle((28, header_h + 24, width - 28, height - 26), radius=12, fill="#0f172a", outline="#d8e2ef", width=2)

    y = header_h + 50
    for line in lines:
        color = "#e5edf8"
        if line.startswith("-"):
            color = "#dbeafe"
        if any(token in line for token in ["db.", "sudo", "docker", "mongostat", "mongotop", "server.js"]):
            color = "#9ee8c9"
        if any(token in line for token in ["COLLSCAN", "IXSCAN", "slow", "Bottleneck", "Profiler"]):
            color = "#facc15"
        draw.text((54, y), line, fill=color, font=BODY)
        y += line_h

    img.save(OUT / image_name, quality=95)


for panel in PANELS:
    render(*panel)

print(f"Rendered {len(PANELS)} screenshots to {OUT}")
