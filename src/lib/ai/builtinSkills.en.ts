/**
 * 내장 스킬의 영어판.
 *
 * 한국어판(`builtinSkills.ts`)과 **같은 절차**를 영어로 적은 것이다. 번역이라기보다
 * 나란히 유지하는 두 벌이라, 한쪽 절차를 고치면 반드시 다른 쪽도 함께 고친다
 * (스킬 이름·`description` 의 첫 줄이 어긋나면 `mergeSkills` 가 다른 스킬로 본다).
 *
 * 스킬 본문은 모델이 그대로 따라 하는 글이라 사전(`i18n/ko.ts`)에 넣지 않았다 —
 * 한 항목이 100줄짜리 마크다운이면 사전이 아니라 문서다.
 */

/** 세 문서 스킬이 공통으로 먼저 밟는 절차. */
const PYTHON_PRELUDE_EN = `## 0. Check the environment (every time, first)

1. Run \`python --version\`. If that fails, on Windows also try \`py -3 --version\`.
   If neither exists, ask the user to install Python and stop here — do not install it yourself.
2. Check for the packages you need: \`python -c "import <module>"\`.
   On ImportError, install with \`python -m pip install <package>\`.
3. Do not write long scripts into the conversation. Save them to
   \`.agent_workspace/tmp/<task>.py\` and run \`python .agent_workspace/tmp/<task>.py\`.
   That folder is not committed to git.
4. Anything that modifies an original file **must copy it first** (\`copy\` / \`shutil.copy2\`).
   Document libraries rewrite the whole file on save, so a failure destroys the original.`;

const XLSX_SKILL_EN = `---
name: xlsx
description: Reading, creating or editing Excel files (.xlsx/.xlsm). Use openpyxl for sheets, cells, formulas and formatting; use pandas to aggregate large tables.
---

# Working with Excel files (openpyxl)

${PYTHON_PRELUDE_EN}

Packages: \`openpyxl\` (plus \`pandas\` if you need to aggregate).
openpyxl cannot open \`.xls\` (the legacy binary format) — ask the user to convert it to \`.xlsx\`,
or use \`libreoffice --headless --convert-to xlsx\` if it is available.

## 1. Reading — start with the structure

Look at the sheet names and the table's bounds before printing cells. Never dump the whole
workbook as a string (it eats the entire context).

\`\`\`python
from openpyxl import load_workbook
wb = load_workbook("report.xlsx", data_only=True)  # data_only=True: last computed value, not the formula
print(wb.sheetnames)
ws = wb["Sheet1"]
print(ws.dimensions, ws.max_row, ws.max_column)
for row in ws.iter_rows(min_row=1, max_row=5, values_only=True):
    print(row)                                     # skim 5 header rows to learn the columns
\`\`\`

- Saving a workbook opened with \`data_only=True\` **replaces every formula with its value**.
  Use it read-only; to edit, reopen with \`data_only=False\` (the default).
- A computed value of \`None\` means Excel has never calculated that file. openpyxl cannot
  evaluate formulas, so compute the values yourself if you need them.
- For tens of thousands of rows, open with \`load_workbook(..., read_only=True)\` and stream.
- For aggregation and pivots, \`pandas.read_excel(path, sheet_name=..., header=...)\` is far shorter.

## 2. Creating

\`\`\`python
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active
ws.title = "Revenue"
ws.append(["Month", "Revenue", "Note"])             # header
for cell in ws[1]:
    cell.font = Font(bold=True)
    cell.fill = PatternFill("solid", fgColor="EEEEEE")
    cell.alignment = Alignment(horizontal="center")

for row in [("Jan", 1200000, ""), ("Feb", 980000, "Holiday week")]:
    ws.append(row)

ws["B2"].number_format = "#,##0"                    # formats are per cell
ws.freeze_panes = "A2"                              # freeze the header
ws.auto_filter.ref = ws.dimensions
for i, width in enumerate([10, 14, 20], start=1):   # set widths yourself — there is no autofit
    ws.column_dimensions[get_column_letter(i)].width = width

wb.save("revenue.xlsx")
\`\`\`

- Formulas go in as strings: \`ws["B5"] = "=SUM(B2:B4)"\`. Excel computes them when it opens the file.
- For charts, use \`BarChart\`/\`LineChart\` plus \`Reference\` from \`openpyxl.chart\`.

## 3. Editing an existing file

\`\`\`python
import shutil
from openpyxl import load_workbook

shutil.copy2("original.xlsx", "original.backup.xlsx")  # 1) copy first
wb = load_workbook("original.xlsx")                    # 2) keep formulas (do not set data_only)
ws = wb["Sheet1"]
ws.insert_rows(2)                                      # inserting rows/cols does NOT shift formula refs
ws["A2"], ws["B2"] = "Month 0", 0
wb.save("original.xlsx")                               # 3) overwrite under the same name
\`\`\`

- **What openpyxl does not preserve**: some charts, images, pivot tables, VBA (open \`.xlsm\`
  with \`keep_vba=True\` to keep macros alive), parts of conditional formatting.
  Before editing such a file, tell the user what may be lost.
- Merge with \`ws.merge_cells("A1:C1")\`, split with \`ws.unmerge_cells\`. Only the top-left cell
  of a merged range holds a value.

## 4. Finishing

- Reopen the saved file, verify the row count and the key cell values, then report back.
- The report must name **the path, the sheet and the range you changed**. Not just "done".`;

const DOCX_SKILL_EN = `---
name: docx
description: Reading, creating or editing Word files (.docx). Use python-docx for paragraphs, tables and styles; when formatting must survive, reuse the document's existing styles.
---

# Working with Word files (python-docx)

${PYTHON_PRELUDE_EN}

Package: \`python-docx\` (the import name is \`docx\` — careful, \`pip install docx\` is a **different**
package). Legacy \`.doc\` cannot be opened → convert with
\`libreoffice --headless --convert-to docx\`, or ask the user for a \`.docx\`.

## 1. Reading

\`\`\`python
from docx import Document
doc = Document("contract.docx")
for i, p in enumerate(doc.paragraphs[:40]):
    if p.text.strip():
        print(i, p.style.name, "|", p.text[:100])
for t_i, table in enumerate(doc.tables):
    print("table", t_i, len(table.rows), "x", len(table.columns))
    print([c.text for c in table.rows[0].cells])
\`\`\`

- To walk paragraphs and tables in document order, iterate \`doc.element.body\`
  (\`doc.paragraphs\` and \`doc.tables\` know nothing about each other's order).
- Headers and footers live separately, on \`doc.sections[0].header/.footer\`.

## 2. Creating

\`\`\`python
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()                                  # start from the default template (styles included)
doc.add_heading("H1 2026 report", level=1)
p = doc.add_paragraph("Summary: ")
p.add_run("revenue is up 12% year over year.").bold = True
p.alignment = WD_ALIGN_PARAGRAPH.LEFT

table = doc.add_table(rows=1, cols=3)
table.style = "Table Grid"                        # only style names present in the template work
head = table.rows[0].cells
head[0].text, head[1].text, head[2].text = "Month", "Revenue", "Note"
row = table.add_row().cells
row[0].text, row[1].text = "Jan", "1,200,000"

doc.add_page_break()
doc.save("report.docx")
\`\`\`

- Set a font explicitly when the text is not Latin, or it renders as boxes:
  \`style = doc.styles["Normal"]; style.font.name = "Malgun Gothic"; style.font.size = Pt(10)\`.
  East Asian fonts also need the XML attribute to apply fully —
  \`style.element.rPr.rFonts.set(qn("w:eastAsia"), "Malgun Gothic")\` (\`from docx.oxml.ns import qn\`).
- If the user gave you a template, **open that file** with \`Document("template.docx")\` and fill it in.
  Do not imitate its formatting from a blank document — it will never match.

## 3. Editing

\`\`\`python
import shutil
from docx import Document

shutil.copy2("original.docx", "original.backup.docx")
doc = Document("original.docx")
for p in doc.paragraphs:
    if "{{customer}}" in p.text:
        for run in p.runs:                        # replace per run so formatting survives
            run.text = run.text.replace("{{customer}}", "Jane Doe")
doc.save("original.docx")
\`\`\`

- **Assigning \`p.text = ...\` wipes every bit of formatting in that paragraph.** Edit the runs.
- The target string may be split across runs (spell-check does that). If the paragraph text
  contains it but no single run does, put the joined text into the first run and blank the rest.
- Delete a paragraph with \`p._element.getparent().remove(p._element)\`.

## 4. Finishing

- Reopen the saved file and confirm the paragraph count and that your replacements landed.
- If the document had tables or images, report what survived and what changed.`;

const PDF_SKILL_EN = `---
name: pdf
description: Reading PDFs (text and table extraction), creating them (reportlab), or editing them (merge, split, rotate, watermark). For scans, decide whether OCR is needed first.
---

# Working with PDFs (pypdf · pdfplumber · reportlab)

${PYTHON_PRELUDE_EN}

Packages: \`pypdf\` to read and edit, \`pdfplumber\` for tables and coordinates, \`reportlab\` to create.

## 1. Reading — first decide whether it is a text PDF

\`\`\`python
from pypdf import PdfReader
reader = PdfReader("document.pdf")
print(len(reader.pages), reader.metadata)
text = reader.pages[0].extract_text() or ""
print(len(text), text[:300])
\`\`\`

- If the extracted text is nearly empty, it is a **scanned image PDF**. pypdf cannot read it →
  tell the user and ask whether to use OCR (\`ocrmypdf\`, Tesseract). Do not install heavy tools on your own.
- For tables, use pdfplumber, which also gives you layout information:

\`\`\`python
import pdfplumber
with pdfplumber.open("document.pdf") as pdf:
    page = pdf.pages[0]
    print(page.extract_text())
    for table in page.extract_tables():
        for row in table[:5]:
            print(row)
\`\`\`

- With many pages, do not extract everything into the context. Read only the pages you need,
  or write the extraction to a file and grep the part you want.

## 2. Creating

For plain tables and paragraphs, use reportlab's platypus.

\`\`\`python
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib import colors

doc = SimpleDocTemplate("report.pdf", pagesize=A4,
                        leftMargin=20*mm, rightMargin=20*mm,
                        topMargin=20*mm, bottomMargin=20*mm)
styles = getSampleStyleSheet()
story = [Paragraph("H1 2026 report", styles["Title"]), Spacer(1, 6*mm)]
data = [["Month", "Revenue"], ["Jan", "1,200,000"], ["Feb", "980,000"]]
table = Table(data, colWidths=[30*mm, 40*mm])
table.setStyle(TableStyle([
    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
    ("BACKGROUND", (0, 0), (-1, 0), colors.whitesmoke),
    ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
]))
story.append(table)
doc.build(story)
\`\`\`

- **Non-Latin text renders as boxes unless you register a font.** Register a system font:

\`\`\`python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont("Malgun", r"C:\\Windows\\Fonts\\malgun.ttf"))  # macOS: AppleGothic.ttf
styles["Normal"].fontName = "Malgun"
\`\`\`

- Turning HTML/Markdown straight into PDF does not work well without a browser engine.
  At the level of tables and paragraphs, drawing it with reportlab is the reliable path.

## 3. Editing (merge · split · rotate · watermark)

\`\`\`python
from pypdf import PdfReader, PdfWriter

writer = PdfWriter()
for path in ["front.pdf", "back.pdf"]:             # merge
    for page in PdfReader(path).pages:
        writer.add_page(page)
with open("combined.pdf", "wb") as f:
    writer.write(f)

reader = PdfReader("document.pdf")                 # split (pages 1-3)
part = PdfWriter()
for page in reader.pages[0:3]:
    part.add_page(page)
with open("pages-1-3.pdf", "wb") as f:
    part.write(f)

stamp = PdfReader("watermark.pdf").pages[0]        # overlay
for page in reader.pages:
    page.merge_page(stamp)
\`\`\`

- Encrypted files need \`reader.decrypt("password")\` first. If you do not have the password, ask
  the user — do not try to work around it.
- **Editing the text of an existing PDF is essentially impossible.** If the source (Word, Markdown)
  exists, fix that and re-export; if not, tell the user you are covering it over (white rectangle
  plus new text).

## 4. Finishing

- Reopen the PDF you produced and check the page count and the first page's text.
- Always report the conditions that shaped the result — scanned original, password, font substitution.`;

/** 내장 스킬 원문(영어). 파싱은 한국어판과 똑같이 `parseSkillDoc` 이 한다. */
export const BUILTIN_SKILL_DOCS_EN: { folder: string; content: string }[] = [
  { folder: "xlsx", content: XLSX_SKILL_EN },
  { folder: "docx", content: DOCX_SKILL_EN },
  { folder: "pdf", content: PDF_SKILL_EN },
];

/** 새 스킬을 만들 때 넣어 주는 뼈대(영어). */
export function skillTemplateEn(name: string): string {
  return `---
name: ${name}
description: (one line on when to open this skill — only this line rides along every turn)
---

# ${name}

## When to use
-

## Steps
1.
2.

## Watch out
-
`;
}
