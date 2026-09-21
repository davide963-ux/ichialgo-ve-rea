"""
Client-facing strategy document.

Every number here is read from the live configuration files rather than typed
in, so the document cannot drift from what the system actually does.
"""
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    KeepTogether,
)

REPO = Path(__file__).resolve().parent.parent

# ── Pull the real numbers out of the config ──────────────────────────────
conf = (REPO / "src/config/confluence.ts").read_text()
scan = (REPO / "server/scannerCore.ts").read_text()


def num(text, key):
    m = re.search(rf"\b{key}:\s*([0-9.]+)", text)
    if not m:
        raise SystemExit(f"could not read {key}")
    return float(m.group(1))


EMA = int(num(conf, "emaPeriod"))
ATR = int(num(conf, "atrPeriod"))
WATCH = int(num(conf, "watch"))
ACTIONABLE = int(num(conf, "actionable"))
STRONG = int(num(conf, "strong"))
MIN_STOP = int(num(conf, "minStopPips"))
DEEP = num(conf, "deepPct")
SHALLOW = num(conf, "shallowPct")
EXPIRY = int(num(scan, "expiryDays"))
COOLDOWN = int(num(scan, "cooldownHours"))

targets = re.search(r"targetR:\s*\[([^\]]+)\]", conf).group(1)
R1, R2, R3 = [float(x) for x in targets.split(",")]

pairs = re.search(r"symbols:\s*\[([^\]]+)\]", scan).group(1)
PAIRS = [p.strip().strip("'") for p in pairs.split(",")]
tfs = re.search(r"timeframes:\s*\[([^\]]+)\]", scan).group(1)
TFS = [t.strip().strip("'") for t in tfs.split(",")]
BIAS_TF = re.search(r"biasTimeframe:\s*'([^']+)'", scan).group(1)
hours = re.search(r"sessionHours:\s*\[(\d+),\s*(\d+)\]", scan)
H_FROM, H_TO = int(hours.group(1)), int(hours.group(2))

# ── Palette ──────────────────────────────────────────────────────────────
INK = colors.HexColor("#111827")
MUTED = colors.HexColor("#6B7280")
LINE = colors.HexColor("#E5E7EB")
ACCENT = colors.HexColor("#0F766E")
SOFT = colors.HexColor("#F9FAFB")
RED = colors.HexColor("#B91C1C")

PAGE_W, PAGE_H = A4
MARGIN = 20 * mm

styles = getSampleStyleSheet()
S = {
    "h1": ParagraphStyle("h1", parent=styles["Normal"], fontName="Helvetica-Bold",
                         fontSize=22, leading=26, textColor=INK, spaceAfter=2),
    "sub": ParagraphStyle("sub", parent=styles["Normal"], fontName="Helvetica",
                          fontSize=10.5, leading=15, textColor=MUTED, spaceAfter=14),
    "h2": ParagraphStyle("h2", parent=styles["Normal"], fontName="Helvetica-Bold",
                         fontSize=12, leading=15, textColor=ACCENT,
                         spaceBefore=15, spaceAfter=6),
    "body": ParagraphStyle("body", parent=styles["Normal"], fontName="Helvetica",
                           fontSize=10, leading=14.5, textColor=INK,
                           alignment=TA_LEFT, spaceAfter=6),
    "cell": ParagraphStyle("cell", parent=styles["Normal"], fontName="Helvetica",
                           fontSize=9.5, leading=13, textColor=INK),
    "cellb": ParagraphStyle("cellb", parent=styles["Normal"], fontName="Helvetica-Bold",
                            fontSize=9.5, leading=13, textColor=INK),
    "note": ParagraphStyle("note", parent=styles["Normal"], fontName="Helvetica",
                           fontSize=8.5, leading=12, textColor=MUTED),
    "disc": ParagraphStyle("disc", parent=styles["Normal"], fontName="Helvetica",
                           fontSize=8.5, leading=12, textColor=RED),
}

P = lambda t, s="body": Paragraph(t, S[s])


def rule_table(rows, widths):
    """A clean two-column table with hairline separators."""
    data = [[P(a, "cellb"), P(b, "cell")] for a, b in rows]
    t = Table(data, colWidths=widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, LINE),
    ]))
    return t


def step_table(steps):
    """Numbered gate list — the conditions, in the order they are tested."""
    data = []
    for i, (title, detail) in enumerate(steps, 1):
        data.append([
            P(f"<font color='#0F766E'><b>{i}</b></font>", "cellb"),
            P(f"<b>{title}</b><br/><font color='#6B7280'>{detail}</font>", "cell"),
        ])
    t = Table(data, colWidths=[10 * mm, None], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, LINE),
    ]))
    return t


def grid(headers, rows, widths, highlight_col=None):
    data = [[P(h, "cellb") for h in headers]] + [[P(c, "cell") for c in r] for r in rows]
    t = Table(data, colWidths=widths, hAlign="LEFT", repeatRows=1)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("BACKGROUND", (0, 0), (-1, 0), SOFT),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, LINE),
        ("LINEBELOW", (0, 1), (-1, -2), 0.4, LINE),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
    ]
    if highlight_col is not None:
        style.append(("FONTNAME", (highlight_col, 1), (highlight_col, -1), "Helvetica-Bold"))
    t.setStyle(TableStyle(style))
    return t


def decorate(canvas, doc):
    canvas.saveState()
    # Header rule
    canvas.setStrokeColor(ACCENT)
    canvas.setLineWidth(2)
    canvas.line(MARGIN, PAGE_H - 14 * mm, PAGE_W - MARGIN, PAGE_H - 14 * mm)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.setFillColor(ACCENT)
    canvas.drawString(MARGIN, PAGE_H - 12 * mm, "ICHIALGO")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 12 * mm, "Signal Methodology")
    # Footer
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, 14 * mm, PAGE_W - MARGIN, 14 * mm)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN, 10 * mm, "Not investment advice.")
    canvas.drawRightString(PAGE_W - MARGIN, 10 * mm, f"Page {doc.page}")
    canvas.restoreState()


OUT = REPO / "docs" / "Ichialgo-Signal-Methodology.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

doc = BaseDocTemplate(
    str(OUT), pagesize=A4,
    leftMargin=MARGIN, rightMargin=MARGIN,
    topMargin=22 * mm, bottomMargin=20 * mm,
    title="Ichialgo — Signal Methodology",
    author="Ichialgo",
    subject="Ichimoku + EMA50 confluence strategy",
)
frame = Frame(MARGIN, 20 * mm, PAGE_W - 2 * MARGIN, PAGE_H - 42 * mm, id="body")
doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=decorate)])

story = []

# ── Title ────────────────────────────────────────────────────────────────
story += [
    P("Signal Methodology", "h1"),
    P("Ichimoku + EMA 50 confluence. How a signal is produced, and what each position risks.", "sub"),
]

# ── The strategy ─────────────────────────────────────────────────────────
story += [
    P("The Strategy", "h2"),
    P("We trade <b>pullbacks within an established trend</b> — never breakouts, never reversals.", "body"),
    P(f"A trend is identified using the EMA {EMA} and the Ichimoku cloud. We then wait for price to "
      f"retrace into the zone where the EMA {EMA} and the Ichimoku baseline (Kijun-sen) meet, and we "
      f"enter only once price has visibly rejected that zone.", "body"),
    P("Two independent methods marking the same price level is the setup. Everything else is a filter.", "body"),
]

# ── Conditions ───────────────────────────────────────────────────────────
story += [
    P("Conditions For A Signal", "h2"),
    P("All six must hold. Failing any one produces no signal.", "body"),
    step_table([
        ("Tradeable market",
         "Rejected if the market is choppy, or too volatile, or already overextended."),
        ("Established trend",
         f"EMA {EMA} sloping, price on the correct side of the cloud, and the cloud is thick enough to matter."),
        ("Market structure agrees",
         "Higher highs and higher lows for a long; the reverse for a short."),
        ("Confluence zone",
         f"EMA {EMA} and Kijun-sen close together, ideally backed by the cloud edge."),
        ("Valid pullback",
         f"Price retraces {int(SHALLOW*100)}–{int(DEEP*100)}% of the last move into that zone. "
         f"A full retracement invalidates the setup."),
        ("Price-action confirmation",
         "A <b>closed</b> candle rejects the zone. No entry is taken on an unfinished candle."),
    ]),
]

# ── Grading ──────────────────────────────────────────────────────────────
story += [
    P("Signal Grades", "h2"),
    P("Every signal carries a confidence score from 0 to 100, built only from conditions that were "
      "actually measured.", "body"),
    grid(
        ["Grade", "Score", "Meaning"],
        [
            ["STRONG", f"{STRONG}+", "All conditions aligned"],
            ["LONG / SHORT", f"{ACTIONABLE}–{STRONG - 1}", "Actionable signal"],
            ["WATCH", f"{WATCH}–{ACTIONABLE - 1}", "Forming; not yet actionable"],
            ["NEUTRAL / NO TRADE", f"Below {WATCH}", "No position"],
        ],
        [38 * mm, 26 * mm, None],
        highlight_col=0,
    ),
    Spacer(1, 4),
    P("Only STRONG and LONG/SHORT are tradeable. WATCH is shown for transparency.", "note"),
]

story.append(Spacer(1, 6))

# ── Risk / reward ────────────────────────────────────────────────────────
rr = [
    P("Risk &amp; Reward", "h2"),
    P("Risk is defined before entry and never widened. Every position is measured in <b>R</b> — "
      "multiples of the amount risked.", "body"),
    grid(
        ["Level", "Distance", "Action"],
        [
            ["Stop loss", "1 R", f"Placed beyond the structural low/high. Minimum {MIN_STOP} pips."],
            ["Target 1", f"{R1:g} R", "Stop moves to entry. Position can no longer lose."],
            ["Target 2", f"{R2:g} R", "Partial or full exit."],
            ["Target 3", f"{R3:g} R", "Final target."],
        ],
        [28 * mm, 24 * mm, None],
        highlight_col=0,
    ),
    Spacer(1, 6),
    P(f"<b>Risk/reward: 1 : {R1:g} minimum, up to 1 : {R3:g}.</b>", "body"),
    P(f"After Target 1 is reached the worst possible outcome of the position is breakeven.", "body"),
]
story.append(KeepTogether(rr))

# ── Coverage / discipline ────────────────────────────────────────────────
cov = [
    P("Coverage &amp; Discipline", "h2"),
    rule_table([
        ("Pairs", ", ".join(PAIRS)),
        ("Timeframes", f"{' and '.join(TFS)}, filtered by the {BIAS_TF} trend"),
        ("Hours", f"{H_FROM:02d}:00–{H_TO:02d}:00 UTC, weekdays only"),
        ("Open positions", "One per pair. No averaging, no adding."),
        ("After a close", f"That pair is stood down for {COOLDOWN} hours."),
        ("Unresolved", f"A position open for {EXPIRY} days is closed and excluded from results."),
        ("Monitoring", "Continuous. Stops and targets are tracked outside market hours."),
    ], [38 * mm, None]),
]
story.append(KeepTogether(cov))

# ── Expectations ─────────────────────────────────────────────────────────
exp = [
    P("What To Expect", "h2"),
    P("<b>Signals are infrequent by design.</b> All six conditions must hold simultaneously. "
      "Quiet days are the method working, not a fault.", "body"),
    P("Every signal is recorded with its outcome. Performance is reported in R and broken down by "
      "market condition and signal grade, so results can be judged rather than asserted.", "body"),
    Spacer(1, 8),
    Paragraph(
        "<b>Important.</b> This is a signal methodology, not a performance claim. "
        "Past or simulated results do not indicate future returns. Trading foreign exchange "
        "carries substantial risk of loss.",
        S["disc"],
    ),
]
story.append(KeepTogether(exp))

doc.build(story)
print(f"written: {OUT}")
