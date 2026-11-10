"""Fill and flatten the owner-approved 73-field invoice; never reads private truth.

Usage:
  python scripts/build_invoices.py                      # all 300 PDFs into invoices/ (ignored)
  python scripts/build_invoices.py --invoices PO-2024-0001 PO-2022-0003 --output examples
  python scripts/build_invoices.py --check-only         # fill/flatten/verify all 300 in memory, write nothing

Requires pypdf and reportlab (installed by the owner). Outputs are synthetic PDF
fixtures, not accounts receivable. Every PDF is verified after flattening:
no form fields or widgets remain, every value is searchable, and each drawn field's
text fits inside its visible (clipped) area horizontally and vertically.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import sys
import textwrap
from collections import defaultdict
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ContentStream, NameObject
from reportlab.pdfbase.pdfmetrics import getFont, stringWidth

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
TEMPLATE = ROOT / 'templates' / 'paws-and-order-fillable-invoice.pdf'
NOTE_WIDTH, NOTE_LINES = 82, 4          # must match scripts/generate.py
FONT = 'Helvetica'                      # the template's /Helv field font


def load(name):
    with (DATA / name).open(newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def template_geometry(template):
    fields = template.get_fields() or {}
    if len(fields) != 73:
        sys.exit(f'Unexpected template fields: {len(fields)} (expected 73)')
    geometry = {}
    for reference in template.pages[0].get('/Annots', []):
        widget = reference.get_object()
        name = widget.get('/T')
        if not name:
            continue
        rect = widget['/Rect']
        da = str(widget.get('/DA', '/Helv 9 Tf'))
        match = re.search(r'\s([0-9]+(?:\.[0-9]+)?)\s+Tf', da)
        geometry[str(name)] = (float(rect[2]) - float(rect[0]), float(rect[3]) - float(rect[1]),
                               float(match.group(1)) if match else 9.0)
    return fields, geometry


def field_values(visit, client, patient, total, lines):
    values = {'invoice_no': visit['invoice_no'], 'issue_date': visit['issue_date'],
              'visit_date': visit['visit_date'], 'visit_id': visit['visit_id'],
              'client_name': client['client_name'], 'client_address_1': client['address'],
              'client_address_2': '', 'client_phone': client['phone'],
              'patient_name': '  ' + patient['pet_name'], 'breed': patient['breed'],
              'age': patient['age_years'], 'attending_veterinarian': visit['veterinarian'],
              'visit_type': visit['visit_type'],
              **{k: '$' + total[k] for k in ('services_total', 'products_total', 'subtotal', 'discount', 'tax', 'total_due')}}
    notes = textwrap.wrap(visit['visit_notes'], width=NOTE_WIDTH, break_long_words=False, break_on_hyphens=False)
    if len(notes) > NOTE_LINES:
        raise ValueError(f'{visit["invoice_no"]}: notes exceed {NOTE_LINES} lines')
    if len(' '.join(notes)) != len(visit['visit_notes']):
        raise ValueError(f'{visit["invoice_no"]}: unexpected note text loss')
    for ix, line in enumerate(notes, 1):
        values[f'visit_note_{ix}'] = line
    for section in ('service', 'product'):
        for line in sorted((x for x in lines if x['section'] == section), key=lambda x: int(x['line_number'])):
            for key in ('code', 'description', 'qty', 'unit_price', 'amount'):
                raw = line['quantity' if key == 'qty' else key]
                values[f'{section}_{line["line_number"]}_{key}'] = '$' + raw if key in ('unit_price', 'amount') else str(raw)
    return values, len(notes)


def prefill_checks(invoice, values, fields, geometry):
    unknown = set(values).difference(fields)
    if unknown:
        raise ValueError(f'{invoice}: values for unknown fields {sorted(unknown)}')
    for name, value in values.items():
        width, height, size = geometry[name]
        if stringWidth(str(value), FONT, size) > width - 4:
            raise ValueError(f'{invoice}: {name} text exceeds available field width')
        if size > height:
            raise ValueError(f'{invoice}: {name} font size exceeds field height')


def drawn_field_problems(reader, values):
    """Measure each flattened field's drawn text against its clipping rectangle."""
    face = getFont(FONT).face
    ascent, descent = face.ascent / 1000, face.descent / 1000
    problems, seen = [], set()
    for page in reader.pages:
        xobjects = page.get('/Resources', {}).get('/XObject', {})
        for key, ref in xobjects.items():
            name = str(key)[1:]
            if not name.startswith('Fm_'):
                continue
            field = name[3:]
            stream = ref.get_object()
            clip, origin, size, text = None, None, None, ''
            pending = None
            for operands, operator in ContentStream(stream, reader).operations:
                op = operator.decode('latin-1')
                if op == 're':
                    pending = [float(x) for x in operands]
                elif op == 'W' and pending:
                    clip = pending
                elif op == 'Tf':
                    size = float(operands[1])
                    if str(operands[0]) != '/Helv':
                        problems.append(f'{field}: unexpected font {operands[0]}')
                elif op == 'Td':
                    origin = (float(operands[0]), float(operands[1]))
                elif op == 'Tj':
                    text += str(operands[0])
            if field not in values:
                continue
            seen.add(field)
            if text != str(values[field]):
                problems.append(f'{field}: drawn text {text!r} differs from value {values[field]!r}')
                continue
            if not text:
                continue
            if clip is None or origin is None or size is None:
                problems.append(f'{field}: could not locate clip/position/font in appearance')
                continue
            cx, cy, cw, ch = clip
            x, y = origin
            right = x + stringWidth(text, FONT, size)
            if x < cx or right > cx + cw + 0.01:
                problems.append(f'{field}: text spans x {x:.1f}-{right:.1f} outside visible {cx:.1f}-{cx + cw:.1f}')
            if y + descent * size < cy - 0.01 or y + ascent * size > cy + ch + 0.01:
                problems.append(f'{field}: text height outside visible area')
    missing = {k for k, v in values.items() if v} - seen
    problems += [f'{k}: no drawn appearance found' for k in sorted(missing)]
    return problems


def build_one(template, values):
    writer = PdfWriter()
    writer.clone_document_from_reader(template)
    writer.update_page_form_field_values(None, values, auto_regenerate=False, flatten=True)
    writer.remove_annotations(subtypes='/Widget')
    writer.root_object.pop(NameObject('/AcroForm'), None)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def verify(invoice, data, values):
    check = PdfReader(io.BytesIO(data))
    if check.get_fields():
        raise ValueError(f'{invoice}: form fields remain')
    if any(a.get_object().get('/Subtype') == '/Widget' for page in check.pages for a in page.get('/Annots', [])):
        raise ValueError(f'{invoice}: widgets remain')
    searchable = ''.join(' '.join((p.extract_text() or '') for p in check.pages).split()).casefold()
    for field_name, needle in values.items():
        if needle and ''.join(str(needle).split()).casefold() not in searchable:
            raise ValueError(f'{invoice}: missing PDF field {field_name}={needle!r}')
    problems = drawn_field_problems(check, values)
    if problems:
        raise ValueError(f'{invoice}: visual overflow check failed: ' + '; '.join(problems[:5]))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--invoices', nargs='+', help='build only these invoice numbers')
    parser.add_argument('--config', type=Path, help='build the invoices listed in a JSON file with an "invoices" array')
    parser.add_argument('--output', type=Path, default=ROOT / 'invoices', help='output folder (default: invoices/)')
    parser.add_argument('--check-only', action='store_true', help='verify in memory; write no files')
    args = parser.parse_args(argv)

    template = PdfReader(str(TEMPLATE))
    fields, geometry = template_geometry(template)
    clients = {x['client_id']: x for x in load('clients.csv')}
    patients = {x['patient_id']: x for x in load('patients.csv')}
    totals = {x['invoice_no']: x for x in load('invoice_totals.csv')}
    items = defaultdict(list)
    for x in load('invoice_items.csv'):
        items[x['invoice_no']].append(x)
    visits = load('visits.csv')
    if args.config:
        args.invoices = json.loads(args.config.read_text(encoding='utf-8'))['invoices']
    if args.invoices:
        wanted = set(args.invoices)
        unknown = wanted - {v['invoice_no'] for v in visits}
        if unknown:
            sys.exit(f'Unknown invoice numbers: {", ".join(sorted(unknown))}')
        visits = [v for v in visits if v['invoice_no'] in wanted]

    output = args.output.resolve()
    if not args.check_only:
        output.mkdir(parents=True, exist_ok=True)
    manifest = []
    for visit in visits:
        invoice = visit['invoice_no']
        values, note_lines = field_values(visit, clients[visit['client_id']], patients[visit['patient_id']],
                                          totals[invoice], items[invoice])
        prefill_checks(invoice, values, fields, geometry)
        data = build_one(template, values)
        verify(invoice, data, values)
        record = dict(invoice_no=invoice, filename=invoice + '.pdf', sha256=hashlib.sha256(data).hexdigest(),
                      searchable_text_verified=True, populated_fields_verified=len(values),
                      note_lines_verified=note_lines, visual_fit_verified=True, widgets_remaining=0)
        manifest.append(record)
        if not args.check_only:
            (output / record['filename']).write_bytes(data)
    if args.check_only:
        print(f'PASS: {len(manifest)} invoices filled, flattened and verified in memory (no files written)')
        return
    (output / 'invoice_manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f'PASS: {len(manifest)} flattened, searchable PDFs written to {output}; '
          'fields, text and visual fit verified; SHA-256 manifest written')


if __name__ == '__main__':
    main()
