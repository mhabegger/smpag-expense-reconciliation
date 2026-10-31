"""Vertrauensspesenbeleg (Ersatzbeleg) for an expense whose original receipt is lost.

Page 1: the filled-in form (same layout as Michael's SMP template), to be signed.
Page 2+: the payment proof (card/bank statement PDF), appended byte-for-byte
unchanged; its SHA-256 is printed on page 1.

    python scripts/ersatzbeleg.py <spec.json> <statement.pdf> <out.pdf>

spec.json keys: firma, spesen_von, datum, anbieter, betrag, zahlungsart,
beleg_key, grund, anlass, personen, nachweis, ort (all strings);
optional datum_unterschrift (dd.mm.yyyy, defaults to today).
"""
import hashlib
import io
import json
import sys
from datetime import date

from pypdf import PdfReader, PdfWriter
from reportlab.lib.colors import Color, black, grey
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

BLUE = Color(0.12, 0.25, 0.55)
W, H = A4
LEFT, VALUE_X, RIGHT = 56, 250, W - 56


def wrap(text, width, font='Helvetica', size=9.5):
    lines, cur = [], ''
    for word in text.split():
        trial = f'{cur} {word}'.strip()
        if stringWidth(trial, font, size) <= width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    return lines + [cur] if cur else lines


def form_page(spec, sha, statement_name):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    y = H - 64
    c.setFillColor(BLUE)
    c.setFont('Helvetica-Bold', 19)
    c.drawString(LEFT, y, 'VERTRAUENSSPESENBELEG (ERSATZBELEG)')
    y -= 16
    c.setFillColor(black)
    c.setFont('Helvetica', 9)
    c.drawString(LEFT, y, f"Ersatz für eine nicht (mehr) vorhandene Originalquittung  ·  {spec['firma']}")

    y -= 34
    rows = [
        ('Firma:', spec['firma']),
        ('Spesen von:', spec['spesen_von']),
        ('Datum der Ausgabe:', spec['datum']),
        ('Leistungserbringer / Ort:', spec['anbieter']),
        ('Betrag:', spec['betrag']),
        ('Zahlungsart:', spec['zahlungsart']),
        ('Beleg-Key:', spec['beleg_key']),
        ('Grund Ersatzbeleg:', spec['grund']),
    ]
    for label, value in rows:
        c.setFont('Helvetica-Bold', 9.5)
        c.drawString(LEFT, y, label)
        c.setFont('Helvetica', 9.5)
        for i, line in enumerate(wrap(value, RIGHT - VALUE_X)):
            c.drawString(VALUE_X, y - i * 12, line)
        y -= 12 * max(1, len(wrap(value, RIGHT - VALUE_X))) + 8

    for label, value in (('Geschäftlicher Anlass:', spec['anlass']), ('Teilnehmende Personen:', spec['personen'])):
        y -= 6
        lines = wrap(value, RIGHT - VALUE_X - 6) or ['']
        lines += [''] * (2 - len(lines)) if len(lines) < 2 else []
        c.setFont('Helvetica-Bold', 9.5)
        c.drawString(LEFT, y - 4, label)
        c.setFont('Helvetica', 9.5)
        for line in lines:
            c.drawString(VALUE_X + 6, y, line)
            c.setStrokeColor(black)
            c.setLineWidth(0.5)
            c.line(VALUE_X, y - 5, RIGHT, y - 5)
            y -= 20
        y -= 4

    y -= 14
    c.setFont('Helvetica-Bold', 10)
    c.drawString(LEFT, y, 'Bestätigung')
    c.setFont('Helvetica', 9.5)
    text = (
        'Ich bestätige, dass die oben aufgeführte Ausgabe geschäftlich veranlasst war, dass die '
        'keine Originalquittung (mehr) vorliegt und dass diese Ausgabe nicht bereits anderweitig '
        'abgerechnet wurde. Als Nachweis der Zahlung liegt der Auszug aus der Konto-/Kartenabrechnung '
        'unverändert bei (ab Seite 2).'
    )
    for line in wrap(text, RIGHT - LEFT):
        y -= 13
        c.drawString(LEFT, y, line)

    y -= 58
    # place from the spec, date = day of signing (defaults to today)
    signed_on = spec.get('datum_unterschrift') or date.today().strftime('%d.%m.%Y')
    c.setFont('Helvetica', 9.5)
    c.drawString(LEFT + 2, y + 4, f"{spec.get('ort', '')}, {signed_on}".strip(', '))
    c.setLineWidth(0.5)
    c.line(LEFT, y, LEFT + 200, y)
    c.line(RIGHT - 210, y, RIGHT, y)
    c.setFont('Helvetica', 8.5)
    c.drawString(LEFT, y - 12, 'Ort, Datum')
    c.drawString(RIGHT - 210, y - 12, f"Unterschrift {spec['spesen_von']}")

    y -= 50
    c.setFillColor(BLUE)
    c.setFont('Helvetica-Bold', 10.5)
    c.drawString(LEFT, y, 'Nachweis der Zahlung (Original unverändert ab Seite 2)')
    c.setFillColor(black)
    c.setFont('Helvetica', 8.5)
    for line in wrap(spec['nachweis'], RIGHT - LEFT, size=8.5):
        y -= 12
        c.drawString(LEFT, y, line)
    y -= 12
    c.drawString(LEFT, y, f'Originaldatei: {statement_name}')
    y -= 12
    c.drawString(LEFT, y, 'SHA-256 Original:')
    c.setFont('Courier', 7.5)
    c.drawString(LEFT + 78, y, sha)

    c.setFillColor(grey)
    c.setFont('Helvetica', 7)
    c.drawString(LEFT, 36, f"{spec['beleg_key']}  ·  Seite 1 = Ersatzbeleg, folgende Seiten = Originalnachweis unverändert")
    c.save()
    return buf.getvalue()


def main(spec_path, statement_path, out_path):
    spec = json.load(open(spec_path, encoding='utf-8'))
    original = open(statement_path, 'rb').read()
    sha = hashlib.sha256(original).hexdigest()
    writer = PdfWriter()
    writer.append(PdfReader(io.BytesIO(form_page(spec, sha, statement_path.replace('\\', '/').split('/')[-1]))))
    writer.append(PdfReader(io.BytesIO(original)))
    with open(out_path, 'wb') as f:
        writer.write(f)
    print(out_path, 'sha256', sha)


if __name__ == '__main__':
    main(*sys.argv[1:4])
