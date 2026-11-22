"""블로그 초안(blog_in_progress.md)의 그림을 다시 만들고 PDF로 변환한다.
Python 표준 라이브러리와 이 컴퓨터에 설치된 Chrome(또는 Edge)만 사용한다.

    python3 blog/build_blog.py            그림 다시 만들기 + PDF 만들기 (blog/blog_in_progress.pdf)
    python3 blog/build_blog.py --html     PDF 대신 HTML로 만들어 브라우저에서 확인 (blog/blog_in_progress.html)

1) figures/gain_curve_fold.svg 를 ../insurance_fraud_dashboard/data/dashboard_payload.json 의 평가 자료로 다시 그린다.
2) Markdown을 HTML로 바꾼다. 지원하는 문법: 제목(# ~ ####), 문단, 목록(-, 1.), 표, 그림, 인용(>), 구분선(---),
   굵게(**), 기울임(*), 코드(`), 링크. 그 밖의 문법은 글자 그대로 나온다.
3) Chrome을 창 없이 실행해 A4 PDF로 인쇄한다. 브라우저를 못 찾으면 CHROME_PATH 환경 변수로 경로를 지정한다.
"""
from pathlib import Path
import html
import json
import os
import re
import subprocess
import sys
import tempfile

BLOG = Path(__file__).resolve().parent
SOURCE = BLOG / 'blog_in_progress.md'
PAYLOAD = BLOG.parent / 'insurance_fraud_dashboard' / 'data' / 'dashboard_payload.json'
FIGURE = BLOG / 'figures' / 'gain_curve_fold.svg'

# 대시보드의 모델 평가 화면과 같은 계열 색
SERIES = [('Logistic', 'Logistic regression (24 features)', '#0f8a6c'), ('Severity', 'Severity-only baseline', '#6250d6')]
BASELINE = ('Random selection (expected)', '#7f8d95')


# ---------------------------------------------------------------- 그림
def cumulative(rows, key):
    """기록된 순위대로 훑으며 사기 표시를 누적한다. 결과[k] = 상위 k건 안의 사기 표시 수."""
    found, out = 0, [0]
    for row in sorted(rows, key=lambda r: r['ranks'][key]):
        found += row['label']
        out.append(found)
    return out


def gain_curve_svg(payload):
    rows = payload['evaluation']['rows']
    n, total = len(rows), sum(r['label'] for r in rows)
    width, height = 720, 400
    left, right, top, bottom = 58, 20, 18, 52
    pw, ph = width - left - right, height - top - bottom
    x = lambda k: left + k / n * pw
    y = lambda v: top + ph - v / total * ph
    ink, muted, grid = '#3f515a', '#5b6b74', '#e6ebed'
    font = "font-family=\"-apple-system, 'Helvetica Neue', Arial, sans-serif\" font-size=\"12\""
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img" '
        f'aria-label="Cumulative gain on one evaluation fold of {n} claims: fraud labels found when claims are reviewed from the highest score down">',
        f'<rect width="{width}" height="{height}" fill="#ffffff"/>'
    ]
    for value in range(0, total + 1, 10):
        parts.append(f'<line x1="{left}" x2="{left + pw}" y1="{y(value):.1f}" y2="{y(value):.1f}" stroke="{grid}" stroke-width="1"/>')
        parts.append(f'<text x="{left - 8}" y="{y(value) + 4:.1f}" text-anchor="end" fill="{muted}" {font}>{value}</text>')
    for value in range(0, n + 1, 50):
        parts.append(f'<text x="{x(value):.1f}" y="{top + ph + 18}" text-anchor="middle" fill="{muted}" {font}>{value}</text>')
    parts.append(f'<text x="{left + pw / 2:.1f}" y="{height - 10}" text-anchor="middle" fill="{ink}" {font}>Claims reviewed (highest score first)</text>')
    parts.append(f'<text x="14" y="{top + ph / 2:.1f}" text-anchor="middle" fill="{ink}" {font} transform="rotate(-90 14 {top + ph / 2:.1f})">Fraud labels found (cumulative)</text>')
    parts.append(f'<line x1="{x(0):.1f}" y1="{y(0):.1f}" x2="{x(n):.1f}" y2="{y(total):.1f}" stroke="{BASELINE[1]}" stroke-width="1.5" stroke-dasharray="5 4"/>')
    for key, _, color in SERIES:
        points = ' '.join(f'{x(k):.1f},{y(v):.1f}' for k, v in enumerate(cumulative(rows, key)))
        parts.append(f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>')
    # 범례: 선 견본 + 이름 (글자는 계열 색이 아니라 본문 색). 곡선 아래 오른쪽의 빈 곳에 세로로 놓는다
    lx, ly = left + pw - 232, top + ph - 78
    for label, color, dash in [(SERIES[0][1], SERIES[0][2], ''), (SERIES[1][1], SERIES[1][2], ''), (BASELINE[0], BASELINE[1], ' stroke-dasharray="5 4"')]:
        parts.append(f'<line x1="{lx}" x2="{lx + 22}" y1="{ly}" y2="{ly}" stroke="{color}" stroke-width="2"{dash}/>')
        parts.append(f'<text x="{lx + 30}" y="{ly + 4}" fill="{ink}" {font}>{html.escape(label)}</text>')
        ly += 22
    parts.append('</svg>')
    return '\n'.join(parts) + '\n'


# ---------------------------------------------------------------- Markdown → HTML
def inline(text, resolve):
    text = html.escape(text, quote=True)
    codes = []

    def stash(match):
        codes.append(match.group(1))
        return f'\x00{len(codes) - 1}\x00'

    text = re.sub(r'`([^`]+)`', stash, text)
    text = re.sub(r'!\[([^\]]*)\]\(([^)\s]+)\)', lambda m: f'<img alt="{m.group(1)}" src="{resolve(m.group(2))}">', text)
    text = re.sub(r'\[([^\]]+)\]\(([^)\s]+)\)', r'<a href="\2">\1</a>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'(?<![*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?![*\w])', r'<em>\1</em>', text)
    text = text.replace('<strong>[TODO', '<strong class="todo">[TODO')
    return re.sub(r'\x00(\d+)\x00', lambda m: f'<code>{codes[int(m.group(1))]}</code>', text)


HEADING = re.compile(r'(#{1,4})\s+(.*)')
RULE = re.compile(r'-{3,}\s*')
ITEM = re.compile(r'(\s*)([-*]|\d+\.)\s+(.*)')
TABLE_RULE = re.compile(r'\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*')
IMAGE_LINE = re.compile(r'!\[[^\]]*\]\([^)\s]+\)')


def starts_block(lines, i):
    line = lines[i]
    return bool(HEADING.match(line) or RULE.fullmatch(line) or line.startswith('>') or ITEM.match(line)
                or line.lstrip().startswith('|') or IMAGE_LINE.fullmatch(line.strip()))


def cells_of(line):
    return [cell.strip() for cell in line.strip().strip('|').split('|')]


def to_html(markdown, resolve):
    lines, out, i = markdown.split('\n'), [], 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        heading = HEADING.match(line)
        if heading:
            level = len(heading.group(1))
            out.append(f'<h{level}>{inline(heading.group(2).strip(), resolve)}</h{level}>')
            i += 1
        elif RULE.fullmatch(line):
            out.append('<hr>')
            i += 1
        elif line.lstrip().startswith('|') and i + 1 < len(lines) and TABLE_RULE.fullmatch(lines[i + 1]):
            head = cells_of(line)
            aligns = ['right' if c.endswith(':') and not c.startswith(':') else ('center' if c.startswith(':') and c.endswith(':') else '') for c in cells_of(lines[i + 1])]
            style = lambda j: f' style="text-align:{aligns[j]}"' if j < len(aligns) and aligns[j] else ''
            i += 2
            body = []
            while i < len(lines) and lines[i].lstrip().startswith('|'):
                body.append(cells_of(lines[i]))
                i += 1
            keep = ' class="keep"' if len(body) <= 10 else ''
            out.append(f'<table{keep}><thead><tr>' + ''.join(f'<th{style(j)}>{inline(c, resolve)}</th>' for j, c in enumerate(head)) + '</tr></thead><tbody>'
                       + ''.join('<tr>' + ''.join(f'<td{style(j)}>{inline(c, resolve)}</td>' for j, c in enumerate(row)) + '</tr>' for row in body)
                       + '</tbody></table>')
        elif line.startswith('>'):
            quote = []
            while i < len(lines) and lines[i].startswith('>'):
                quote.append(lines[i][1:].lstrip())
                i += 1
            out.append('<blockquote>' + to_html('\n'.join(quote), resolve) + '</blockquote>')
        elif ITEM.match(line):
            first = ITEM.match(line)
            indent, ordered = len(first.group(1)), first.group(2)[0].isdigit()
            items = []
            while i < len(lines):
                item = ITEM.match(lines[i])
                if item and len(item.group(1)) == indent and item.group(2)[0].isdigit() == ordered:
                    items.append([item.group(3)])
                    i += 1
                elif lines[i].strip() and len(lines[i]) - len(lines[i].lstrip()) > indent:
                    items[-1].append(lines[i])          # 이어지는 줄 또는 들여쓴 하위 목록
                    i += 1
                elif not lines[i].strip() and i + 1 < len(lines) and lines[i + 1].strip() and len(lines[i + 1]) - len(lines[i + 1].lstrip()) > indent:
                    i += 1
                else:
                    break
            rendered = []
            for item in items:
                rest = item[1:]
                if rest and ITEM.match(rest[0]):             # 하위 목록
                    cut = min(len(r) - len(r.lstrip()) for r in rest)
                    rendered.append(f'<li>{inline(item[0], resolve)}{to_html(chr(10).join(r[cut:] for r in rest), resolve)}</li>')
                else:
                    rendered.append(f'<li>{inline(" ".join([item[0]] + [r.strip() for r in rest]), resolve)}</li>')
            tag = 'ol' if ordered else 'ul'
            out.append(f'<{tag}>' + ''.join(rendered) + f'</{tag}>')
        elif IMAGE_LINE.fullmatch(line.strip()):
            out.append(f'<figure>{inline(line.strip(), resolve)}</figure>')
            i += 1
        else:
            paragraph = [line.strip()]
            i += 1
            while i < len(lines) and lines[i].strip() and not starts_block(lines, i):
                paragraph.append(lines[i].strip())
                i += 1
            joined = ' '.join(paragraph)
            caption = ' class="caption"' if re.fullmatch(r'\*(Table|Figure) \d+\..*\*', joined) else ''   # 표·그림 설명은 표·그림과 같은 쪽에 둔다
            out.append(f'<p{caption}>' + inline(joined, resolve) + '</p>')
    return '\n'.join(out)


STYLE = """
@page { size: A4; margin: 17mm 16mm 18mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #16252d; font: 10.5pt/1.6 -apple-system, "Helvetica Neue", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", Arial, sans-serif; }
h1 { margin: 0 0 10pt; font-size: 19pt; line-height: 1.3; }
h2 { margin: 22pt 0 8pt; padding-bottom: 4pt; border-bottom: 1px solid #c3ccd1; font-size: 14.5pt; line-height: 1.35; break-after: avoid; }
h3 { margin: 15pt 0 6pt; font-size: 12pt; line-height: 1.4; break-after: avoid; }
h4 { margin: 12pt 0 4pt; font-size: 10.5pt; break-after: avoid; }
p { margin: 0 0 8pt; }
p.caption { break-after: avoid; }
figure + p.caption { break-before: avoid; break-after: auto; }
ul, ol { margin: 0 0 8pt; padding-left: 18pt; }
li { margin-bottom: 3pt; }
li > ul, li > ol { margin: 3pt 0 0; }
table { width: 100%; margin: 6pt 0 12pt; border-collapse: collapse; font-size: 9pt; line-height: 1.45; }
th, td { padding: 4pt 6pt; border: 1px solid #c3ccd1; text-align: left; vertical-align: top; }
th { background: #f0f3f4; font-weight: 650; }
tr { break-inside: avoid; }
td[style*="text-align:right"] { white-space: nowrap; }
table.keep { break-inside: avoid; }
code { padding: 0 3pt; border-radius: 3px; background: #eef2f3; font: 8.5pt ui-monospace, Menlo, Consolas, monospace; }
blockquote { margin: 0 0 10pt; padding: 7pt 10pt; border-left: 3px solid #a9d2c6; background: #f3f8f6; color: #23483f; }
blockquote p:last-child { margin-bottom: 0; }
figure { margin: 8pt 0 4pt; text-align: center; break-inside: avoid; }
img { max-width: 100%; height: auto; }
figure img { max-height: 100mm; border: 1px solid #dde3e6; }
hr { margin: 14pt 0; border: 0; border-top: 1px solid #dde3e6; }
a { color: #0b5446; }
strong.todo { color: #a8301f; }
"""


def build_html(absolute_images):
    markdown = SOURCE.read_text(encoding='utf-8')
    resolve = (lambda src: src if re.match(r'[a-z]+:', src) else (BLOG / src).resolve().as_uri()) if absolute_images else (lambda src: src)
    title = next((line[2:].strip() for line in markdown.split('\n') if line.startswith('# ')), 'Blog in progress')
    return ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            f'<title>{html.escape(title)}</title>\n<style>{STYLE}</style>\n</head>\n<body>\n{to_html(markdown, resolve)}\n</body>\n</html>\n')


# ---------------------------------------------------------------- PDF
def find_browser():
    candidates = [
        os.environ.get('CHROME_PATH'),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    ]
    return next((path for path in candidates if path and Path(path).exists()), None)


def main():
    payload = json.loads(PAYLOAD.read_text(encoding='utf-8'))
    FIGURE.parent.mkdir(exist_ok=True)
    FIGURE.write_text(gain_curve_svg(payload), encoding='utf-8')
    print(f'그림: {FIGURE.relative_to(BLOG.parent)}')

    if '--html' in sys.argv:
        target = SOURCE.with_suffix('.html')
        target.write_text(build_html(absolute_images=False), encoding='utf-8')
        print(f'HTML: {target.relative_to(BLOG.parent)}')
        return 0

    browser = find_browser()
    if not browser:
        print('Chrome 또는 Edge를 찾지 못했습니다. CHROME_PATH 환경 변수로 실행 파일 경로를 지정하거나, --html 로 만든 파일을 브라우저에서 인쇄(PDF로 저장)하세요.')
        return 2
    target = SOURCE.with_suffix('.pdf')
    with tempfile.TemporaryDirectory() as work:
        page = Path(work) / 'blog.html'
        page.write_text(build_html(absolute_images=True), encoding='utf-8')
        run = subprocess.run([browser, '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', f'--user-data-dir={Path(work) / "profile"}',
                              '--no-pdf-header-footer', f'--print-to-pdf={target}', page.as_uri()],
                             cwd=work, capture_output=True, text=True, timeout=120)
    if run.returncode != 0 or not target.exists():
        print('PDF를 만들지 못했습니다:', (run.stderr or run.stdout).strip()[-400:])
        return 1
    print(f'PDF: {target.relative_to(BLOG.parent)} ({target.stat().st_size:,} bytes)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
