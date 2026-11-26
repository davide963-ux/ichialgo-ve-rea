"""
Build docs/how-a-signal-is-made.pdf — how Ichimoku, and only Ichimoku, makes a
signal: the two entries of OANDA's published system, what each requires, and
what both of them measured.

    /usr/local/bin/python3.13 scripts/build-signal-doc.py

Needs reportlab, which is NOT a project dependency: this is documentation,
not part of the app or its build, and nothing in npm run build touches it.

TWO THINGS THAT WILL BITE WHOEVER EDITS THIS

1. The built-in Helvetica and Courier only cover WinAnsiEncoding. Box-drawing
   characters, arrows and the maths glyphs (~=, >=, <=) are NOT in it and come
   out as solid black rectangles rather than as an error. Every diagram here
   is deliberately plain ASCII for that reason.

2. The numbers are not decoration. They come from the measurements in this
   repository's backtest and from two real signals in fixtures/market/ — the
   EUR/USD bars opening 2025-12-08 08:00 and 2025-12-10 20:00 UTC, one of each
   entry. If the strategy changes, this document is wrong until it is
   regenerated with new figures. The worked examples are both winners, which
   is a property of how they were picked (a resolved trade reads better than
   an open one) and NOT of the strategy: the measured result is a loss and the
   document says so on the same page.
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
    canvas.drawRightString(188 * mm, 285 * mm, "OANDA's Ichimoku system, as built and as measured")
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
A(Paragraph("Ichimoku, and nothing else: the two entries of OANDA's published system, what each "
            "one requires before it fires, where its stop comes from, and what both of them "
            "measured on 25,000 bars of real candles.", SUB))

A(Paragraph("The short answer", H2))
A(Paragraph(
    "<b>The Kumo sets the direction.</b> Price closing above the cloud is a long, below is a "
    "short, inside is no trade at all. Nothing else is allowed a vote on direction - not the side "
    "price approached a line from, which is the mistake that produced longs inside downtrends in "
    "an earlier version of this code.", BODY))
A(Paragraph(
    "<b>Two entries can then fire, and they are parts of one method rather than rivals.</b> A "
    "<b>Kumo breakout</b> when price leaves the cloud and the cloud 26 bars ahead twists to agree. "
    "A <b>Tenkan/Kijun pullback</b> when price already clear of the cloud comes back to a line and "
    "closes through Kijun on a candle of the trade's colour. <b>Chikou validates both.</b>", BODY))
A(Paragraph(
    "<b>The stop comes from the structure the entry is based on</b>, not from a volatility "
    "estimate. A pullback bets Kijun holds, so its stop sits just beyond Kijun. A breakout bets "
    "price has left the cloud, so its stop sits beyond the far edge of the cloud - inside it, the "
    "cloud the trade just crossed would take the position out.", BODY))
A(Paragraph(
    "<b>One trade per pair.</b> A signal is an instruction to open a trade, so while that trade is "
    "running another signal on the same pair is not a second opportunity - it is the same money, "
    "already committed. The pair goes silent from the bar a signal fires until price touches its "
    "stop or its target. This lives in the detector, so the live scanner, the browser and the "
    "backtest all inherit it; before it did, the scanner wrote every signal in its window as a "
    "separate open trade and one pair could hold eight at once while the backtest reported one.", BODY))
A(Paragraph(
    "<b>There is no EMA, no ATR, no RSI and no Stochastic anywhere in it.</b> A test reads every "
    "strategy file, strips the comments and fails the build if one appears.", BODY))

A(Paragraph("What changed, and why it is worth knowing", H2))
A(Paragraph(
    "This document replaced one that described <b>three selectable strategies</b>: a Kijun-band "
    "pullback of our own plus OANDA's two entry rules, each a separate detector, with chips in the "
    "interface to pick between them and a scanner that recorded all three so the history could "
    "compare them. Three things were wrong with that, and all three are fixed here rather than "
    "tuned:", BODY))

A(plain_rows([
    [Paragraph("<b>It misread the source</b>", CELLB),
     "The article presents its approaches as one method whose parts <i>work together</i>. Running "
     "them as rivals measured the parts against each other and never ran the method."],
    [Paragraph("<b>A shared exit hid the rules</b>", CELLB),
     "All three used the same stop - a fraction of the 26-bar range - so the comparison could be "
     "about entries alone. But the article points at Kijun and the Kumo as support and resistance, "
     "which means it does specify where a stop belongs, and a range-sized stop ignored it."],
    [Paragraph("<b>A guard was 26 bars too strict</b>", CELLB),
     "The detector refused to report until it had 104 bars, because the 26-bar range window was "
     "added on top of the cloud's 78 rather than taken as a maximum. A signal at bar 78 appeared "
     "in a 5000-bar run and vanished from an 80-bar run of the same candles."],
], [46 * mm, 119 * mm]))

A(KeepTogether([Paragraph("The pipeline", H2)] + code("""
candles the chart already holds (no extra request)
    |
    +--> a trade is already running here, and this bar did not reach
    |    its stop or target ....................... silent: no signal
    |
    v
Ichimoku: Tenkan(9) Kijun(26) Senkou A/B Chikou, cloud 26 ahead, 26-bar range
    |
    +--> close INSIDE the Kumo ................ no trade: no trend to join
    |
    +--> close CROSSED out of it this bar ..... arm a BREAKOUT
    |         waits up to 52 bars for Span A to cross Span B its way
    |         then Chikou must clear the close 26 bars back
    |         --> stop beyond the FAR cloud edge
    |
    +--> close ALREADY clear, bar touched a line ... arm a PULLBACK
              waits up to 26 bars for a close back through Kijun
              on a candle of the trade's colour, Chikou clear
              --> stop just beyond KIJUN

a signal opens a trade, and the pair is silent again until it is decided
""")))

A(Paragraph("Where the distances come from, with no ATR", H2))
A(Paragraph(
    "The stop LEVEL is structural, but the small buffer beyond it still needs a distance, and so "
    "does any sense of how big a move is. Ichimoku already contains one, because <b>Kijun-sen IS "
    "the midpoint of the 26-bar high-low range</b>:", BODY))
S.extend(code("""
Kijun = (highest high + lowest low) / 2      over the last 26 bars

so   highest high - lowest low               is a volatility measure that is
                                             already part of the indicator
"""))
A(Paragraph(
    "The buffer is <b>0.1x</b> that range. That fraction is ours; the article names the structure "
    "but not a distance.", BODY))

# ----------------------------- page 2 -----------------------------

A(Paragraph("What each entry requires", H2))
A(Paragraph(
    "The two entries do not share a checklist, and they do not even have the same NUMBER of "
    "conditions. Every stored signal carries its own, which is why the database holds them as a "
    "list rather than as named columns.", BODY))

A(Paragraph("Tenkan/Kijun pullback - four required", H3))
A(plain_rows([
    [Paragraph("1", CELLB), "Price above the Cloud (below, for a short) - the close, not the wick"],
    [Paragraph("2", CELLB), "Tenkan-sen above Kijun-sen, on the trade's side"],
    [Paragraph("3", CELLB), "A pullback that touched or dipped slightly below Tenkan or Kijun"],
    [Paragraph("4", CELLB), "A close back through Kijun on a candle of the trade's colour"],
    [Paragraph("+", CELLB), Paragraph("Chikou clear of its prior 26-period close. <b>This one is a "
                                      "reading, not a quotation</b>: the article attaches Chikou to the "
                                      "breakout and separately says the approaches work together. It is a "
                                      "config flag, measured both ways, and it decides very little - "
                                      "turning it off admits about eight more trades and moves the average "
                                      "by 0.2 pips.", CELL)],
], [10 * mm, 155 * mm]))

A(Paragraph("Kumo breakout - three required, one grade", H3))
A(plain_rows([
    [Paragraph("1", CELLB), "Price breaks out of the cloud - a TRANSITION, not a state. Price that has "
                            "sat above the cloud for fifty bars has not broken above it"],
    [Paragraph("2", CELLB), "The cloud 26 bars ahead twists to agree (Span A crossing Span B)"],
    [Paragraph("3", CELLB), "Chikou clear of its prior 26-period close"],
    [Paragraph("~", CELLB), Paragraph("Cloud thickness at the break - a <b>grade, not a gate</b>. The "
                                      "article calls a break through a thick cloud 'more significant', "
                                      "which is not the same as a requirement, so it is recorded and "
                                      "shown but never blocks a signal.", CELL)],
], [10 * mm, 155 * mm]))

A(Paragraph(
    "Both are <b>two-stage</b>, and that is structural rather than incidental. In the article's own "
    "USD/JPY example the dip is in the morning and the confirming hourly close is at 1pm; in both "
    "of its breakout examples the span twist arrives after the break, three hours later on AUD/USD "
    "and twenty-six on NZD/USD. A single-bar test of either rule would reject the article's own "
    "illustrations, so each entry arms on the first event and waits for the second.", BODY))
A(Paragraph(
    "The waiting windows are ours - the article sets no limit - and their measured behaviour is "
    "pinned by tests rather than assumed. The <b>confirmation window never binds</b>: the close "
    "that confirms a pullback arrives on the very next bar in 537 of 560 cases, and the longest "
    "wait on any pair is 6 bars, so at 26 it is a guard against a stale setup rather than a tuning "
    "knob. The <b>twist window trades one entry for the other</b>: a breakout waiting for its twist "
    "holds the pair, so shortening the wait releases it and a pullback fires instead - which is why "
    "tightening it adds a handful of signals while removing more.", BODY))

A(PageBreak())

# ----------------------------- page 3 -----------------------------

A(Paragraph("Two real signals, end to end", H2))
A(Paragraph(
    "Both from <b>fixtures/market/EURUSD_1H.csv</b>, the checked-in OANDA candles the tests run on. "
    "Every number below is the detector's own output, not a reconstruction.", BODY))

A(Paragraph("A pullback: EUR/USD, bar opening 2025-12-10 20:00 UTC", H3))
S.extend(code("""
the bar      O 1.16782   H 1.16998   L 1.16738   C 1.16941
the lines    Tenkan 1.16637   Kijun 1.16607   Senkou A 1.16355   Senkou B 1.16437
             26-bar range 78.2 pips

1. close 1.16941 is above the Kumo (1.16355 / 1.16437) ......... LONG
2. Tenkan 1.16637 is above Kijun 1.16607 ....................... agrees
3. one bar earlier the low reached 1.16470, under Kijun ........ the pullback
4. this bar closed 1.16941 > Kijun, open 1.16782 < close ....... bullish candle
5. Chikou: close 1.16941 vs 1.16243 twenty-six bars back ....... clear

   stop LEVEL = Kijun 1.16607, less 0.1 x 78.2 pips of buffer
   entry 1.16941   stop 1.16529   target 1.17765   risk 41.2 pips
"""))
A(Paragraph(
    "It resolved at the target: <b>+81.4 pips after 88 bars.</b>", BODY))

A(Paragraph("A breakout: EUR/USD, bar opening 2025-12-08 08:00 UTC", H3))
S.extend(code("""
the bar      O 1.16582   H 1.16625   L 1.16482   C 1.16561
the lines    Kijun 1.16501   Senkou A 1.16565   Senkou B 1.16589
             cloud 26 ahead: Span A 1.16530   Span B 1.16550
             26-bar range 44.2 pips

1. close 1.16561 broke BELOW the cloud on this bar .............. SHORT
2. cloud ahead: Span A 1.16530 < Span B 1.16550 ................. turning bearish
3. Chikou: close 1.16561 vs 1.16594 twenty-six bars back ........ clear
~  the cloud was 2.5 pips thick at the break .................... thin: graded,
                                                                  not blocked

   stop LEVEL = the FAR cloud edge, Senkou B 1.16589, plus the buffer
   entry 1.16561   stop 1.16633   target 1.16417   risk 7.2 pips
"""))
A(Paragraph(
    "It resolved at the target: <b>+13.4 pips after 6 bars.</b>", BODY))
A(Paragraph(
    "Put side by side the two show why every result in this document is split by entry: the same "
    "pair, two days apart, risking <b>41.2 pips</b> and <b>7.2 pips</b>. Averaging them would add "
    "unlike bets. <b>Both of these won, and that is how they were chosen</b> - a resolved trade "
    "reads better than an open one. The measured result over all 430 trades is on the next page "
    "and it is a loss.", BODY))

A(PageBreak())

# ----------------------------- page 4 -----------------------------

A(Paragraph("What it measures", H2))
A(Paragraph(
    "The five traded pairs, 5000 1H bars each, 3 Dec 2025 - 23 Sep 2026, one pip of cost charged "
    "against the "
    "price. Entry at the signal bar's close; the trade is live from the next bar; when one bar "
    "covers both the stop and the target the stop wins, because OHLC cannot order the two and the "
    "alternative invents wins.", BODY))
A(Paragraph(
    "One trade per pair means every signal becomes a trade: 434 signals, 434 trades, none crowded "
    "out and none filtered. Of those, <b>430 resolved</b> inside the data and 4 were still running "
    "when it ended; the table counts the 430, because an open trade has no result to report and "
    "assuming one either way is how a losing run gets hidden.", BODY))

A(table(
    ["Entry", "Trades", "Win", "Average", "95% interval", "Avg stop"],
    [
        ["Pullback", "243", "34.2%", chip("-0.67 pips", AMBER), "-9.65 ... +8.31", "39.3 pips"],
        ["Kumo breakout", "187", "31.0%", chip("-13.13 pips", RED), chip("-22.35 ... -3.91", RED), "43.1 pips"],
        [Paragraph("<b>Both (live)</b>", CELLB), Paragraph("<b>430</b>", CELLB),
         Paragraph("<b>32.8%</b>", CELLB), chip("-6.09 pips", RED),
         Paragraph("<b>-12.57 ... +0.40</b>", CELLB), Paragraph("<b>40.9 pips</b>", CELLB)],
    ],
    [34 * mm, 19 * mm, 17 * mm, 25 * mm, 38 * mm, 22 * mm],
    aligns={1: "RIGHT", 2: "RIGHT", 3: "RIGHT", 5: "RIGHT"}))
A(Paragraph(
    "A 2:1 target needs <b>33.3%</b> to break even. The system as a whole gets 32.8%.", BODY))
A(Paragraph(
    "<b>The breakout's interval does not contain zero.</b> That is the first statistically "
    "significant result this project has produced, and it only became visible once signals the "
    "account could never have acted on were removed: on 187 trades the Kumo breakout loses 13.1 "
    "pips each, with an interval running from -22.4 to -3.9. The pullback over the same period is "
    "roughly break-even - it clears the win rate it needs (34.2% against 33.3%) and still gives up "
    "two thirds of a pip a trade to costs. So the combined figure is not one weak edge; it is a "
    "flat entry and a losing one, averaged together.", BODY))

A(Paragraph("The sign holds in both halves", H3))
A(table(
    ["Period", "Trades", "Win", "Average"],
    [
        ["First half", "280", "33.6%", chip("-5.57 pips", RED)],
        ["Second half", "150", "31.3%", chip("-7.05 pips", RED)],
    ],
    [50 * mm, 25 * mm, 25 * mm, 35 * mm],
    aligns={1: "RIGHT", 2: "RIGHT", 3: "RIGHT"}))
A(Paragraph(
    "This matters because the strategy this document used to describe showed the opposite pattern - "
    "roughly break-even on the hard first period and strongly positive on the kind second one, "
    "which is the signature of a period rather than of a rule. Here both periods lose and the win "
    "rate barely moves.", BODY))

A(Paragraph("Is it the entries, or our exit?", H3))
A(Paragraph(
    "Worth separating, because the target is entirely ours and could be the whole problem. So: the "
    "forward return after every signal, with <b>no stop and no target</b> - where price actually "
    "went, with the exit rules taken away.", BODY))
A(table(
    ["Entry", "n", "1 bar", "4 bars", "12 bars", "26 bars", "52 bars", "104 bars"],
    [
        ["Pullback", "243", "+0.28", "-0.51", "-3.79", "+1.54", "+1.44", chip("+5.91", GREEN)],
        ["Kumo breakout", "187", "-0.94", "-3.18", "-3.66", "-3.15", chip("-5.41", RED), chip("-11.51", RED)],
    ],
    [30 * mm, 15 * mm, 17 * mm, 18 * mm, 19 * mm, 19 * mm, 19 * mm, 21 * mm],
    aligns={1: "RIGHT", 2: "RIGHT", 3: "RIGHT", 4: "RIGHT", 5: "RIGHT", 6: "RIGHT", 7: "RIGHT"}))
A(Paragraph(
    "<b>Read this with the sample size in mind.</b> It used to run on thousands of observations, "
    "because the detector emitted every signal whether or not the pair was free to take it. It now "
    "runs on the trades themselves - a tenth as many - so each figure is far noisier: at 4 bars the "
    "pullback's interval is [-3.20, +2.17] and the breakout's [-6.88, +0.52], neither significant "
    "alone. What the row SHAPES say is consistent with the walk-forward. Price drifts with the "
    "pullback over the following hundred bars and against the breakout, steadily, to -11.5 pips. An "
    "entry whose result decays the longer it is held is an entry taken after the move, not before "
    "it.", BODY))
A(Paragraph(
    "<b>So it is mostly not the exit.</b> Sweeping the reward multiple never finds a setting that "
    "works: the edge over break-even is +0.1, +0.8 and +1.5 points at 0.5:1, 1:1 and 1.5:1 and "
    "negative at 2, 3 and 5, and the average per trade is negative at every one of them. Widening "
    "the stop buffer only makes it worse. The nearest thing to a usable setting is 1.5:1, the one "
    "row where the win rate beats break-even by more than a point - and it still loses 2.73 pips a "
    "trade after costs.", BODY))
A(Paragraph(
    "<b>None of this says OANDA's rules are bad.</b> It says that on 1H majors over nine months, "
    "implemented as faithfully as the article can be read, they did not produce a measurable edge "
    "in this harness. The article itself is explicit that the Cloud \"performs poorly in tight, "
    "choppy, or scalping conditions\", and hourly FX majors spend a great deal of time exactly "
    "there.", BODY))


# ----------------------------- page 5 -----------------------------

A(Paragraph("What this does not tell you", H2))
A(plain_rows([
    [Paragraph("<b>Not every traded pair</b>", CELLB),
     "USD/CHF and NZD/USD are scanned live and have no checked-in candles."],
    [Paragraph("<b>Wrong timeframe</b>", CELLB),
     "The scanner runs 30M and every fixture is 1H. Nothing here is settled for the timeframe "
     "actually traded."],
    [Paragraph("<b>One period</b>", CELLB),
     "Dec 2025 - Sep 2026 is nine months of one regime."],
    [Paragraph("<b>Correlated pairs</b>", CELLB),
     "EUR/USD, GBP/USD and AUD/USD are largely the same dollar trade, so 430 trades are worth "
     "fewer than 430 independent observations and the interval is narrower than it should be."],
    [Paragraph("<b>One check, not two</b>", CELLB),
     "The forward-return table used to run on thousands of raw signals and was an independent "
     "check on the walk-forward. With one trade per pair it runs on the same 430 trades, so it "
     "corroborates that result rather than testing it from outside."],
    [Paragraph("<b>Flat costs</b>", CELLB),
     "Real spreads widen at the open and on news. Swap is not modelled."],
    [Paragraph("<b>In-sample</b>", CELLB),
     "Every setting that is ours was chosen after seeing these candles."],
], [38 * mm, 127 * mm]))

A(Paragraph("How the claim \"pure Ichimoku\" is kept true", H2))
A(Paragraph(
    "A promise like this rots quietly. Someone adds an ATR floor under the stop because a thin "
    "cloud produced a 3-pip one, nothing fails, and a year later the strategy is a hybrid again. "
    "The article's own closing suggestion - pair the Cloud with RSI or Stochastic - is exactly the "
    "kind of reasonable addition that would arrive one day.", BODY))
A(Paragraph(
    "So it is checked mechanically rather than by review: a test reads the source of every strategy "
    "file, strips the comments, and fails if the words EMA or ATR appear anywhere in the code.", BODY))
S.extend(code("""
ichimokuSystem.ts   ichimokuStrategy.ts   ichimokuBars.ts
cloudZones.ts       signalTicket.ts       tradePlan.ts

    for each: strip comments, then fail on /\\bema\\b/i or /\\batr\\b/i
"""))

A(Paragraph("In one line", H2))
A(Paragraph(
    "<b>The Kumo sets the direction; a break out of it or a pullback back into Kijun sets the "
    "entry; Chikou validates both; the stop sits beyond whichever structure the entry was based "
    "on; one trade runs per pair at a time; and on 25,000 bars of real candles the whole thing "
    "came out at -6.09 pips a trade - the pullback roughly flat, the breakout losing 13.1 pips a "
    "trade with an interval that excludes zero - which is the honest answer and the reason it is "
    "written down rather than tuned away.</b>", BODY))

doc.build(S)
print(f"wrote {OUT}")
