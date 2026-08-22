/**
 * 내장 스킬 문서.
 *
 * 파일이 아니라 코드에 박아 둔다 — 앱을 처음 켠 사용자도 아무 준비 없이 쓸 수 있어야 하고,
 * 디스크에 깔아 두면 사용자가 고친 뒤 앱을 업데이트할 때 덮어쓸지 말지가 늘 애매해진다.
 * 고쳐 쓰고 싶으면 같은 이름으로 전역/프로젝트 스킬을 만들면 그쪽이 이긴다(`mergeSkills`).
 *
 * 본문은 **절차서**다. 도구 스키마처럼 매 턴 실리지 않고, 모델이 `load_skill` 로 부를 때만
 * 컨텍스트에 들어간다. 그러니 길이보다 "이대로 따라 하면 되는가" 가 중요하다.
 *
 * 런타임은 Python 기준이다 — 문서 처리 라이브러리가 가장 두껍고, 없으면 스킬 본문의
 * "환경 확인" 절차가 설치까지 안내한다.
 */

/** 세 문서 스킬이 공통으로 먼저 밟는 절차. 같은 문장을 세 번 적지 않으려고 떼어 둔다. */
const PYTHON_PRELUDE = `## 0. 환경 확인 (매번 먼저)

1. \`python --version\` 을 실행한다. 실패하면 Windows 에서는 \`py -3 --version\` 도 시도한다.
   둘 다 없으면 사용자에게 Python 설치를 요청하고 여기서 멈춘다 — 임의로 설치하지 않는다.
2. 필요한 패키지가 있는지 확인한다: \`python -c "import <모듈>"\`.
   ImportError 면 \`python -m pip install <패키지>\` 로 설치한다.
3. 스크립트는 대화에 길게 쓰지 말고 \`.agent_workspace/tmp/<작업이름>.py\` 로 저장한 뒤
   \`python .agent_workspace/tmp/<작업이름>.py\` 로 실행한다. 그 폴더는 git 에 올라가지 않는다.
4. 원본을 수정하는 작업은 **반드시 사본을 먼저 만든다**(\`copy\` / \`shutil.copy2\`).
   문서 라이브러리는 저장할 때 파일을 통째로 다시 쓰므로 실패하면 원본이 날아간다.`;

const XLSX_SKILL = `---
name: xlsx
description: 엑셀 파일(.xlsx/.xlsm)을 읽거나 만들거나 고칠 때. openpyxl 로 시트·셀·수식·서식을 다루고, 큰 표는 pandas 로 집계한다.
---

# 엑셀 파일 다루기 (openpyxl)

${PYTHON_PRELUDE}

필요 패키지: \`openpyxl\` (집계가 필요하면 \`pandas\` 도).
\`.xls\`(구형 바이너리)는 openpyxl 이 못 연다 — 사용자에게 \`.xlsx\` 로 변환을 요청하거나
\`libreoffice --headless --convert-to xlsx\` 가 있으면 그걸 쓴다.

## 1. 읽기 — 먼저 구조부터 본다

셀을 찍기 전에 시트 이름과 표의 경계를 확인한다. 전체를 문자열로 덤프하지 않는다(컨텍스트를 통째로 먹는다).

\`\`\`python
from openpyxl import load_workbook
wb = load_workbook("보고서.xlsx", data_only=True)  # data_only=True: 수식 대신 마지막 계산값
print(wb.sheetnames)
ws = wb["Sheet1"]
print(ws.dimensions, ws.max_row, ws.max_column)
for row in ws.iter_rows(min_row=1, max_row=5, values_only=True):
    print(row)                                     # 머리글 5줄만 훑어 열 구성을 파악
\`\`\`

- \`data_only=True\` 로 연 워크북을 **그대로 저장하면 수식이 값으로 바뀌어 버린다**.
  읽기 전용으로만 쓰고, 고칠 때는 \`data_only=False\`(기본값)로 다시 연다.
- 수식의 계산값이 \`None\` 이면 그 파일을 엑셀이 한 번도 계산한 적이 없다는 뜻이다.
  openpyxl 은 수식을 계산하지 못하므로 값이 필요하면 직접 계산해서 채운다.
- 행이 수만 줄이면 \`load_workbook(..., read_only=True)\` 로 열어 스트리밍한다.
- 집계·피벗은 \`pandas.read_excel(파일, sheet_name=..., header=...)\` 가 훨씬 짧다.

## 2. 만들기

\`\`\`python
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active
ws.title = "매출"
ws.append(["월", "매출", "비고"])                    # 머리글
for cell in ws[1]:
    cell.font = Font(bold=True)
    cell.fill = PatternFill("solid", fgColor="EEEEEE")
    cell.alignment = Alignment(horizontal="center")

for row in [("1월", 1200000, ""), ("2월", 980000, "설 연휴")]:
    ws.append(row)

ws["B2"].number_format = "#,##0"                    # 서식은 셀 단위로
ws.freeze_panes = "A2"                              # 머리글 고정
ws.auto_filter.ref = ws.dimensions
for i, width in enumerate([10, 14, 20], start=1):   # 열 너비는 직접 준다(자동 맞춤이 없다)
    ws.column_dimensions[get_column_letter(i)].width = width

wb.save("매출.xlsx")
\`\`\`

- 수식은 문자열로 넣는다: \`ws["B5"] = "=SUM(B2:B4)"\`. 넣은 수식의 값은 엑셀이 열 때 계산된다.
- 차트가 필요하면 \`openpyxl.chart\` 의 \`BarChart\`/\`LineChart\` + \`Reference\` 를 쓴다.

## 3. 고치기 (기존 파일)

\`\`\`python
import shutil
from openpyxl import load_workbook

shutil.copy2("원본.xlsx", "원본.backup.xlsx")        # 1) 사본 먼저
wb = load_workbook("원본.xlsx")                      # 2) 수식 보존 (data_only 를 켜지 않는다)
ws = wb["Sheet1"]
ws.insert_rows(2)                                    # 행/열 삽입은 수식 참조를 따라 옮겨 주지 않는다
ws["A2"], ws["B2"] = "0월", 0
wb.save("원본.xlsx")                                 # 3) 같은 이름으로 덮어쓰기
\`\`\`

- **openpyxl 이 보존하지 못하는 것**: 차트 일부, 이미지, 피벗 테이블, VBA(\`.xlsm\` 은
  \`keep_vba=True\` 로 열어야 매크로가 살아남는다), 조건부 서식의 일부.
  이런 파일을 고칠 때는 사용자에게 "무엇이 사라질 수 있는지" 먼저 알린다.
- 셀 병합은 \`ws.merge_cells("A1:C1")\`, 해제는 \`ws.unmerge_cells\`. 병합 영역은 좌상단 셀에만 값이 있다.

## 4. 마무리

- 저장한 파일을 다시 열어 행 수와 핵심 셀 값을 확인한 뒤 사용자에게 보고한다.
- 보고에는 **경로 · 시트 · 바뀐 범위**를 적는다. "수정했습니다" 만 적지 않는다.`;

const DOCX_SKILL = `---
name: docx
description: 워드 파일(.docx)을 읽거나 만들거나 고칠 때. python-docx 로 문단·표·스타일을 다루고, 서식 유지가 중요한 편집은 기존 스타일을 재사용한다.
---

# 워드 파일 다루기 (python-docx)

${PYTHON_PRELUDE}

필요 패키지: \`python-docx\` (import 이름은 \`docx\` 다 — \`pip install docx\` 는 **다른 패키지**이니 주의).
\`.doc\`(구형)은 열지 못한다 → \`libreoffice --headless --convert-to docx\` 로 변환하거나 사용자에게 요청한다.

## 1. 읽기

\`\`\`python
from docx import Document
doc = Document("계약서.docx")
for i, p in enumerate(doc.paragraphs[:40]):
    if p.text.strip():
        print(i, p.style.name, "|", p.text[:100])
for t_i, table in enumerate(doc.tables):
    print("표", t_i, len(table.rows), "x", len(table.columns))
    print([c.text for c in table.rows[0].cells])
\`\`\`

- 본문 순서대로 문단과 표를 함께 훑어야 할 때는 \`doc.element.body\` 를 순회한다
  (\`doc.paragraphs\` 와 \`doc.tables\` 는 서로 순서를 모른다).
- 머리글·바닥글은 \`doc.sections[0].header/.footer\` 에 따로 있다.

## 2. 만들기

\`\`\`python
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()                                  # 기본 템플릿(스타일 포함)으로 시작
doc.add_heading("2026년 상반기 보고", level=1)
p = doc.add_paragraph("요약: ")
p.add_run("매출이 전년 대비 12% 늘었다.").bold = True
p.alignment = WD_ALIGN_PARAGRAPH.LEFT

table = doc.add_table(rows=1, cols=3)
table.style = "Table Grid"                        # 스타일 이름은 템플릿에 있는 것만 쓸 수 있다
head = table.rows[0].cells
head[0].text, head[1].text, head[2].text = "월", "매출", "비고"
row = table.add_row().cells
row[0].text, row[1].text = "1월", "1,200,000"

doc.add_page_break()
doc.save("보고.docx")
\`\`\`

- 한글 문서는 서체를 지정해야 깨져 보이지 않는다:
  \`style = doc.styles["Normal"]; style.font.name = "맑은 고딕"; style.font.size = Pt(10)\`.
  동아시아 글꼴은 XML 속성을 함께 줘야 완전히 적용된다 —
  \`style.element.rPr.rFonts.set(qn("w:eastAsia"), "맑은 고딕")\` (\`from docx.oxml.ns import qn\`).
- 사용자가 양식(템플릿)을 줬다면 \`Document("양식.docx")\` 로 **그 파일을 열어** 내용을 채운다.
  빈 문서에서 서식을 흉내 내지 말 것 — 절대 같아지지 않는다.

## 3. 고치기

\`\`\`python
import shutil
from docx import Document

shutil.copy2("원본.docx", "원본.backup.docx")
doc = Document("원본.docx")
for p in doc.paragraphs:
    if "{{고객명}}" in p.text:
        for run in p.runs:                        # run 단위로 바꿔야 서식이 유지된다
            run.text = run.text.replace("{{고객명}}", "홍길동")
doc.save("원본.docx")
\`\`\`

- **\`p.text = ...\` 로 통째로 대입하면 그 문단의 서식이 전부 날아간다.** run 을 고친다.
- 치환 대상이 여러 run 에 쪼개져 있을 수 있다(맞춤법 검사가 쪼갠다). 문단 전체 텍스트에
  대상이 있는데 run 단위로 못 찾으면, 첫 run 에 합친 텍스트를 넣고 나머지 run 의 텍스트를 비운다.
- 문단 삭제는 \`p._element.getparent().remove(p._element)\`.

## 4. 마무리

- 저장 후 다시 열어 문단 수와 바꾼 문자열이 실제로 반영됐는지 확인한다.
- 표·이미지가 있는 문서를 고쳤다면 무엇이 남고 무엇이 바뀌었는지 함께 보고한다.`;

const PDF_SKILL = `---
name: pdf
description: PDF 를 읽거나(텍스트·표 추출) 만들거나(reportlab) 편집할 때(병합·분할·회전·워터마크). 스캔본은 OCR 이 필요한지 먼저 판단한다.
---

# PDF 다루기 (pypdf · pdfplumber · reportlab)

${PYTHON_PRELUDE}

필요 패키지: 읽기·편집 \`pypdf\`, 표/좌표 추출 \`pdfplumber\`, 생성 \`reportlab\`.

## 1. 읽기 — 텍스트 PDF 인지부터 가른다

\`\`\`python
from pypdf import PdfReader
reader = PdfReader("문서.pdf")
print(len(reader.pages), reader.metadata)
text = reader.pages[0].extract_text() or ""
print(len(text), text[:300])
\`\`\`

- 추출한 텍스트가 거의 비어 있으면 **스캔 이미지 PDF** 다. pypdf 로는 못 읽는다 →
  사용자에게 알리고 OCR(\`ocrmypdf\`, Tesseract) 사용 여부를 묻는다. 임의로 큰 도구를 설치하지 않는다.
- 표가 필요하면 pdfplumber 를 쓴다. 레이아웃 정보를 함께 본다:

\`\`\`python
import pdfplumber
with pdfplumber.open("문서.pdf") as pdf:
    page = pdf.pages[0]
    print(page.extract_text())
    for table in page.extract_tables():
        for row in table[:5]:
            print(row)
\`\`\`

- 페이지가 많으면 전부 추출해 컨텍스트에 붓지 말고, 필요한 페이지만 골라 읽거나
  추출 결과를 파일로 저장한 뒤 필요한 부분만 grep 한다.

## 2. 만들기

간단한 표·문단이면 reportlab 의 platypus 를 쓴다.

\`\`\`python
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib import colors

doc = SimpleDocTemplate("보고.pdf", pagesize=A4,
                        leftMargin=20*mm, rightMargin=20*mm,
                        topMargin=20*mm, bottomMargin=20*mm)
styles = getSampleStyleSheet()
story = [Paragraph("2026년 상반기 보고", styles["Title"]), Spacer(1, 6*mm)]
data = [["월", "매출"], ["1월", "1,200,000"], ["2월", "980,000"]]
table = Table(data, colWidths=[30*mm, 40*mm])
table.setStyle(TableStyle([
    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
    ("BACKGROUND", (0, 0), (-1, 0), colors.whitesmoke),
    ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
]))
story.append(table)
doc.build(story)
\`\`\`

- **한글은 서체를 등록하지 않으면 네모로 나온다.** 시스템 서체를 등록한다:

\`\`\`python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont("Malgun", r"C:\\Windows\\Fonts\\malgun.ttf"))  # macOS: AppleGothic.ttf
styles["Normal"].fontName = "Malgun"
\`\`\`

- HTML/마크다운을 그대로 PDF 로 만들고 싶다면, 브라우저 엔진이 없는 환경에서는
  잘 맞지 않는다. 표·문단 수준이면 reportlab 으로 직접 그리는 편이 확실하다.

## 3. 편집 (병합·분할·회전·워터마크)

\`\`\`python
from pypdf import PdfReader, PdfWriter

writer = PdfWriter()
for path in ["앞.pdf", "뒤.pdf"]:                  # 병합
    for page in PdfReader(path).pages:
        writer.add_page(page)
with open("합본.pdf", "wb") as f:
    writer.write(f)

reader = PdfReader("문서.pdf")                     # 분할 (1~3쪽)
part = PdfWriter()
for page in reader.pages[0:3]:
    part.add_page(page)
with open("1-3쪽.pdf", "wb") as f:
    part.write(f)

stamp = PdfReader("워터마크.pdf").pages[0]         # 겹치기
for page in reader.pages:
    page.merge_page(stamp)
\`\`\`

- 암호가 걸린 파일은 \`reader.decrypt("암호")\` 가 먼저다. 암호를 모르면 사용자에게 묻는다 —
  우회하려 하지 않는다.
- 기존 PDF 의 **텍스트를 직접 고치는 것은 사실상 불가능하다**. 원본(워드·마크다운)이 있으면
  그것을 고쳐 다시 내보내고, 없으면 덮어쓰기(흰 사각형 + 새 텍스트)임을 사용자에게 알린다.

## 4. 마무리

- 만든 PDF 는 다시 열어 페이지 수와 첫 페이지 텍스트를 확인한다.
- 스캔본·암호·서체처럼 **결과 품질을 좌우한 조건**은 보고에 반드시 적는다.`;

/** 내장 스킬 원문. 파싱은 사용자 스킬과 똑같이 `parseSkillDoc` 이 한다. */
export const BUILTIN_SKILL_DOCS: { folder: string; content: string }[] = [
  { folder: "xlsx", content: XLSX_SKILL },
  { folder: "docx", content: DOCX_SKILL },
  { folder: "pdf", content: PDF_SKILL },
];

/** 새 스킬을 만들 때 넣어 주는 뼈대. 설정의 [+ 스킬 추가] 가 이 내용으로 파일을 만든다. */
export function skillTemplate(name: string): string {
  return `---
name: ${name}
description: (언제 이 스킬을 열어야 하는지 한 줄로. 이 줄만 매 턴 컨텍스트에 실린다)
---

# ${name}

## 언제 쓰나
-

## 절차
1.
2.

## 주의
-
`;
}
