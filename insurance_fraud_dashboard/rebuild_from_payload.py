"""포함된 데이터와 소스로 독립 실행 HTML을 다시 만든다. Python 표준 라이브러리만 사용한다.

사용법 (이 폴더에서 실행):
    python3 rebuild_from_payload.py           HTML을 다시 만든다
    python3 rebuild_from_payload.py --check   소스와 지금의 HTML이 일치하는지만 확인한다 (다르면 종료 코드 1)

src/dashboard.html 안의 자리표시자 네 개를 아래 파일의 내용으로 바꾼다.
    __STYLES__  ← src/dashboard.css
    __PAYLOAD__ ← data/dashboard_payload.json
    __ENGINE__  ← src/engine.js
    __UI__      ← src/dashboard.js
"""
from pathlib import Path
import json
import re
import sys
import unicodedata

ROOT = Path(__file__).resolve().parent
OUTPUT_NAME = unicodedata.normalize('NFC', '보험청구_관리자_대시보드.html')
SOURCES = {'__STYLES__': 'src/dashboard.css', '__ENGINE__': 'src/engine.js', '__UI__': 'src/dashboard.js'}


def read(relative):
    return (ROOT / relative).read_text(encoding='utf-8')


def data_warnings(payload):
    """참고용 데이터 파일이 payload와 어긋나면 알려 준다. HTML은 payload만 사용한다."""
    notes = []
    for relative, key in (('data/field_schema.json', 'fields'), ('data/sample_inputs.json', 'cases')):
        path = ROOT / relative
        if path.exists() and json.loads(path.read_text(encoding='utf-8')) != payload[key]:
            notes.append(f'주의: {relative} 내용이 dashboard_payload.json의 {key}와 다릅니다.')
    return notes


def build():
    payload = json.loads(read('data/dashboard_payload.json'))
    template = read('src/dashboard.html')
    values = {key: read(relative).rstrip('\n') for key, relative in SOURCES.items()}
    values['__PAYLOAD__'] = json.dumps(payload, ensure_ascii=False).replace('</', '<\\/')
    for key in values:
        count = template.count(key)
        if count != 1:
            raise SystemExit(f'src/dashboard.html에 {key} 자리표시자가 {count}번 있습니다. 정확히 1번이어야 합니다.')
    for key, closing in (('__STYLES__', '</style'), ('__ENGINE__', '</script'), ('__UI__', '</script')):
        if closing in values[key].lower():
            raise SystemExit(f'{SOURCES[key]} 안에 {closing}> 가 있어 HTML에 넣을 수 없습니다.')
    # 한 번에 치환한다. 넣은 내용 안에 자리표시자와 같은 글자가 있어도 다시 바뀌지 않는다.
    pattern = re.compile('|'.join(re.escape(key) for key in values))
    return pattern.sub(lambda match: values[match.group(0)], template), data_warnings(payload)


def output_path():
    for path in ROOT.iterdir():   # 자모가 풀린(NFD) 이름으로 저장된 기존 파일도 같은 파일로 본다
        if unicodedata.normalize('NFC', path.name) == OUTPUT_NAME:
            return path
    return ROOT / OUTPUT_NAME


def main(argv):
    page, notes = build()
    path = output_path()
    for note in notes:
        print(note)
    if '--check' in argv:
        if path.exists() and path.read_text(encoding='utf-8') == page:
            print(f'일치: {path.name} 은(는) 현재 소스·데이터로 만든 결과와 같습니다.')
            return 0
        print(f'불일치: {path.name} 이(가) 없거나 현재 소스·데이터와 다릅니다. --check 없이 다시 실행해 재생성하세요.')
        return 1
    path.write_text(page, encoding='utf-8')
    print(f'{path} ({len(page.encode("utf-8")):,} bytes)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
