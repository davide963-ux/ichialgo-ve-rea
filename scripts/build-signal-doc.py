"""
Build docs/how-a-signal-is-made.pdf — how Ichimoku, and only Ichimoku, makes a
signal, and how the three strategies that do it compare.

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
   EUR/USD, the bar opening 2025-12-12 08:00 UTC. If a strategy changes, this
   document is wrong until it is regenerated with new figures.
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
H2 = st("H2", fontName="Helvetica-Bold", fontSize=13, leading=17, spaceBefore=16, spaceAfter=6, keepWithNext=1)
H3 = st("H3", fontName="Helvetica-Bold", fontSize=10.5, leading=14, spaceBefore=10, spaceAfter=3, keepWithNext=1)
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
    canvas.drawRightString(188 * mm, 285 * mm, "Three Ichimoku strategies, compared")
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
A(Paragraph("Ichimoku, and nothing else: what sets the direction, what triggers the entry, "
            "where the stop comes from without an ATR, what it measures, and how it compares with "
            "OANDA's published rules.", SUB))

A(Paragraph("The short answer", H2))
A(Paragraph(
    "<b>The cloud sets the direction.</b> Price above the Kumo can only produce a long, price below "
    "it can only produce a short, and price inside it produces nothing at all.", BODY))
A(Paragraph(
    "<b>Kijun-sen sets the trigger.</b> A signal is price pulling back into a band around the base "
    "line while still clear of the cloud. One per pullback, not one per bar.", BODY))
A(Paragraph(
    "<b>The 26-bar range sets every distance.</b> How wide that band is, and how far the stop sits. "
    "This is what replaced the ATR, and it is not a new indicator: Kijun-sen IS the midpoint of "
    "that range, so its width was already implied by the line being traded.", BODY))
A(Paragraph(
    "<b>Four confirmations decide whether it happens at all.</b> They are a gate, not a label. "
    "Below the threshold no signal is produced - it is not produced-and-flagged.", BODY))

A(Paragraph("What changed, and why it is worth knowing", H2))
A(Paragraph(
    "The previous strategy traded a touch of a 50-period EMA, sized its band and stop from a "
    "14-period ATR, and computed an Ichimoku score out of 5 that it then ignored. Three things "
    "were wrong with it, and all three are fixed here rather than tuned:", BODY))
A(plain_rows(
    [
        [Paragraph("<b>Direction</b>", CELL),
         "It took the direction from the side price approached the line on, so a pullback inside a "
         "downtrend became a long. The cloud now decides, and nothing else can."],
        [Paragraph("<b>The score</b>", CELL),
         "A 0-of-5 setup was logged, shown, and tradeable, with a dashboard filter offered as a "
         "consolation. Measured, the EMA touch alone was worth -0.13 pips a trade at a 35.7% win "
         "rate against the 36.0% it needed to break even: nothing. The score it ignored was "
         "carrying whatever edge existed. It is now the gate."],
        [Paragraph("<b>The entry</b>", CELL),
         "A resting limit at the EMA, which a third of touches never reached. Entry is now the "
         "close of the pullback bar, which is a price that traded by definition."],
    ],
    [26 * mm, 139 * mm]))

A(Paragraph("The pipeline", H2))
S.extend(code("""
  300 candles -> Tenkan(9) Kijun(26) Senkou A/B Chikou, 26-bar shift
                 range(26) = highest high - lowest low   <- the "volatility"

  per bar:
    1. price vs the Kumo   inside -> skip, no trend to pull back into
                           above  -> LONG       below -> SHORT
    2. range reaches Kijun +/- 0.08 * range, and armed?  no -> keep watching
    3. all 4 confirmations?                    fewer than 4 -> NO SIGNAL
    4. entry = this close    stop = -/+ 0.40 * range    target = 2x the risk
    5. disarm until a close leaves the band by 1.5x
"""))

A(Paragraph("Where the distances come from, with no ATR", H2))
A(Paragraph(
    "Removing the ATR leaves a strategy with no sense of distance at all - how wide is a touch, "
    "how far is a stop. The usual fix is to pick a pip figure, which means one number for a dead "
    "session and a fast one. Ichimoku already contains the answer:", BODY))
S.extend(code("""
  Kijun-sen =  (highest high + lowest low) / 2     over 26 bars
  range     =   highest high - lowest low          over the same 26 bars
"""))
A(Paragraph(
    "The line being traded is the midpoint of that range, so the range is the line's own width. "
    "Matching the window to the Kijun period is deliberate: the level and the distance around it "
    "then describe the same stretch of market. Two fractions of it are all the strategy needs.", BODY))
A(plain_rows(
    [
        [Paragraph("<b>Touch band</b>", CELL),
         Paragraph("<b>0.08 x range</b> either side of Kijun. About a tenth of recent travel: wide "
                   "enough to catch a real retest, tight enough that drifting near the line does "
                   "not count.", CELL)],
        [Paragraph("<b>Re-arm</b>", CELL),
         Paragraph("<b>1.5 x the band</b>. A close must leave the zone by this much before the pair "
                   "can signal again. Without it, a market riding its Kijun fires every bar.", CELL)],
        [Paragraph("<b>Stop</b>", CELL),
         Paragraph("<b>0.40 x range</b> from the entry.", CELL)],
        [Paragraph("<b>Target</b>", CELL),
         Paragraph("<b>2 x the stop distance</b>, so 0.80 x range.", CELL)],
    ],
    [30 * mm, 135 * mm]))

A(Paragraph("The four confirmations", H2))
A(Paragraph(
    "Each is read in the direction the cloud already set, so the same bar scores differently for a "
    "long and a short. All four are required.", BODY))
A(table(
    ["#", "Check", "What it asks"],
    [
        ["1", Paragraph("<b>Cloud in effect</b>", CELL),
         "Is Senkou A above Senkou B over this bar? The cloud you are standing on agrees with the "
         "trade."],
        ["2", Paragraph("<b>Cloud 26 bars ahead</b>", CELL),
         "Is the leading cloud the same colour? It is already determined today, and it is what the "
         "trend is walking into."],
        ["3", Paragraph("<b>Chikou free</b>", CELL),
         "Is the close clear of the candles 26 bars back - above their high for a long, below their "
         "low for a short? Nothing overhead that price has to fight through."],
        ["4", Paragraph("<b>Tenkan agrees</b>", CELL),
         "Is the 9-period line on the trade's side of Kijun? Short-term momentum has not already "
         "turned against the pullback."],
    ],
    [8 * mm, 40 * mm, 117 * mm]))
A(Paragraph(
    "A check that cannot be answered - Chikou on a bar with fewer than 26 behind it - counts as a "
    "failure, never as a pass. It is stored as null rather than false, so the history can say "
    "\"not knowable\" as well as \"no\".", SMALL))
A(PageBreak())

A(Paragraph("A real signal, end to end", H2))
A(Paragraph(
    "EUR/USD, the 1-hour bar opening <b>12 December 2025, 08:00 UTC</b>, from "
    "<font face=\"Courier\" size=\"8.5\">fixtures/market/EURUSD_1H.csv</font>. Every number below is "
    "the one the code produces.", BODY))

A(Paragraph("The bar", H3))
S.extend(code("""
  open 1.17379   high 1.17422   low 1.17282   close 1.17282
"""))

A(Paragraph("The lines at that bar", H3))
A(plain_rows(
    [
        ["Tenkan-sen (9)", Paragraph('<font face="Courier">1.17372</font>', CELL)],
        ["Kijun-sen (26)", Paragraph('<font face="Courier">1.17251</font>', CELL)],
        ["Senkou A / B (in effect)", Paragraph('<font face="Courier">1.16809 / 1.16613</font>', CELL)],
        ["Senkou A / B (26 bars ahead)", Paragraph('<font face="Courier">1.17311 / 1.16947</font>', CELL)],
        ["Candles 26 bars back", Paragraph('<font face="Courier">high 1.16898, low 1.16823</font>', CELL)],
        ["26-bar range", Paragraph('<font face="Courier">75.5 pips</font>', CELL)],
    ],
    [55 * mm, 110 * mm]))

A(Paragraph("The decisions, in order", H3))
S.extend(code("""
  1. Kumo side      close 1.17282 vs cloud top 1.16809     ABOVE  -> LONG
  2. Band           0.08 * 75.5 pips = 6.0 pips either side of 1.17251
                    so the zone is 1.17191 .. 1.17311
                    the bar's low 1.17282 is inside it     TOUCH
  3. Armed?         the last signal's zone was left        YES
  4. Confirmations
       cloud in effect   1.16809 > 1.16613                 PASS
       cloud ahead       1.17311 > 1.16947                 PASS
       Chikou free       close 1.17282 > 1.16898           PASS
       Tenkan agrees     1.17372 > 1.17251                 PASS
                                                           4 of 4 -> SIGNAL
  5. Ticket
       entry   = the close                                 1.17282
       stop    = entry - 0.40 * 75.5 pips                  1.16980   (30.2 pips)
       target  = entry + 2 * 30.2 pips                     1.17886   (60.4 pips)
"""))

A(Paragraph("What happened next", H3))
A(Paragraph(
    "Price reached the target 53 bars later, on 16 December at 13:00 UTC. After one pip of assumed "
    "spread that is <b>+59.4 pips</b>. One trade proves nothing about a strategy - it is here "
    "because every intermediate number above can be checked against the fixture by hand, which is "
    "the only way to know the description matches the code.", BODY))

A(PageBreak())

# ----------------------------- page 4 -----------------------------
A(Paragraph("What it measures", H2))
A(Paragraph(
    "Five traded pairs, 5000 one-hour OANDA bars each, 3 December 2025 to 23 September 2026, one "
    "pip of cost charged on every trade. One position at a time, the stop winning any bar that "
    "covers both exits, and a trade still open at the end left uncounted.", BODY))

A(Paragraph("The gate is the only setting with evidence behind it", H3))
A(table(
    ["Gate", "Trades", "Win", "Average", "95% interval", "PF"],
    [
        ["1 of 4", "619", "34.6%", "+0.33 pips", "-3.88 .. +4.54", "1.02"],
        ["2 of 4", "603", "35.0%", "+1.15 pips", "-3.15 .. +5.45", "1.05"],
        ["3 of 4", "543", "35.4%", "+1.43 pips", "-3.17 .. +6.02", "1.07"],
        [Paragraph("<b>4 of 4 (live)</b>", CELL), Paragraph("<b>369</b>", CELL),
         Paragraph("<b>36.9%</b>", CELL), Paragraph("<b>+3.89 pips</b>", CELL),
         Paragraph("<b>-1.63 .. +9.40</b>", CELL), Paragraph("<b>1.20</b>", CELL)],
    ],
    [22 * mm, 20 * mm, 18 * mm, 28 * mm, 45 * mm, 15 * mm],
    aligns={1: "RIGHT", 2: "RIGHT", 3: "RIGHT", 5: "RIGHT"}))
A(Paragraph(
    "The interval spans zero at <i>every</i> setting, so none of this is a profitability claim. "
    "What the table shows is that tightening the gate moves the number in one direction, which is "
    "a property of the rule rather than of one slice of data.", BODY))

A(Paragraph("Split by time, it gets worse rather than better", H3))
A(table(
    ["Period", "Trades", "Win", "Average", "95% interval"],
    [
        ["First 60%", "236", "35.2%", "+0.66 pips", "-5.80 .. +7.12"],
        ["Last 40%", "127", "40.9%", "+10.68 pips", "+0.16 .. +21.19"],
    ],
    [28 * mm, 20 * mm, 18 * mm, 30 * mm, 45 * mm],
    aligns={1: "RIGHT", 2: "RIGHT", 3: "RIGHT"}))
A(Paragraph(
    "That looks like a rule validated out of sample and is not. <b>Every variant tested improves by "
    "a similar amount across that boundary, including rules with no edge at all.</b> The second "
    "period was simply kinder. The honest summary is <b>around break-even on hard data, good on "
    "easy data</b>.", BODY))
A(Paragraph(
    "The same split narrows the case for the gate. On the hard first 60% it turns -4.00 pips into "
    "+0.66; on the kind last 40% it is a wash and slightly negative (+11.26 at 2 of 4, +10.68 at 4 "
    "of 4). Four is chosen for robustness when conditions are poor, not for more upside when they "
    "are good.", BODY))

A(Paragraph("It is not uniform across pairs", H3))
A(table(
    ["Pair", "Signals", "Trades", "Win", "Average", "Total"],
    [
        ["EUR/USD", "208", "70", "40.0%", "+7.05", "+494"],
        ["GBP/USD", "178", "74", "36.5%", "+2.06", "+153"],
        ["USD/JPY", "227", "75", "38.7%", "+7.94", "+596"],
        ["AUD/USD", "235", "78", "25.6%", chip("-5.02", RED), chip("-391", RED)],
        ["USD/CAD", "232", "72", "44.4%", "+8.11", "+584"],
    ],
    [25 * mm, 22 * mm, 20 * mm, 20 * mm, 25 * mm, 22 * mm],
    aligns={1: "RIGHT", 2: "RIGHT", 3: "RIGHT", 4: "RIGHT", 5: "RIGHT"}))
A(Paragraph(
    "Signals far outnumber trades because only one position is held at a time - 1080 signals "
    "produce 369 trades. The rest fired while a trade was already running and are reported as "
    "skipped rather than quietly dropped.", SMALL))

A(PageBreak())

# ----------------------------- page 5 -----------------------------
A(Paragraph("Three strategies, one harness", H2))
A(Paragraph(
    "The app runs three entry rules. The one described above is ours. The other two are OANDA's, "
    "from their published Ichimoku Cloud trading guide, implemented to the letter so they can be "
    "measured against it rather than argued about.", BODY))
A(plain_rows(
    [
        [Paragraph("<b>Kijun pullback</b><br/><font size=\'8\' color=\'#5C6B64\'>ours</font>", CELL),
         "Price clear of the Kumo pulls back into a band around Kijun-sen, and all four Ichimoku "
         "confirmations must agree. The gate is the whole design."],
        [Paragraph("<b>Tenkan/Kijun pullback</b><br/><font size=\'8\' color=\'#5C6B64\'>OANDA</font>", CELL),
         "Price clear of the Kumo with Tenkan on the trade's side, a pullback that reaches Tenkan or "
         "Kijun, then a close back through Kijun on a candle of the trade's own colour. No cloud "
         "colour, no forward cloud, no Chikou - none of those are in their rules."],
        [Paragraph("<b>Kumo breakout</b><br/><font size=\'8\' color=\'#5C6B64\'>OANDA</font>", CELL),
         "Price breaks through the cloud after consolidation and the cloud 26 bars ahead turns the "
         "same way, with Chikou clear of its prior 26-period price. The twist may arrive after the "
         "break, because in both of their worked examples it did."],
    ],
    [40 * mm, 125 * mm]))
A(Paragraph(
    "<b>OANDA's article gives no stop, no target and no position size.</b> So the exit is ours, and "
    "it is identical for all three - comparing two entry rules only means something if the exit is "
    "held constant, or the comparison measures the exits instead.", BODY))

A(Paragraph("What they measure, on the same candles", H3))
A(table(
    ["Strategy", "Signals", "Trades", "Win", "Average", "95% interval", "PF"],
    [
        [Paragraph("<b>Kijun pullback</b>", CELL), Paragraph("<b>1080</b>", CELL),
         Paragraph("<b>369</b>", CELL), Paragraph("<b>36.9%</b>", CELL),
         Paragraph("<b>+3.89</b>", CELL), Paragraph("<b>-1.63 .. +9.40</b>", CELL),
         Paragraph("<b>1.20</b>", CELL)],
        ["Tenkan/Kijun pullback", "3138", "515", "35.1%", "-0.99", "-6.10 .. +4.13", "0.96"],
        ["Kumo breakout", "831", "466", "33.3%", chip("-3.47", RED), "-7.58 .. +0.64", chip("0.84", RED)],
    ],
    [42 * mm, 19 * mm, 18 * mm, 17 * mm, 20 * mm, 33 * mm, 14 * mm],
    aligns={1: "RIGHT", 2: "RIGHT", 3: "RIGHT", 4: "RIGHT", 6: "RIGHT"}))
A(Paragraph(
    "Every interval spans zero, so none of these is a profitability claim. What is worth having is "
    "the ordering, and it survives the time split that flatters everything:", BODY))
A(table(
    ["Strategy", "First 60% (hard)", "Last 40% (kind)"],
    [
        ["Kijun pullback (ours)", "+0.66", "+10.68"],
        ["Tenkan/Kijun pullback", "-3.85", "+6.21"],
        ["Kumo breakout", "-5.08", "-0.94"],
    ],
    [60 * mm, 35 * mm, 35 * mm],
    aligns={1: "RIGHT", 2: "RIGHT"}))
A(Paragraph(
    "The kind period lifts all three, which is why one split proves nothing about any of them in "
    "isolation. The RANKING holds in both halves, and that is a stronger statement than any single "
    "average, because whatever flatters a period flatters all three equally.", BODY))
A(Paragraph(
    "<b>None of this says OANDA's rules are bad.</b> It says that on 1-hour majors, over nine "
    "months, with this exit, in a harness where the only variable is the entry, they did worse than "
    "what was already here. Their own article is explicit that the Cloud performs poorly in tight, "
    "choppy or scalping conditions, and hourly FX majors spend a great deal of time exactly there.", BODY))

A(PageBreak())

A(Paragraph("What this does not tell you", H2))
A(plain_rows(
    [
        [Paragraph("<b>Timeframe mismatch</b>", CELL),
         "Every figure here is from 1-hour candles. The live scanner trades 30-minute bars, where "
         "Ichimoku's 9/26/52 periods span a different amount of real time. This is the single "
         "biggest reason the numbers might not transfer."],
        [Paragraph("<b>Two pairs untested</b>", CELL),
         "USD/CHF and NZD/USD are scanned live but have no checked-in candles, so nothing above "
         "says anything about them."],
        [Paragraph("<b>One pair loses</b>", CELL),
         "AUD/USD is negative over the whole sample. A rule that works on four pairs and not the "
         "fifth has not been shown to be about the market rather than about those four."],
        [Paragraph("<b>One regime</b>", CELL),
         "About nine months of data. A rule that fits one market regime and fails the next is the "
         "normal outcome, not the exception."],
        [Paragraph("<b>Correlated pairs</b>", CELL),
         "EUR/USD, GBP/USD and AUD/USD are largely the same dollar trade, so 369 trades are worth "
         "fewer than 369 independent observations and every interval above is narrower than it "
         "should be."],
        [Paragraph("<b>All in-sample</b>", CELL),
         "Every setting of OURS was chosen after seeing these candles. That is less true of "
         "OANDA's two, which were published independently of this data - which makes their "
         "result the more honest comparison and ours the more flattered one."],
    ],
    [34 * mm, 131 * mm]))

A(Paragraph("How the claim \"pure Ichimoku\" is kept true", H2))
A(Paragraph(
    "A promise like this rots quietly. Someone adds an ATR floor under the stop because a quiet "
    "pair produced a 3-pip one, nothing fails, and a year later the strategy is a hybrid again. So "
    "it is checked mechanically rather than by review: a test reads the source of every strategy "
    "file, strips the comments, and fails if the words EMA or ATR appear anywhere in the code.", BODY))
A(Paragraph(
    "That now covers six files rather than two, and it has already earned its place. OANDA's "
    "article closes by recommending the Cloud be paired with RSI or Stochastic for timing. It is a "
    "reasonable suggestion, and exactly the kind of thing that arrives one day as a small addition. "
    "It would fail this test.", BODY))
A(Paragraph(
    "Two other tests carry more weight than any number in this document. One replays a truncated "
    "series and requires every earlier signal to come out byte-identical, which is what rules out "
    "the detector reading bars it could not have seen - the failure that would make every figure "
    "here a faithful calculation over a fiction. The other replays a fixture through the browser's "
    "backtest and the server's scanner and requires the same verdict on every trade, so the live "
    "history and the measured history cannot drift apart.", BODY))

A(Paragraph("In one line", H2))
A(Paragraph(
    "The cloud says which way, Kijun says where, the 26-bar range says how far, and the "
    "confirmations say whether at all - with no second indicator left to disagree with the first. "
    "Three rules do that differently, they are all here, and the numbers say which one has done "
    "better on this data rather than which one reads best.", BODY))

doc.build(S)
print("wrote", OUT)
