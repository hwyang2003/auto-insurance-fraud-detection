/* 계산 엔진과 패키지 일관성 검사 (브라우저 없이 Node.js만 사용, 외부 패키지 없음)
 *
 *   node validation/run_engine_checks.mjs
 *
 * src/engine.js와 data/dashboard_payload.json을 그대로 읽어 실행하고, 결과를
 * validation/rerun_engine_checks.json에 기록한다. 실패가 있으면 종료 코드 1.
 * Python 모델과의 1,000건 대조는 원본 자료와 Python 모델이 패키지에 없어 여기서 실행하지 않는다.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const sha256 = relative => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
const TOLERANCE = 1e-8;

/* 제공받은 패키지(2026-11-11)의 파일 해시. 엔진과 모델 데이터를 바꾸지 않았는지 확인하는 기준이다. */
const PROVIDED_SHA256 = {
  'src/engine.js': '1d413b21a10963bec62195b215983d0c3583be1be8071186c64bfd4ff241d5a2',
  'data/dashboard_payload.json': '4624156009569bb66f3c22c71fe9ee1f58a466d8ec4ab4762902de6d11c92faf',
  'data/field_schema.json': 'c0c0e3423ab2f0aeeeab2e0308d218926cbc7db2569d759f0f3d221e243379c4',
  'data/sample_inputs.json': 'a61ab03b41f13c3f2266c7b9f9afd07a5c3ff4926fa2d7f8bc1af76606df07ff',
  'data/sample_result.json': '9a5046a32b38dac4a71d4ecb2800ed85fe819093d920f038bfea2ec48fff0399'
};

const payloadText = read('data/dashboard_payload.json');
const engineText = read('src/engine.js');
const context = vm.createContext({});
vm.runInContext(`const PAYLOAD=${payloadText};\n${engineText}\nglobalThis.api={PAYLOAD,analyzeCase,decision};`, context);
const { PAYLOAD, analyzeCase, decision } = context.api;
const sigmoid = z => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
const sample = id => PAYLOAD.cases.find(c => c.id === id);
const withInputs = (id, changes) => ({ ...sample(id).inputs, ...changes });
const fieldsOf = predicate => PAYLOAD.fields.filter(predicate);

const results = [];
function check(id, title, fn) {
  let outcome;
  try { outcome = fn(); } catch (error) { outcome = { pass: false, detail: 'exception: ' + error.message }; }
  results.push({ id, title, pass: outcome.pass === true, detail: outcome.detail ?? null });
}

/* ---- 요청받은 확인 사항 1~5 (엔진 수준) ---- */
check('E1', '예시 5건의 계산값이 expected_score와 1e-8 이내로 일치', () => {
  const rows = PAYLOAD.cases.map(c => {
    const r = analyzeCase(c.inputs);
    return { id: c.id, status: r.status, score: r.score, expected: c.expected_score, abs_diff: Math.abs(r.score - c.expected_score) };
  });
  return { pass: rows.length === 5 && rows.every(r => r.status === 'ok' && r.abs_diff <= TOLERANCE), detail: { max_abs_diff: Math.max(...rows.map(r => r.abs_diff)), rows } };
});
check('E2', 'DEMO-001 기본 점수는 약 57.898465222점', () => {
  const score = analyzeCase(sample('DEMO-001').inputs).score;
  return { pass: Math.abs(score - 57.898465222) < 5e-10, detail: { score } };
});
check('E3', 'DEMO-001의 incident_severity만 Minor Damage로 바꾸면 약 9.059383729점', () => {
  const score = analyzeCase(withInputs('DEMO-001', { incident_severity: 'Minor Damage' })).score;
  return { pass: Math.abs(score - 9.059383729) < 5e-10, detail: { score } };
});
check('E4', 'DEMO-003은 약 11.758962783점이고, 기준 10점→20점에서 검토 구분만 바뀜', () => {
  const first = analyzeCase(sample('DEMO-003').inputs), again = analyzeCase(sample('DEMO-003').inputs);
  const at10 = decision(first.score, 10), at20 = decision(first.score, 20);
  return {
    pass: Math.abs(first.score - 11.758962783) < 5e-10 && at10 === 'additional_review' && at20 === 'standard_review' && first.score === again.score,
    detail: { score: first.score, decision_at_10: at10, decision_at_20: at20, note: 'decision()은 점수 계산과 분리된 함수라 기준을 바꿔도 score와 contributions는 다시 계산되지 않는다' }
  };
});
check('E5', '필수 입력을 비우면 해당 필드 오류와 함께 분석이 차단됨 (필수 12개 × 빈 값 4종 + 키 누락)', () => {
  const required = fieldsOf(f => f.required), failures = [];
  for (const field of required) {
    for (const blank of [null, '', undefined, '__MISSING__']) {
      const r = analyzeCase(withInputs('DEMO-001', { [field.name]: blank }));
      if (r.status !== 'invalid' || !r.errors.some(e => e.field === field.name) || 'score' in r) failures.push({ field: field.name, blank: String(blank) });
    }
    const dropped = { ...sample('DEMO-001').inputs };
    delete dropped[field.name];
    const r = analyzeCase(dropped);
    if (r.status !== 'invalid' || !r.errors.some(e => e.field === field.name)) failures.push({ field: field.name, blank: 'key missing' });
  }
  return { pass: required.length === 12 && failures.length === 0, detail: { required_fields: required.map(f => f.name), failures } };
});

/* ---- 유지해야 할 입력 정책 ---- */
check('E6', '숫자 0, 미상 null, 문자열 "None"을 서로 다르게 처리', () => {
  const zero = analyzeCase(withInputs('DEMO-001', { witnesses: 0 })), unknown = analyzeCase(withInputs('DEMO-001', { witnesses: null }));
  const none = analyzeCase(withInputs('DEMO-001', { authorities_contacted: 'None' })), noneNull = analyzeCase(withInputs('DEMO-001', { authorities_contacted: null }));
  const umbrella = analyzeCase(sample('DEMO-001').inputs);   // umbrella_limit: 0
  const median = PAYLOAD.model.spec.witnesses.median;
  const facts = {
    zero_kept_as_zero: zero.status === 'ok' && zero.inputs.witnesses === 0 && !zero.input_processing.some(p => p.field === 'witnesses'),
    null_uses_median: unknown.status === 'ok' && unknown.inputs.witnesses === null && unknown.input_processing.some(p => p.field === 'witnesses' && p.method === 'median' && p.used_value === median),
    zero_and_null_scores_differ: zero.score !== unknown.score,
    none_string_is_a_category: none.status === 'ok' && none.inputs.authorities_contacted === 'None' && !none.input_processing.some(p => p.field === 'authorities_contacted')
      && none.contributions.find(c => c.field === 'authorities_contacted').used_value === 'None',
    null_for_required_category_is_rejected: noneNull.status === 'invalid',
    umbrella_zero_kept: umbrella.inputs.umbrella_limit === 0 && !umbrella.input_processing.some(p => p.field === 'umbrella_limit')
  };
  return { pass: Object.values(facts).every(Boolean), detail: { ...facts, score_witnesses_0: zero.score, score_witnesses_null: unknown.score, score_authorities_None: none.score } };
});
check('E7', '선택 항목의 미상: 숫자는 학습 중앙값, 범주는 미상 범주로 계산 (12개 항목 각각)', () => {
  const rows = fieldsOf(f => !f.required).map(field => {
    const r = analyzeCase(withInputs('DEMO-001', { [field.name]: null })), spec = PAYLOAD.model.spec[field.name];
    const item = r.status === 'ok' ? r.input_processing.find(p => p.field === field.name) : null;
    const ok = !!item && (field.type === 'number' ? item.method === 'median' && item.used_value === spec.median : item.method === 'missing_category' && item.used_value === '__MISSING__');
    return { field: field.name, ok };
  });
  return { pass: rows.length === 12 && rows.every(r => r.ok), detail: rows };
});
check('E8', '잘못된 숫자·범주·허용 범위는 차단', () => {
  const cases = [
    ['NaN', { injury_claim: NaN }], ['Infinity', { injury_claim: Infinity }], ['숫자 자리에 문자열', { injury_claim: '6510' }],
    ['정수 항목에 소수', { witnesses: 1.5 }], ['사고 시각 24', { incident_hour_of_the_day: 24 }], ['사고 시각 -1', { incident_hour_of_the_day: -1 }],
    ['관련 차량 0대', { number_of_vehicles_involved: 0 }], ['음수 청구액', { vehicle_claim: -1 }], ['양수 자본 손실', { 'capital-loss': 1 }],
    ['음수 추가 보장한도', { umbrella_limit: -1 }], ['없는 범주', { incident_severity: 'Unknown' }], ['대소문자가 다른 범주', { authorities_contacted: 'none' }],
    ['범주 자리에 숫자', { policy_csl: 250 }], ['미상을 학습하지 않은 범주에 미상', { insured_sex: '__MISSING__' }]
  ];
  const rows = cases.map(([name, changes]) => {
    const r = analyzeCase(withInputs('DEMO-001', changes));
    return { name, rejected: r.status === 'invalid' && r.errors.some(e => e.field === Object.keys(changes)[0]) };
  });
  return { pass: rows.every(r => r.rejected), detail: { rejected: rows.filter(r => r.rejected).length, total: rows.length, rows } };
});
check('E9', '허용 범위 안이지만 학습 자료 범위 밖인 값은 계산하고 경고를 반환', () => {
  const rows = [['number_of_vehicles_involved', 9], ['policy_deductable', 0], ['vehicle_claim', 200000], ['bodily_injuries', 5]].map(([field, value]) => {
    const r = analyzeCase(withInputs('DEMO-001', { [field]: value }));
    return { field, value, status: r.status, warned: r.status === 'ok' && r.warnings.some(w => w.field === field) };
  });
  const clean = analyzeCase(sample('DEMO-001').inputs);
  return { pass: rows.every(r => r.warned) && clean.warnings.length === 0, detail: rows };
});

/* ---- 설명값과 반환 구조 ---- */
check('E10', '기준값 + 24개 기여의 합 = 내부값(로그오즈), 점수 = 100 × sigmoid(내부값)', () => {
  const variants = [...PAYLOAD.cases.map(c => c.inputs), withInputs('DEMO-001', { incident_severity: 'Minor Damage' }), withInputs('DEMO-002', { witnesses: null, 'capital-loss': null })];
  const rows = variants.map(inputs => {
    const r = analyzeCase(inputs);
    return {
      contributions: r.contributions.length,
      reconstruction: Math.abs(r.base_log_odds + r.contributions.reduce((s, c) => s + c.contribution, 0) - r.log_odds),
      score_error: Math.abs(r.score - 100 * sigmoid(r.log_odds)),
      fields_match: JSON.stringify(r.contributions.map(c => c.field)) === JSON.stringify(PAYLOAD.model.cols)
    };
  });
  return { pass: rows.every(r => r.contributions === 24 && r.reconstruction < 1e-10 && r.score_error < 1e-10 && r.fields_match), detail: { max_reconstruction_error: Math.max(...rows.map(r => r.reconstruction)), cases: rows.length } };
});
check('E11', 'analyzeCase 반환 구조 (status ok / invalid)', () => {
  const ok = analyzeCase(sample('DEMO-001').inputs), bad = analyzeCase(withInputs('DEMO-001', { injury_claim: null }));
  const okKeys = Object.keys(ok).sort(), expected = ['base_log_odds', 'contribution_sum', 'contributions', 'input_processing', 'inputs', 'log_odds', 'model_version', 'probability', 'reconstruction_error', 'score', 'status', 'warnings'];
  return { pass: JSON.stringify(okKeys) === JSON.stringify(expected) && JSON.stringify(Object.keys(bad).sort()) === JSON.stringify(['errors', 'status']), detail: { ok_keys: okKeys, invalid_keys: Object.keys(bad) } };
});

/* ---- 패키지 일관성 ---- */
check('P1', '계산 엔진과 모델 데이터가 제공받은 패키지와 바이트 단위로 동일 (계수·전처리 값·범주 변경 없음)', () => {
  const rows = Object.entries(PROVIDED_SHA256).map(([file, expected]) => ({ file, sha256: sha256(file), unchanged: sha256(file) === expected }));
  return { pass: rows.every(r => r.unchanged), detail: rows };
});
check('P2', '참고용 데이터 파일이 payload와 일치 (field_schema, sample_inputs)', () => {
  const schema = JSON.stringify(JSON.parse(read('data/field_schema.json'))) === JSON.stringify(PAYLOAD.fields);
  const inputs = JSON.stringify(JSON.parse(read('data/sample_inputs.json'))) === JSON.stringify(PAYLOAD.cases);
  return { pass: schema && inputs && PAYLOAD.fields.length === 24, detail: { field_schema_matches: schema, sample_inputs_match: inputs, fields: PAYLOAD.fields.length } };
});
check('P3', 'data/sample_result.json의 점수·기여가 지금의 엔진 계산과 일치', () => {
  const saved = JSON.parse(read('data/sample_result.json')), r = analyzeCase(sample(saved.case_id).inputs);
  const maxContributionDiff = Math.max(...saved.explanation.contributions.map((c, i) => Math.abs(c.contribution - r.contributions[i].contribution)));
  const facts = {
    score: Math.abs(saved.prediction.score - r.score) <= TOLERANCE,
    inputs: JSON.stringify(saved.inputs) === JSON.stringify(r.inputs),
    contributions: saved.explanation.contributions.length === 24 && maxContributionDiff < 1e-12,
    recommendation: saved.review_policy.recommendation === decision(r.score, saved.review_policy.threshold)
  };
  return { pass: Object.values(facts).every(Boolean), detail: { ...facts, case_id: saved.case_id, analyzed_at: saved.analyzed_at } };
});
const htmlName = fs.readdirSync(root).find(name => name.normalize('NFC') === '보험청구_관리자_대시보드.html');
check('P4', '독립 실행 HTML이 현재 소스·데이터와 일치', () => {
  if (!htmlName) return { pass: false, detail: 'HTML 파일이 없습니다. rebuild_from_payload.py를 먼저 실행하세요.' };
  const html = read(htmlName);
  const contains = Object.fromEntries(['src/dashboard.css', 'src/engine.js', 'src/dashboard.js'].map(file => [file, html.includes(read(file).replace(/\n+$/, ''))]));
  const match = html.match(/const PAYLOAD=(.*);\n/);
  const payloadSame = !!match && JSON.stringify(JSON.parse(match[1])) === JSON.stringify(JSON.parse(payloadText));
  let rebuildCheck = 'python3을 찾지 못해 실행하지 않음';
  for (const python of ['python3', 'python']) {
    const run = spawnSync(python, [path.join(root, 'rebuild_from_payload.py'), '--check'], { encoding: 'utf8' });
    if (!run.error) { rebuildCheck = run.status === 0 ? 'rebuild_from_payload.py --check 통과' : 'rebuild_from_payload.py --check 실패: ' + (run.stdout || run.stderr).trim(); break; }
  }
  return { pass: Object.values(contains).every(Boolean) && payloadSame && !rebuildCheck.includes('실패'), detail: { html: htmlName.normalize('NFC'), bytes: Buffer.byteLength(html), sources_embedded: contains, payload_embedded_equal: payloadSame, rebuild_check: rebuildCheck } };
});
check('P5', '독립 실행 HTML이 외부 자원을 불러오지 않음 (정적 검사)', () => {
  if (!htmlName) return { pass: false, detail: 'HTML 파일이 없습니다.' };
  const html = read(htmlName);
  const patterns = { script_src: /<script[^>]+src=/i, link_tag: /<link\b/i, css_import: /@import/i, remote_url_in_css: /url\(\s*['"]?https?:/i, img_or_iframe: /<(img|iframe|object|embed|video|audio)\b/i, fetch_call: /\bfetch\s*\(/, xhr: /XMLHttpRequest/, websocket: /new\s+WebSocket/, beacon: /sendBeacon/, storage: /localStorage|sessionStorage|indexedDB|document\.cookie/ };
  const found = Object.entries(patterns).filter(([, pattern]) => pattern.test(html)).map(([name]) => name);
  const urls = [...new Set(html.match(/https?:\/\/[^\s"'<>)]+/g) || [])];
  return { pass: found.length === 0 && urls.every(u => u.startsWith('http://www.w3.org/')), detail: { found, urls_in_file: urls, note: 'w3.org 주소는 SVG 네임스페이스 식별자이며 네트워크 요청이 아님' } };
});

/* ---- 평가 자료의 범위 ---- */
check('V1', '평가 자료의 세 범위가 서로 다른 집계임을 확인 (폴드 200건 / 첫 반복 1,000건 / 15회 평균)', () => {
  const ev = PAYLOAD.evaluation, rows = ev.rows;
  const top = (key, k) => [...rows].sort((a, b) => a.ranks[key] - b.ranks[key]).slice(0, k).reduce((s, r) => s + r.label, 0);
  const fold = { rows: rows.length, fraud_labels: rows.reduce((s, r) => s + r.label, 0), top40_logistic: top('Logistic', 40), top40_severity: top('Severity', 40) };
  const repeat = ev.threshold_first_repeat.map(r => ({ threshold: r.threshold, total: r.tp + r.fp + r.fn + r.tn, fraud_labels: r.tp + r.fn, selected_ok: r.selected === r.tp + r.fp }));
  const meanTimes15 = ev.mean_budgets.map(r => r.found * 15), integerLike = meanTimes15.every(v => Math.abs(v - Math.round(v)) < 1e-6);
  const pass = fold.rows === ev.n && fold.fraud_labels === ev.frauds && fold.rows === 200
    && repeat.every(r => r.total === PAYLOAD.metadata.training_rows && r.fraud_labels === PAYLOAD.metadata.fraud_labels && r.selected_ok) && integerLike;
  return { pass, detail: { fold, first_repeat: repeat, mean_budgets_times_15_are_integers: integerLike, note: '이 검사는 집계 범위와 산술 일관성만 확인한다. 모델 성능을 새로 검증하지 않는다.' } };
});

const failed = results.filter(r => !r.pass);
const report = {
  kind: 'engine_and_package_checks',
  executed_at: new Date().toISOString(),
  runtime: `Node.js ${process.version}`,
  status: failed.length ? 'failed' : 'passed',
  passed: results.length - failed.length,
  failed: failed.length,
  not_executed: ['Python 모델과의 1,000건 예측 대조 (원본 자료와 Python 모델이 패키지에 없음. 기존 기록: validation/engine_checks.json)'],
  results
};
fs.writeFileSync(path.join(root, 'validation/rerun_engine_checks.json'), JSON.stringify(report, null, 2) + '\n');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.title}`);
console.log(`\n${report.passed}/${results.length} 통과 → validation/rerun_engine_checks.json`);
process.exit(failed.length ? 1 : 0);
