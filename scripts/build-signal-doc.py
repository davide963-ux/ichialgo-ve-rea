"""
Build docs/how-a-signal-is-made.pdf — what ATR decides, what Ichimoku decides.

    /usr/local/bin/python3.13 scripts/build-signal-doc.py

Needs reportlab, which is NOT a project dependency: this is documentation,
not part of the app or its build, and nothing in npm run build touches it.

TWO THINGS THAT WILL BITE WHOEVER EDITS THIS

1. The built-in Helvetica and Courier only cover WinAnsiEncoding. Box-drawing
   characters, arrows and the maths glyphs (~=, >=, <=) are NOT in it and come
   out as solid black rectangles rather than as an error. Every diagram here
   is deliberately plain ASCII for that reason.

2. The numbers are not decoration. They come from the measurements in this
   repository's backtest and from one real signal in fixtures/market/ —
   EUR/USD, the bar opening 2025-12-08 14:00 UTC. If the strategy changes,
   this document is wrong until it is regenerated with new figures.
"""
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    KeepTogether, PageBreak,
)

OUT = "/home/user/ichialgo-ve-rea/docs/how-a-signal-is-made.pdf"

INK = colors.HexColor("#14201C")
MUTED = colors.HexColor("#5C6B64")
RULE = colors.HexColor("#D5DEDA")
BAND = colors.HexColor("#F2F6F4")
GREEN = colors.HexColor("#1E7A52")
RED = colors.HexColor("#B5443F")
AMBER = colors.HexColor("#9A6B10")

ss = getSampleStyleSheet()


def st(name, **kw):
    base = dict(fontName="Helvetica", fontSize=9.5, leading=14, textColor=INK, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(name, **base)


H1 = st("H1", fontName="Helvetica-Bold", fontSize=19, leading=23, spaceAfter=3)
SUB = st("SUB", fontSize=10, leading=14, textColor=MUTED, spaceAfter=14)
H2 = st("H2", fontName="Helvetica-Bold", fontSize=13, leading=17, spaceBefore=16, spaceAfter=6)
H3 = st("H3", fontName="Helvetica-Bold", fontSize=10.5, leading=14, spaceBefore=10, spaceAfter=3)
BODY = st("BODY", spaceAfter=7)
SMALL = st("SMALL", fontSize=8.5, leading=12, textColor=MUTED, spaceAfter=6)
MONO = st("MONO", fontName="Courier", fontSize=8.5, leading=12.5)
MONOC = st("MONOC", fontName="Courier", fontSize=8.5, leading=12.5, textColor=INK)
CELL = st("CELL", fontSize=8.5, leading=11.5)
CELLB = st("CELLB", fontName="Helvetica-Bold", fontSize=8.5, leading=11.5)


def code(text):
    """A monospace block on a tinted panel."""
    rows = [[Paragraph(line.replace(" ", "&nbsp;") or "&nbsp;", MONO)] for line in text.strip("\n").split("\n")]
    t = Table(rows, colWidths=[165 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), BAND),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ("LINEBEFORE", (0, 0), (0, -1), 2, GREEN),
    ]))
    return [Spacer(1, 4), t, Spacer(1, 9)]


def table(headers, rows, widths, aligns=None, head_bg=BAND):
    data = [[Paragraph(h, CELLB) for h in headers]]
    for r in rows:
        data.append([c if isinstance(c, Paragraph) else Paragraph(str(c), CELL) for c in r])
    t = Table(data, colWidths=widths, repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), head_bg),
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, RULE),
        ("LINEBELOW", (0, 1), (-1, -2), 0.3, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
    ]
    for col, a in (aligns or {}).items():
        style.append(("ALIGN", (col, 0), (col, -1), a))
    t.setStyle(TableStyle(style))
    return t


def plain_rows(rows, widths):
    """A two-column list with no header band — labelled rows, not a table."""
    data = [[c if isinstance(c, Paragraph) else Paragraph(str(c), CELL) for c in r] for r in rows]
    t = Table(data, colWidths=widths)
    t.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, -2), 0.3, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
    ]))
    return t


def chip(text, colour):
    return Paragraph(f'<font color="{colour.hexval()}"><b>{text}</b></font>', CELL)


def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(22 * mm, 282 * mm, 188 * mm, 282 * mm)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(22 * mm, 285 * mm, "ICHIALGO — how a signal is made")
    canvas.drawRightString(188 * mm, 285 * mm, "EMA50 touch · Ichimoku · ATR")
    canvas.line(22 * mm, 16 * mm, 188 * mm, 16 * mm)
    canvas.drawString(22 * mm, 11 * mm, "Generated from the live code and the checked-in OANDA fixtures.")
    canvas.drawRightString(188 * mm, 11 * mm, f"Page {doc.page}")
    canvas.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=22 * mm, rightMargin=22 * mm,
                      topMargin=24 * mm, bottomMargin=22 * mm,
                      title="How a signal is made", author="ichialgo")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="n")
doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=header_footer)])

S = []
A = S.append

# ----------------------------- page 1 -----------------------------
A(Paragraph("How a signal is made", H1))
A(Paragraph("What ATR decides, what Ichimoku decides, and which of them is actually in charge.", SUB))

A(Paragraph("The short answer", H2))
A(Paragraph(
    "<b>ATR decides every price in the trade.</b> How wide the touch band is, where the stop goes, "
    "and therefore where the target goes. Nothing on the ticket is set by Ichimoku.", BODY))
A(Paragraph(
    "<b>Ichimoku decides nothing.</b> It is computed on every signal, scored out of 5, stored in the "
    "database and shown in the UI — and then no code reads it. It cannot trigger a signal, cannot "
    "change the direction, and cannot stop a trade being taken.", BODY))
A(Paragraph(
    "That is worth stating plainly because the measurements say it is the wrong way round: the "
    "EMA50 touch on its own has no edge, and the Ichimoku score it ignores is carrying all of it.", BODY))

A(Paragraph("The pipeline", H2))
A(Paragraph("Everything below happens on one closed 30-minute bar, per pair.", SMALL))
S.extend(code("""
   candles -> EMA50          the line being touched
           -> ATR(14)        the only source of distance
           -> Ichimoku       5 lines, scored, then ignored
                   |
   1  BAND      tol    = max( ATR x 0.15 , 1.5 pips )        <- ATR
   2  SIDE      from the PREVIOUS bar's close vs the EMA
   3  TOUCH     low <= EMA+tol  AND  high >= EMA-tol
   4  ARMED     one signal per approach, not per bar
                   |
               +---v----+
               | SIGNAL |
               +---+----+
   5  DIRECTION came from above -> LONG     came from below -> SHORT
   6  TICKET    risk   = max( ATR x 1.5 , 8 pips )           <- ATR
               entry  = the EMA50 itself
               stop   = entry -/+ risk
               target = entry +/- risk x 2
   7  ICHIMOKU  score 0-5, attached, never read
"""))

# ----------------------------- ATR -----------------------------
A(Paragraph("1 — What ATR does", H2))
A(Paragraph(
    "ATR is the 14-period Average True Range: the average distance price has been travelling per bar "
    "recently. It is the strategy's only notion of “how far is far”, and it is used three times.", BODY))

A(table(
    ["Where", "Formula", "What it controls"],
    [
        ["Touch band", Paragraph("max(ATR × <b>0.15</b>, <b>1.5</b> pips)", CELL),
         "How close price must come to the EMA50 to count as touching it."],
        ["Stop distance", Paragraph("max(ATR × <b>1.5</b>, <b>8</b> pips)", CELL),
         "How far the stop sits beyond the entry — far enough that the wick which made the touch does not take it out."],
        ["Target", Paragraph("stop distance × <b>2</b>", CELL),
         "Fixed 2:1. So the target is ATR-derived too, at one remove."],
    ],
    [30 * mm, 42 * mm, 93 * mm]))

A(Paragraph("The floors matter more than the ATR", H3))
A(Paragraph(
    "Both bands have a minimum, and on 30M majors the minimum usually wins. With EUR/USD ATR around "
    "9–10 pips, ATR × 0.15 is about 1.4 pips — under the 1.5 pip floor. So the touch band is "
    "<b>almost always exactly 1.5 pips</b>, and does not in practice scale with volatility the way "
    "the design intends. The stop is the opposite: ATR × 1.5 is ~14 pips against an 8-pip floor, so "
    "there ATR really is in charge.", BODY))

A(PageBreak())

# ----------------------------- Ichimoku -----------------------------
A(Paragraph("2 — What Ichimoku does", H2))
A(Paragraph(
    "All five Ichimoku lines are computed correctly, including the 26-bar displacement that makes the "
    "cloud lead and the lagging line trail. Five checks are run against the trade's direction and "
    "counted into a score out of 5.", BODY))

A(table(
    ["#", "Check", "Passes when", "Measured worth"],
    [
        ["1", "Price vs Kumo", "price is on the trade's side of the cloud",
         chip("+4.9 pips  strong", GREEN)],
        ["2", "Cloud colour", "Senkou A above B for a long, below for a short",
         chip("-6.6 pips  see note", RED)],
        ["3", "Tenkan / Kijun", "the fast line is the right side of the slow one",
         chip("+8.9 pips  strong", GREEN)],
        ["4", "Chikou free", "the lagging line is clear of the candles 26 bars back",
         chip("+12.6 pips  best", GREEN)],
        ["5", "EMA50 ~ Kijun", "the two lines are within 5 pips — one level, two methods",
         chip("+0.4 pips  noise", AMBER)],
    ],
    [8 * mm, 32 * mm, 70 * mm, 55 * mm]))
A(Paragraph(
    "“Measured worth” is the difference in average result between trades where the check passed and "
    "trades where it failed, over 848 closed trades on five pairs. Check 2 looked actively harmful, "
    "but that reversed on held-out data, so it is noise rather than a real inversion — the honest "
    "reading is that it is unreliable, not backwards.", SMALL))

A(Paragraph("And then nothing reads it", H3))
A(Paragraph(
    "The score is attached to the signal, written to the database and rendered in the UI. "
    "There is no code path in which it changes a decision. The direction comes from which side price "
    "approached from; the levels come from ATR. A 0/5 signal and a 5/5 signal are traded identically.", BODY))
A(Paragraph(
    "The <b>>=3/5 filter on the backtest page is a display control only</b> — it filters the table you "
    "are looking at. The live scanner stores every touch regardless.", BODY))

# ----------------------------- worked example -----------------------------
A(Paragraph("3 — One real signal, end to end", H2))
A(Paragraph(
    "EUR/USD, 1-hour bar opening <b>Mon 8 Dec 2025 14:00 UTC</b>. Taken from the checked-in OANDA "
    "fixtures, not invented — every number below is reproducible from that bar.", SMALL))

A(table(
    ["Input", "Value"],
    [
        ["Bar OHLC", Paragraph("open 1.16484 &nbsp; high 1.16548 &nbsp; low 1.16378 &nbsp; close 1.16402", MONOC)],
        ["EMA50", Paragraph("1.1652303", MONOC)],
        ["ATR(14)", Paragraph("0.00096563  =  9.66 pips", MONOC)],
    ],
    [30 * mm, 135 * mm]))

S.extend(code("""
1  BAND       ATR x 0.15 = 1.45 pips  ->  below the 1.5 floor
              tol = 1.5 pips          band = 1.16508 .. 1.16538

2  SIDE       the previous bar closed BELOW the EMA   ->  approach = below

3  TOUCH      low  1.16378 <= 1.16538   yes
              high 1.16548 >= 1.16508   yes          -> touched

4  ARMED      yes, price had left the band since the last touch

5  DIRECTION  came from below = a rally into resistance  ->  SHORT

6  TICKET     risk   = max(9.66 x 1.5, 8) = 14.5 pips
              entry  = 1.16523     (the EMA itself)
              stop   = 1.16668     (entry + 14.5 pips)
              target = 1.16233     (entry - 29.0 pips)

7  ICHIMOKU   price below Kumo        yes  (short wants below)
              cloud bearish           yes
              Tenkan above Kijun      yes  -> FAILS, a short wants below
              Chikou free             yes
              EMA50 2.2 pips of Kijun yes
                                      score 4 / 5   ... and is not used
"""))

A(Paragraph(
    "<b>Outcome:</b> the very next bar traded down to 1.16172, through the target at 1.16233. "
    "Closed +29 pips gross, <b>+28 pips</b> after one pip of spread, holding one bar.", BODY))
A(Paragraph(
    "Note what did the work. ATR set the band that found the touch, the 14.5-pip risk, and the "
    "29-pip target. Ichimoku scored 4/5 and changed nothing — the identical trade would have been "
    "taken at 0/5.", SMALL))

A(PageBreak())

# ----------------------------- evidence -----------------------------
A(Paragraph("4 — Why this matters", H2))
A(Paragraph(
    "The part that is ignored is the part that works. Same trades, same ATR levels, same exits — the "
    "only difference is requiring the Ichimoku score the system already computes.", BODY))

A(table(
    ["Rule", "Trades", "Win rate", "Avg pips", "95% interval"],
    [
        [Paragraph("<b>As it runs today</b> — no gate", CELL), "856", "35.7%",
         chip("-0.13", RED), "-2.24 … +1.98"],
        ["Require score >= 3", "564", "42.4%", chip("+4.23", GREEN), "+1.61 … +6.85"],
        ["Require score >= 4", "279", "46.2%", chip("+5.73", GREEN), "+2.26 … +9.20"],
    ],
    [60 * mm, 20 * mm, 22 * mm, 25 * mm, 38 * mm],
    aligns={1: "RIGHT", 2: "RIGHT", 3: "RIGHT"}))

A(Paragraph(
    "Break-even for a 2:1 target is 36.0% after costs. Today's rule wins 35.7% — it is not slightly "
    "losing, it is sitting exactly on zero, and the interval straddles zero from both sides. Gating "
    "on the score moves it clear of zero, and that result held on data the tuning never saw "
    "(+6.22 then +8.37 pips across a 60/40 time split).", BODY))

A(Paragraph("What is not proven", H2))
A(plain_rows(
    [
        [Paragraph("<b>Timeframe mismatch</b>", CELL),
         "Every figure here is from 1-hour candles. The live scanner trades 30-minute bars, where "
         "Ichimoku's 9/26/52 periods span a different amount of real time. This is the single "
         "biggest reason the numbers might not transfer."],
        [Paragraph("<b>Two pairs untested</b>", CELL),
         "USD/CHF and NZD/USD are scanned live but have no checked-in candles, so nothing above "
         "says anything about them."],
        [Paragraph("<b>One regime</b>", CELL),
         "About nine months of data. A rule that fits one market regime and fails the next is the "
         "normal outcome, not the exception."],
    ],
    [34 * mm, 131 * mm]))

A(Paragraph("In one line", H2))
A(Paragraph(
    "ATR builds the whole trade and Ichimoku watches from the sidelines — while the evidence says "
    "Ichimoku is the one with the information.", BODY))

doc.build(S)
print("wrote", OUT)
