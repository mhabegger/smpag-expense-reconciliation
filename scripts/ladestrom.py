"""Monthly home-charging statement for the company car (Heimladung Dienstwagen).

Reads the Volkswagen/Elli "charging statistics" CSV export (any period) and
writes one PDF per requested month: all sessions that STARTED in that month
(Swiss time), total kWh × agreed tariff, place/date and a signature line.
The month's raw CSV rows are embedded in the PDF as an attachment and the
SHA-256 of the full export is printed, so the figures can be re-checked.

    python scripts/ladestrom.py <export.csv> <YYYY-MM> <out.pdf> [--price 0.2921] [--ort Fribourg]
"""
import argparse
import csv
import hashlib
import io
from datetime import date, datetime
from zoneinfo import ZoneInfo

from pypdf import PdfReader, PdfWriter
from reportlab.lib.colors import Color, black, grey
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

ZH = ZoneInfo('Europe/Zurich')
BLUE = Color(0.12, 0.35, 0.75)
W, H = A4
LEFT, RIGHT = 50, W - 50
MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August',
          'September', 'Oktober', 'November', 'Dezember']
AGREEMENT = 'Gem. Vereinbarung über die Abrechnung der Ladevorgänge des Dienstwagens vom 03.01.2025'
COLS = [('Nr.', 32), ('Beginn', 108), ('Ende', 108), ('Dauer', 80), ('Energie', 80), ('Betrag CHF', 87)]


def local(ts):
    return datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone(ZH)


def duration(sec):
    m = int(float(sec or 0)) // 60
    return f'{m // 1440}d {m % 1440 // 60}h {m % 60:02d}m' if m >= 1440 else f'{m // 60}h {m % 60:02d}m'


def chf(x):
    return f"{x:,.2f}".replace(',', "'")


def build(rows, month, price, args, sha, export_name, n_pages_hint=None):
    y_, m_ = map(int, month.split('-'))
    total_kwh = round(sum(float(r['Total charge quantity (kWh)'] or 0) for r in rows), 2)
    total = round(total_kwh * price, 2)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    page = [1]

    def footer():
        c.setFillColor(grey)
        c.setFont('Helvetica', 7)
        c.drawString(LEFT, 30, f'Heimladung Dienstwagen · {MONTHS[m_ - 1]} {y_} · {args.name}')
        c.drawRightString(RIGHT, 30, f'Seite {page[0]}')
        c.setFillColor(black)

    def table_header(y):
        c.setLineWidth(0.8)
        c.rect(LEFT, y - 22, RIGHT - LEFT, 22)
        c.setFont('Helvetica-Bold', 9)
        x = LEFT
        for name, w in COLS:
            c.drawCentredString(x + w / 2, y - 14, name)
            x += w
            if x < RIGHT - 1:
                c.line(x, y, x, y - 22)
        return y - 22

    # ---- header ---------------------------------------------------------
    y = H - 60
    c.setFont('Helvetica-Bold', 18)
    c.drawString(LEFT, y, 'HEIMLADUNG DIENSTWAGEN')
    c.setFont('Helvetica', 11)
    c.drawString(LEFT, y - 17, f'Abrechnung Ladestrom {MONTHS[m_ - 1]} {y_}')
    c.setFont('Helvetica-Oblique', 8)
    c.drawRightString(RIGHT, y + 4, 'Quelle: Volkswagen / Elli Ladestatistik (CSV-Export)')

    y -= 52
    c.setFont('Helvetica-Bold', 8.5)
    lines = [
        ('Erstellt am:', date.today().strftime('%d.%m.%Y')),
        ('Abrechnungsperiode:', f'01.{m_:02d}.{y_} – {_last_day(y_, m_):02d}.{m_:02d}.{y_}'),
        ('Name:', args.name),
        ('Firma:', args.firma),
        ('Ladevorgänge:', str(len(rows))),
        ('Gesamtverbrauch:', f'{total_kwh:.2f} kWh'),
    ]
    for i, (k, v) in enumerate(lines):
        c.setFont('Helvetica-Bold', 8.5)
        c.drawString(LEFT, y - i * 12, k)
        c.setFont('Helvetica', 8.5)
        c.drawString(LEFT + 92, y - i * 12, v)

    bx = LEFT + 300
    c.setFillColor(BLUE)
    c.setFont('Helvetica', 9.5)
    t = c.beginText(bx, y)
    t.setLeading(12)
    for line in ('Gem. Vereinbarung über die Abrechnung', 'der Ladevorgänge des Dienstwagens', 'vom 03.01.2025', '',
                 f'Strompreis Groupe E, Doppeltarif (Hochtarif) {y_}:', f'CHF {price:.4f} pro kWh inkl. MwSt.', ''):
        t.textLine(line)
    c.drawText(t)
    c.setFont('Helvetica-Bold', 10.5)
    c.drawString(bx, y - 86, f'{total_kwh:.2f} kWh × CHF {price:.4f} = CHF {chf(total)}')
    c.setFillColor(black)

    # ---- sessions table -------------------------------------------------
    y -= 118
    y = table_header(y)
    row_h = 15
    for i, r in enumerate(rows, 1):
        if y - row_h < 205 and i < len(rows):
            footer()
            c.showPage()
            page[0] += 1
            y = table_header(H - 60)
        kwh = float(r['Total charge quantity (kWh)'] or 0)
        cells = [str(i), local(r['Started']).strftime('%d.%m.%Y %H:%M'), local(r['Ended']).strftime('%d.%m.%Y %H:%M'),
                 duration(r['Charging time (s)']), f'{kwh:.2f} kWh', chf(kwh * price)]
        c.setLineWidth(0.4)
        c.rect(LEFT, y - row_h, RIGHT - LEFT, row_h)
        c.setFont('Helvetica', 8.5)
        x = LEFT
        for (name, w), val in zip(COLS, cells):
            if name in ('Energie', 'Betrag CHF'):
                c.drawRightString(x + w - 8, y - 11, val)
            else:
                c.drawCentredString(x + w / 2, y - 11, val)
            x += w
            if x < RIGHT - 1:
                c.line(x, y, x, y - row_h)
        y -= row_h
    # total row
    c.setLineWidth(0.8)
    c.rect(LEFT, y - 20, RIGHT - LEFT, 20)
    c.setFont('Helvetica-Bold', 9)
    c.drawString(LEFT + 8, y - 14, f'Total {MONTHS[m_ - 1]} {y_}')
    x_kwh = LEFT + sum(w for _, w in COLS[:5])
    c.drawRightString(x_kwh - 8, y - 14, f'{total_kwh:.2f} kWh')
    c.drawRightString(RIGHT - 8, y - 14, chf(total))
    y -= 20

    # ---- confirmation + signature ---------------------------------------
    if y < 205:
        footer()
        c.showPage()
        page[0] += 1
        y = H - 60
    y -= 26
    c.setFont('Helvetica-Bold', 10)
    c.drawString(LEFT, y, 'Bestätigung')
    c.setFont('Helvetica', 9)
    text = ('Ich bestätige, dass die aufgeführten Ladevorgänge den Dienstwagen an meiner Heimladestation betreffen '
            'und gemäss Vereinbarung vom 03.01.2025 zum Hochtarif abgerechnet werden. Der Betrag wurde nicht '
            'anderweitig abgerechnet.')
    from reportlab.pdfbase.pdfmetrics import stringWidth
    words, cur = text.split(), ''
    for w_ in words:
        if stringWidth(f'{cur} {w_}'.strip(), 'Helvetica', 9) > RIGHT - LEFT:
            y -= 12
            c.drawString(LEFT, y, cur)
            cur = w_
        else:
            cur = f'{cur} {w_}'.strip()
    y -= 12
    c.drawString(LEFT, y, cur)

    y -= 50
    c.setFont('Helvetica', 9.5)
    c.drawString(LEFT + 2, y + 4, f"{args.ort}, {args.datum or date.today().strftime('%d.%m.%Y')}")
    c.setLineWidth(0.5)
    c.line(LEFT, y, LEFT + 200, y)
    c.line(RIGHT - 210, y, RIGHT, y)
    c.setFont('Helvetica', 8.5)
    c.drawString(LEFT, y - 12, 'Ort, Datum')
    c.drawString(RIGHT - 210, y - 12, f'Unterschrift {args.name}')

    y -= 40
    c.setFont('Helvetica', 7.5)
    c.setFillColor(grey)
    c.drawString(LEFT, y, f'Datenquelle: {export_name} (Volkswagen/Elli Ladestatistik); Sitzungen nach Beginn (Schweizer Zeit) dem Monat zugeordnet.')
    c.drawString(LEFT, y - 10, 'Die Rohdaten dieses Monats sind als Anhang «sessions.csv» in diesem PDF eingebettet.')
    c.drawString(LEFT, y - 20, 'SHA-256 Export:')
    c.setFont('Courier', 7)
    c.drawString(LEFT + 60, y - 20, sha)
    footer()
    c.save()
    return buf.getvalue(), total_kwh, total


def _last_day(y, m):
    return (date(y + (m == 12), m % 12 + 1, 1) - date.resolution).day


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('csv')
    ap.add_argument('month')
    ap.add_argument('out')
    ap.add_argument('--price', type=float, default=0.2921)
    ap.add_argument('--ort', default='Fribourg')
    ap.add_argument('--datum', default=None, help='dd.mm.yyyy (default: today)')
    ap.add_argument('--name', default='Mathieu Habegger')
    ap.add_argument('--firma', default='SwissMediaPartners AG')
    args = ap.parse_args()

    raw = open(args.csv, 'rb').read()
    sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode('utf-8-sig')
    reader = csv.DictReader(io.StringIO(text))
    rows = [r for r in reader if local(r['Started']).strftime('%Y-%m') == args.month]
    rows.sort(key=lambda r: r['Started'])
    pdf, kwh, total = build(rows, args.month, args.price, args, sha, args.csv.replace('\\', '/').split('/')[-1])

    sessions = io.StringIO()
    w = csv.DictWriter(sessions, fieldnames=reader.fieldnames, quoting=csv.QUOTE_ALL)
    w.writeheader()
    w.writerows(rows)
    writer = PdfWriter()
    writer.append(PdfReader(io.BytesIO(pdf)))
    writer.add_attachment('sessions.csv', sessions.getvalue().encode('utf-8'))
    with open(args.out, 'wb') as f:
        writer.write(f)
    print(f'{args.month}: {len(rows)} sessions, {kwh:.2f} kWh, CHF {total:.2f} -> {args.out}')


if __name__ == '__main__':
    main()
