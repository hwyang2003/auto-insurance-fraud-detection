/* 보험 청구 심사 지원 대시보드 — 화면 로직
 *
 * 계산은 engine.js의 analyzeCase(inputs)와 decision(score, threshold)만 사용한다.
 * 이 파일은 입력 수집, 상태 관리, 결과 표시, 담당자 검토 기록, JSON 저장을 맡는다.
 * 모델 계수·전처리 값·범주는 PAYLOAD에서 읽기만 하고 바꾸지 않는다.
 * 화면에 넣는 모든 글자는 textContent로 넣는다(innerHTML을 쓰지 않는다).
 */
(function () {
  'use strict';

  /* ================= 상수 ================= */
  const THRESHOLDS = [10, 20];            // 기존 선택지 그대로. 기본값은 10점
  const EXPECTED_TOLERANCE = 1e-8;        // 예시 기대 점수와의 허용 오차
  const MEMO_MAX = 2000;
  const MISSING = '__MISSING__';
  const TOP_DRIVERS = 3;
  const CV_DESIGN = { folds: 5, repeats: 3 };   // 팀이 제공한 평가 설명(기존 목업) 기준. payload에는 없는 값
  const REVIEW_LABEL = { unreviewed: '미검토', basic_review: '기본 검토 진행', additional_review: '추가 확인 필요', request_documents: '자료 보완 요청' };
  const DECISION_LABEL = { additional_review: '추가 확인 권고', standard_review: '일반 검토' };
  const VIEW_LABEL = { analysis: '청구 분석', evaluation: '모델 평가', handoff: '연결 데이터' };
  const SERIES = [
    { key: 'Logistic', label: '24개 정보 모델', color: 'var(--series-a)' },
    { key: 'Severity', label: '손상 정도만 쓰는 모델', color: 'var(--series-b)' }
  ];
  const BASELINE = { label: '무작위 선택 기대값', color: 'var(--series-base)' };
  const ICONS = {
    flag: ['M5 21V4', 'M5 5h12l-2.5 4 2.5 4H5'],
    check: ['m5 12.5 4.5 4.5L19 7.5'],
    alert: ['M12 9v4.5', 'M12 17v.1', 'M10.3 4 2.7 17.5a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0Z']
  };
  const FIELDS = PAYLOAD.fields;
  const FIELD_NAMES = FIELDS.map(f => f.name);
  const EVAL = PAYLOAD.evaluation;
  const META = PAYLOAD.metadata;

  /* ================= 상태 ================= */
  const state = {
    caseId: null,          // 'DEMO-001' 또는 'USER-001'
    caseKind: 'sample',    // 'sample' | 'manual'
    current: null,         // 마지막으로 성공한 분석 결과(analyzeCase 반환값 + 식별자)
    previous: null,        // 같은 청구에서 그 직전에 성공한 분석 결과
    phase: 'empty',        // 'empty' | 'fresh' | 'stale' | 'blocked'
    blocked: false,        // 마지막 분석 시도가 실패했는지
    errors: {},            // 필드명 → 오류 문구
    generalError: '',
    run: 0,
    manualCount: 0,
    records: [],           // 담당자 검토 기록. 이 탭의 메모리에만 둔다
    view: 'analysis',
    selfCheck: null
  };

  /* ================= 기본 도구 ================= */
  const $ = id => document.getElementById(id);
  const copy = value => JSON.parse(JSON.stringify(value));
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function applyAttrs(node, attrs) {
    if (!attrs) return node;
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.setAttribute('class', value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    return node;
  }
  function appendChildren(node, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }
  /* 요소를 만든다. 글자는 항상 텍스트 노드로 들어가므로 사용자 입력도 안전하게 표시된다. */
  const el = (tag, attrs, ...children) => appendChildren(applyAttrs(document.createElement(tag), attrs), children);
  const svg = (tag, attrs, ...children) => appendChildren(applyAttrs(document.createElementNS(SVG_NS, tag), attrs), children);
  /* 자식을 통째로 바꾼다. 배열이나 null이 섞여 있어도 요소와 글자만 넣는다. */
  function setChildren(node, ...children) {
    node.replaceChildren();
    return appendChildren(node, children);
  }
  function icon(name, size = 16) {
    return svg('svg', { class: 'icon', viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
      ICONS[name].map(d => svg('path', { d })));
  }

  const nf = (value, digits = 2) => Number(value).toLocaleString('ko-KR', { maximumFractionDigits: digits });
  const signed = (value, digits) => (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value).toFixed(digits);
  const percent = (ratio, digits = 1) => (ratio * 100).toFixed(digits) + '%';
  const timeText = iso => new Date(iso).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
  const dateTimeText = iso => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  /* 화면에 표시하는 점수. 기본은 소수 1자리이고, 반올림 때문에 10점·20점 기준의 반대편으로
     보일 때만 자릿수를 늘린다. 판정은 항상 반올림하지 않은 점수로 한다. */
  function scoreText(score) {
    let digits = 1;
    while (digits < 8 && THRESHOLDS.some(t => (score >= t) !== (Number(score.toFixed(digits)) >= t))) digits += 1;
    return score.toFixed(digits);
  }
  function optionLabel(field, value) {
    const option = field.options && field.options.find(o => o.value === value);
    return option ? option.label : (PAYLOAD.labels[value] || String(value));
  }
  function prettyValue(fieldName, value) {
    if (value === null) return '미상';
    const field = FIELD_MAP[fieldName];
    if (field.type !== 'number') return optionLabel(field, value);
    return nf(value) + (field.unit && field.unit !== '원본 단위' ? field.unit : '');
  }
  const hasMissingOption = field => field.type === 'category' && field.options.some(o => o.value === MISSING);
  const currentSample = () => (state.caseKind === 'sample' ? PAYLOAD.cases.find(c => c.id === state.caseId) : null);
  function currentThreshold() {
    const checked = document.querySelector('input[name="threshold"]:checked');
    return checked ? Number(checked.value) : THRESHOLDS[0];
  }

  /* ================= 입력 양식 ================= */
  function rangeText(field) {
    if (field.type !== 'number') return '';
    const kind = field.integer ? '정수 ' : '';
    if (field.min !== null && field.max !== null) return `${kind}${nf(field.min)}~${nf(field.max)}`;
    if (field.min !== null) return `${kind}${nf(field.min)} 이상`;
    if (field.max !== null) return `${kind}${nf(field.max)} 이하`;
    return field.integer ? '정수' : '';
  }
  function buildField(field) {
    const id = 'field-' + field.name;
    const describedBy = [field.unit ? 'unit-' + field.name : null, 'hint-' + field.name, 'error-' + field.name].filter(Boolean).join(' ');
    let control;
    if (field.type === 'category') {
      control = el('select', { id, name: field.name, 'aria-describedby': describedBy, 'aria-required': field.required ? 'true' : null });
      // 필수 선택 항목만 '선택해 주세요'를 둔다. 선택 항목의 빈 상태는 '미상 (모름)'이다.
      if (field.required || !hasMissingOption(field)) control.append(el('option', { value: '', text: '선택해 주세요' }));
      for (const option of field.options) control.append(el('option', { value: option.value, text: option.label }));
    } else {
      const allowsNegative = field.min === null || field.min < 0;
      control = el('input', {
        id, name: field.name, type: 'number', autocomplete: 'off',
        inputmode: allowsNegative ? null : (field.integer ? 'numeric' : 'decimal'),
        min: field.min, max: field.max, step: field.integer ? '1' : 'any',
        placeholder: field.required ? '필수 입력' : '모르면 빈칸',
        'aria-describedby': describedBy, 'aria-required': field.required ? 'true' : null
      });
    }
    const range = rangeText(field);
    return el('div', { class: 'field' },
      el('label', { for: id }, el('span', { text: field.label }), field.required ? el('span', { class: 'req', text: '필수' }) : null),
      el('div', { class: 'control' + (field.unit ? ' has-unit' : '') }, control,
        field.unit ? el('span', { class: 'unit', id: 'unit-' + field.name, text: field.unit }) : null),
      el('p', { class: 'field-help', id: 'hint-' + field.name, text: field.hint + (range ? ` 입력 가능: ${range}.` : '') }),
      el('code', { class: 'field-key', text: field.name }),
      el('p', { class: 'field-error', id: 'error-' + field.name, hidden: true }));
  }
  function buildFields() {
    setChildren($('fieldGroups'), ...PAYLOAD.groups.map(group => {
      const fields = FIELDS.filter(f => f.group === group.id);
      return el('details', { class: 'field-group', id: 'group-' + group.id, open: !!group.open },
        el('summary', null,
          el('span', { class: 'group-title', text: group.label }),
          el('span', { class: 'group-meta' },
            el('span', { class: 'group-error', id: 'group-error-' + group.id, hidden: true }),
            `${fields.length}개 항목 · 필수 ${fields.filter(f => f.required).length}`)),
        el('p', { class: 'group-desc', text: group.description }),
        el('div', { class: 'input-grid' }, fields.map(buildField)));
    }));
  }
  /* 화면의 현재 입력. 숫자 0, 미상 null, 문자열 "None"을 구분해 그대로 넘긴다. */
  function readInputs() {
    const inputs = {};
    for (const field of FIELDS) {
      const node = $('field-' + field.name), text = node.value;
      if (field.type === 'number') inputs[field.name] = node.validity.badInput ? NaN : (text.trim() === '' ? null : Number(text));
      else inputs[field.name] = (text === '' || text === MISSING) ? null : text;
    }
    return inputs;
  }
  function writeInputs(inputs) {
    for (const field of FIELDS) {
      const node = $('field-' + field.name), value = inputs ? inputs[field.name] : null;
      if (field.type === 'category') node.value = value === null ? (!field.required && hasMissingOption(field) ? MISSING : '') : value;
      else node.value = value === null ? '' : String(value);
    }
  }
  const sameInputs = (a, b) => FIELD_NAMES.every(name => a[name] === b[name]);   // NaN은 어떤 값과도 같지 않다
  function updateInputCount() {
    const inputs = readInputs();
    const filled = FIELD_NAMES.filter(name => inputs[name] !== null).length, missing = FIELD_NAMES.length - filled;
    $('inputCount').textContent = `입력 ${filled} / ${FIELD_NAMES.length}` + (missing ? ` · 미상 ${missing}` : '');
  }
  function renderCaseContext() {
    const sample = currentSample();
    if (sample) {
      const inputs = readInputs();
      const modified = FIELD_NAMES.filter(name => inputs[name] !== sample.inputs[name]).length;
      $('caseContext').textContent = `${sample.id} · ${sample.title} (원본 자료 행 ${sample.source_row})` + (modified ? ` · 예시에서 ${modified}개 항목 수정됨` : '');
      $('caseNote').textContent = sample.note;
    } else {
      $('caseContext').textContent = `${state.caseId} · 직접 입력한 청구`;
      $('caseNote').textContent = `빈 양식입니다. 필수 항목 ${FIELDS.filter(f => f.required).length}개를 입력한 뒤 ‘분석하기’를 누르세요.`;
    }
  }

  /* ================= 입력 오류 표시 ================= */
  function renderGroupErrors() {
    for (const group of PAYLOAD.groups) {
      const count = FIELDS.filter(f => f.group === group.id && state.errors[f.name]).length, badge = $('group-error-' + group.id);
      badge.hidden = count === 0;
      badge.textContent = count ? `오류 ${count}` : '';
    }
  }
  function renderErrorSummary() {
    const box = $('inputErrors'), names = FIELD_NAMES.filter(name => state.errors[name]);
    box.hidden = names.length === 0 && !state.generalError;
    if (box.hidden) { setChildren(box); return; }
    setChildren(box,
      el('b', { text: state.generalError || `입력 ${names.length}개를 확인해 주세요. 오류를 고치기 전에는 분석하지 않습니다.` }),
      names.length ? el('ul', null, names.map(name => el('li', null,
        el('button', { type: 'button', text: state.errors[name], onclick: () => focusField(name) })))) : null);
  }
  function focusField(name) {
    $('group-' + FIELD_MAP[name].group).open = true;
    $('field-' + name).focus();
  }
  function showFieldError(name, message) {
    state.errors[name] = message;
    const node = $('field-' + name), text = $('error-' + name);
    node.setAttribute('aria-invalid', 'true');
    text.textContent = message;
    text.hidden = false;
    $('group-' + FIELD_MAP[name].group).open = true;
  }
  function clearFieldError(name) {
    delete state.errors[name];
    $('field-' + name).removeAttribute('aria-invalid');
    $('error-' + name).hidden = true;
    $('error-' + name).textContent = '';
  }
  function clearAllErrors() {
    for (const name of Object.keys(state.errors)) clearFieldError(name);
    state.generalError = '';
    renderGroupErrors();
    renderErrorSummary();
  }

  /* ================= 상태(최신 / 재분석 필요 / 차단 / 결과 없음) ================= */
  function computePhase() {
    if (state.current && sameInputs(readInputs(), state.current.inputs)) return 'fresh';
    if (state.blocked) return 'blocked';
    return state.current ? 'stale' : 'empty';
  }
  function lockReason(phase) {
    if (phase === 'stale') return '입력이 바뀌어, 다시 분석하기 전에는 검토 기록과 결과 저장을 할 수 없습니다.';
    if (phase === 'blocked') return '분석이 차단되어 검토 기록과 결과 저장을 할 수 없습니다.';
    return '분석 결과가 있어야 검토 기록과 결과 저장을 할 수 있습니다.';
  }
  function renderPhase() {
    const phase = state.phase, errorCount = Object.keys(state.errors).length;
    document.body.dataset.phase = phase;

    // 결과 영역: 분석에 실패했거나 결과가 없으면 이전 결과를 보여 주지 않는다.
    const showResult = phase === 'fresh' || phase === 'stale';
    $('resultRegion').hidden = !showResult;
    $('resultRegion').classList.toggle('is-stale', phase === 'stale');
    $('staleTag').hidden = phase !== 'stale';
    $('resultPlaceholder').hidden = showResult;
    if (phase === 'blocked') {
      $('placeholderTitle').textContent = '분석이 차단되었습니다';
      $('placeholderText').textContent = '입력 오류가 있어 계산하지 않았습니다. 오류가 표시된 항목을 고친 뒤 다시 분석해 주세요.';
    } else if (phase === 'empty') {
      $('placeholderTitle').textContent = '아직 분석 결과가 없습니다';
      $('placeholderText').textContent = '정보를 입력하고 ‘분석하기’를 누르면 모델 점수와 검토 구분, 영향 요인이 여기에 표시됩니다.';
    }

    // 안내 띠
    const banner = $('phaseBanner');
    banner.hidden = !(phase === 'stale' || phase === 'blocked');
    banner.classList.toggle('danger', phase === 'blocked');
    if (phase === 'stale') {
      setChildren(banner, icon('alert', 18), el('div', null,
        el('p', null, el('b', { text: '입력이 바뀌었습니다. ' }), '아래는 이전 입력으로 계산한 결과입니다. 현재 입력의 결과를 보려면 다시 분석해 주세요.'),
        el('button', { type: 'button', class: 'button secondary banner-action', text: '다시 분석하기',
          onclick: () => { if (runAnalysis({ reveal: true })) $('scoreTitle').focus({ preventScroll: true }); } })));
    } else if (phase === 'blocked') {
      setChildren(banner, icon('alert', 18), el('div', null,
        el('b', { text: '분석하지 못했습니다. ' }),
        state.generalError || (errorCount ? `입력 오류 ${errorCount}개를 고친 뒤 다시 분석해 주세요.` : '오류 항목을 수정했습니다. 다시 분석해 주세요.'),
        state.current ? ' 이전 분석 결과는 현재 입력의 결과가 아니므로 숨겼습니다.' : ''));
    } else setChildren(banner);

    // 재분석 전에는 검토 기록과 결과 내보내기를 막는다.
    const locked = phase !== 'fresh';
    for (const id of ['saveReview', 'exportResult', 'exportFromHandoff']) $(id).disabled = locked;
    $('reviewLock').hidden = !locked;
    $('reviewLock').textContent = locked ? lockReason(phase) : '';

    // 입력 양식 아래 상태 줄과 버튼 문구
    let status;
    if (phase === 'fresh') status = `현재 입력의 분석 결과가 표시되어 있습니다 (${scoreText(state.current.score)}점).`;
    else if (phase === 'stale') status = '입력이 바뀌었습니다. 다시 분석해야 결과에 반영됩니다.';
    else if (phase === 'blocked') status = state.generalError || (errorCount ? `입력 오류 ${errorCount}개를 확인해 주세요.` : '오류 항목을 수정했습니다. 다시 분석해 주세요.');
    else status = '아직 분석하지 않았습니다. 필수 항목을 입력한 뒤 분석하세요.';
    $('formStatus').textContent = status;
    $('analyzeButton').textContent = phase === 'empty' ? '분석하기' : '다시 분석하기';
    $('resetCase').setAttribute('aria-label', state.caseKind === 'sample' ? '초기화: 예시의 원래 값으로 되돌리고 다시 분석합니다' : '초기화: 입력을 모두 지웁니다');

    renderGroupErrors();
    renderErrorSummary();
    renderHandoff();
  }
  function refreshPhase() {
    const phase = computePhase();
    if (phase === 'fresh' && state.blocked) {   // 분석했던 입력으로 되돌아왔다
      state.blocked = false;
      for (const name of Object.keys(state.errors)) clearFieldError(name);
      state.generalError = '';
    }
    state.phase = phase;
    renderPhase();
  }
  function onFormInput(event) {
    const name = event.target && event.target.name;
    if (name && state.errors[name]) clearFieldError(name);   // 고치기 시작한 항목의 오류만 지운다
    if (state.generalError) state.generalError = '';
    updateInputCount();
    renderCaseContext();
    refreshPhase();
  }

  /* ================= 분석 ================= */
  function failAnalysis(errors, generalMessage) {
    for (const name of Object.keys(state.errors)) clearFieldError(name);
    state.generalError = generalMessage || '';
    state.blocked = true;
    for (const error of errors) if (FIELD_MAP[error.field]) showFieldError(error.field, error.message);
    state.phase = 'blocked';
    updateInputCount();
    renderPhase();
    if (errors.length && FIELD_MAP[errors[0].field]) focusField(errors[0].field);
    else $('inputErrors').focus();
  }
  /* 현재 입력을 analyzeCase에 전달하고 반환값으로 화면을 갱신한다. */
  function runAnalysis(options = {}) {
    const inputs = readInputs();
    let result;
    try { result = analyzeCase(inputs); }
    catch (error) { failAnalysis([], '계산을 완료하지 못했습니다. 입력을 확인한 뒤 다시 시도해 주세요.'); return false; }
    if (result.status !== 'ok') { failAnalysis(result.errors || [], ''); return false; }

    for (const name of Object.keys(state.errors)) clearFieldError(name);
    state.generalError = '';
    state.blocked = false;
    state.previous = state.current;
    state.run += 1;
    state.current = { ...result, case_id: state.caseId, prediction_id: `${state.caseId}-P${String(state.run).padStart(4, '0')}`, analyzed_at: new Date().toISOString() };
    state.phase = 'fresh';
    if (state.previous) {   // 새 결과이므로 판단은 다시 고르게 하고, 작성 중인 메모는 지우지 않는다
      const hadJudgement = getJudgement() !== 'unreviewed', hasMemo = $('reviewNote').value.trim() !== '';
      resetJudgement();
      setReviewMessage(hadJudgement || hasMemo
        ? '새 분석 결과입니다. 담당자 판단을 다시 선택해 주세요.' + (hasMemo ? ' 작성 중인 메모는 그대로 두었으니 내용이 새 결과에 맞는지 확인하세요.' : '')
        : '', '');
    }
    updateInputCount();
    renderCaseContext();
    renderResult();
    renderHistory();
    renderPhase();
    if (options.reveal) revealResult();
    return true;
  }
  function revealResult() {
    const rect = $('scorePanel').getBoundingClientRect();
    if (rect.top >= 0 && rect.top < window.innerHeight * 0.6) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('scorePanel').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }

  /* ================= 결과 표시 ================= */
  /* 검토 구분은 점수 계산과 분리된 decision(score, threshold)로만 정한다. */
  function renderRecommendation() {
    const result = state.current;
    if (!result) return;
    const threshold = currentThreshold(), kind = decision(result.score, threshold), extra = kind === 'additional_review';
    const pill = $('recommendation');
    pill.className = 'pill ' + (extra ? 'additional' : 'standard');
    setChildren(pill, icon(extra ? 'flag' : 'check', 14), DECISION_LABEL[kind]);
    $('resultHeadline').textContent = extra ? '확인할 정보를 살펴보세요.' : '기본 확인 절차를 진행하세요.';
    $('resultSentence').textContent = extra
      ? `모델 점수가 검토 기준 ${threshold}점 이상입니다. 아래 영향 요인과 입력 자료를 확인하세요.`
      : `모델 점수가 검토 기준 ${threshold}점 미만입니다. 낮은 점수만으로 정상이라고 확정하지 않습니다.`;
    $('meterThreshold').style.left = threshold + '%';
    $('meterThresholdLabel').textContent = `기준 ${threshold}점`;
    $('scoreMeter').setAttribute('aria-label', `모델 점수 ${scoreText(result.score)}점, 검토 기준 ${threshold}점, ${DECISION_LABEL[kind]}`);
  }
  function usedValueText(row) {
    const field = FIELD_MAP[row.field];
    if (row.input_value !== null) return prettyValue(row.field, row.used_value);
    return field.type === 'number' ? `미상 → 학습 자료 중앙값 ${prettyValue(row.field, row.used_value)} 사용` : '미상 → 미상 범주로 계산';
  }
  function driverRow(row, direction, max) {
    const label = FIELD_MAP[row.field].label;
    return el('div', { class: 'driver', title: `${label}: 로그오즈 기여 ${signed(row.contribution, 6)}` },
      el('div', { class: 'driver-line' },
        el('div', { class: 'driver-name' }, el('strong', { text: label }), el('span', { class: 'driver-value', text: usedValueText(row) })),
        el('span', { class: 'driver-number', text: signed(row.contribution, 3) })),
      el('div', { class: 'driver-track' },
        el('div', { class: 'driver-fill ' + direction, style: `width:${(Math.abs(row.contribution) / max * 100).toFixed(2)}%` })));
  }
  function renderDrivers() {
    const rows = state.current.contributions;
    const max = Math.max(...rows.map(r => Math.abs(r.contribution)), 1e-12);
    const groups = [
      ['positive', 'up', rows.filter(r => r.contribution > 1e-10).sort((a, b) => b.contribution - a.contribution)],
      ['negative', 'down', rows.filter(r => r.contribution < -1e-10).sort((a, b) => a.contribution - b.contribution)]
    ];
    for (const [prefix, direction, list] of groups) {
      $(prefix + 'Count').textContent = list.length > TOP_DRIVERS ? `${list.length}개 중 영향이 큰 ${TOP_DRIVERS}개` : (list.length ? `${list.length}개` : '');
      setChildren($(prefix + 'Drivers'), ...(list.length
        ? list.slice(0, TOP_DRIVERS).map(row => driverRow(row, direction, max))
        : [el('p', { class: 'empty-line', text: '이 방향으로 작용한 입력이 없습니다.' })]));
    }
  }
  function renderAllContributions() {
    const result = state.current;
    const rows = [...result.contributions].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    setChildren($('allContributions'), ...rows.map(row => el('tr', null,
      el('td', null, FIELD_MAP[row.field].label, el('code', { class: 'field-key', text: row.field })),
      el('td', { text: usedValueText(row) }),
      el('td', { class: 'num' },
        el('span', { class: row.contribution > 0 ? 'sign-up' : (row.contribution < 0 ? 'sign-down' : ''), 'aria-hidden': 'true' }),
        signed(row.contribution, 4)))));
    $('calculationSummary').textContent =
      `기준 내부값 ${signed(result.base_log_odds, 4)} + 24개 기여의 합 ${signed(result.contribution_sum, 4)} = 이 청구의 내부값 ${signed(result.log_odds, 4)} (단위: 로그오즈). ` +
      `이 내부값을 0~100 범위로 변환한 값이 모델 점수 ${result.score.toFixed(6)}점이고, 화면에는 ${scoreText(result.score)}점으로 표시합니다. ` +
      `기준 내부값은 학습 자료의 평균적인 입력 상태에 해당하며, 같은 방식으로 변환하면 ${(100 * sigmoid(result.base_log_odds)).toFixed(1)}점입니다. ` +
      '기여는 내부값에 더해지는 양이므로, 점수에 그대로 더하거나 뺄 수 없습니다.';
    $('calculationMeta').textContent = `모델 버전 ${result.model_version} · 기준값과 기여를 합쳐 내부값을 복원한 오차 ${result.reconstruction_error.toExponential(2)}`;
  }
  function renderChangeSummary() {
    const result = state.current, previous = state.previous, box = $('changeSummary');
    const changed = previous ? FIELD_NAMES.filter(name => result.inputs[name] !== previous.inputs[name]) : [];
    box.hidden = changed.length === 0;
    if (!changed.length) { setChildren(box); return; }
    setChildren(box,
      el('p', null, `이전 분석 ${scoreText(previous.score)}점 → 이번 분석 ${scoreText(result.score)}점 `,
        el('b', { text: `(모델 점수 ${signed(result.score - previous.score, 1)}점)` })),
      el('p', { class: 'sub', text: '바꾼 입력: ' + changed.map(name =>
        `${FIELD_MAP[name].label} (${prettyValue(name, previous.inputs[name])} → ${prettyValue(name, result.inputs[name])})`).join(', ') }));
  }
  function renderProcessing() {
    const result = state.current, processed = result.input_processing, warnings = result.warnings;
    const missingChip = $('missingCount'), warningChip = $('warningCount');
    missingChip.textContent = processed.length ? `미상 처리 ${processed.length}건` : '미상 처리 없음';
    missingChip.className = 'chip' + (processed.length ? ' attention' : '');
    warningChip.textContent = warnings.length ? `경고 ${warnings.length}건` : '경고 없음';
    warningChip.className = 'chip' + (warnings.length ? ' attention' : '');
    setChildren($('processingList'), ...(processed.length ? processed.map(item => {
      const contribution = result.contributions.find(row => row.field === item.field);
      return el('div', { class: 'processing' },
        el('strong', { text: FIELD_MAP[item.field].label }),
        el('p', { text: item.method === 'median'
          ? `빈칸이어서 학습 자료의 중앙값을 사용했습니다. 사용한 값: ${prettyValue(item.field, item.used_value)}. 0으로 바꾸지 않았습니다.`
          : '미상 범주로 계산했습니다. ‘없음’이나 다른 범주로 바꾸지 않았습니다.' }),
        contribution ? el('p', { class: 'sub', text: `이 처리의 로그오즈 기여: ${signed(contribution.contribution, 3)}` }) : null);
    }) : [el('div', { class: 'processing ok' },
      el('strong', { text: '미상으로 처리한 입력이 없습니다.' }),
      el('p', { text: `입력한 ${FIELD_NAMES.length}개 값을 그대로 계산에 사용했습니다.` }))]));
    setChildren($('rangeWarnings'), ...warnings.map(warning => {
      const spec = PAYLOAD.model.spec[warning.field];
      const range = spec && spec.type === 'number' ? ` (학습 자료 범위: ${nf(spec.min)}~${nf(spec.max)})` : '';
      return el('p', { class: 'warning-item' }, icon('alert'), el('span', { text: warning.message + range }));
    }));
  }
  function renderResult() {
    const result = state.current;
    if (!result) return;
    $('scoreValue').textContent = scoreText(result.score);
    $('meterFill').style.width = Math.max(0, Math.min(100, result.score)) + '%';
    $('resultMeta').textContent = `분석 ID ${result.prediction_id} · ${timeText(result.analyzed_at)}`;
    renderRecommendation();
    renderChangeSummary();
    renderDrivers();
    renderAllContributions();
    renderProcessing();
  }

  /* ================= 담당자 검토 ================= */
  function getJudgement() {
    const checked = document.querySelector('input[name="reviewStatus"]:checked');
    return checked ? checked.value : 'unreviewed';
  }
  function resetJudgement() {
    for (const node of document.querySelectorAll('input[name="reviewStatus"]')) node.checked = false;
  }
  function updateNoteCount() {
    $('noteCount').textContent = `${nf($('reviewNote').value.length, 0)} / ${nf(MEMO_MAX, 0)}자`;
  }
  function setMessage(id, message, kind) {
    $(id).textContent = message;
    $(id).className = 'review-message' + (kind ? ' ' + kind : '');
  }
  const setReviewMessage = (message, kind) => setMessage('reviewMessage', message, kind);
  function clearDraft() {
    resetJudgement();
    $('reviewNote').value = '';
    updateNoteCount();
    setReviewMessage('', '');
  }
  /* 기록은 모델 점수와 분리해 state.records에만 쌓는다. 분석 결과(state.current)는 건드리지 않는다. */
  function saveReview() {
    if (state.phase !== 'fresh' || !state.current) { setReviewMessage('먼저 현재 입력을 다시 분석해 주세요.', 'error'); return false; }
    const status = getJudgement(), memo = $('reviewNote').value.trim();
    if (status === 'unreviewed') { setReviewMessage('담당자 판단을 선택해 주세요.', 'error'); $('review-basic').focus(); return false; }
    if (!memo) { setReviewMessage('판단 사유를 검토 메모에 입력해 주세요.', 'error'); $('reviewNote').focus(); return false; }
    if (memo.length > MEMO_MAX) { setReviewMessage(`검토 메모는 ${nf(MEMO_MAX, 0)}자 이내로 입력해 주세요.`, 'error'); $('reviewNote').focus(); return false; }
    const result = state.current, threshold = currentThreshold();
    state.records.push({
      record_id: 'REVIEW-' + String(state.records.length + 1).padStart(3, '0'),
      case_id: state.caseId,
      prediction_id: result.prediction_id,
      created_at: new Date().toISOString(),
      review_status: status,
      memo,
      model_score_at_review: result.score,
      threshold_at_review: threshold,
      model_recommendation_at_review: decision(result.score, threshold),
      inputs_at_review: copy(result.inputs)
    });
    clearDraft();
    setReviewMessage('검토 기록을 이 탭에 남겼습니다. 모델 점수는 바뀌지 않았습니다.', 'ok');
    renderHistory();
    renderHandoff();
    $('historyDetails').open = true;
    return true;
  }
  function renderHistory() {
    const records = state.records.filter(record => record.case_id === state.caseId);
    $('historyCount').textContent = String(records.length);
    setChildren($('reviewHistory'), ...(records.length ? [...records].reverse().map(record => {
      const older = state.current && record.prediction_id !== state.current.prediction_id;
      return el('article', { class: 'history-item' },
        el('strong', { text: REVIEW_LABEL[record.review_status] || record.review_status }),
        el('p', { class: 'history-memo', text: record.memo }),   // 사용자 입력은 텍스트로만 표시
        el('p', { class: 'history-meta', text:
          `${dateTimeText(record.created_at)} · ${record.prediction_id}${older ? ' (이전 분석 기준)' : ''} · ` +
          `당시 모델 점수 ${scoreText(record.model_score_at_review)}점 · 기준 ${record.threshold_at_review}점 · ${DECISION_LABEL[record.model_recommendation_at_review]}` }));
    }) : [el('p', { class: 'empty-line', text: '이 청구에 남긴 검토 기록이 없습니다.' })]));
  }

  /* ================= 결과 JSON ================= */
  /* analyzeCase 반환값(평평한 구조)을 저장용 구조(prediction / review_policy / explanation …)로 옮겨 담는다. */
  function makeExport() {
    if (!state.current || state.phase !== 'fresh') throw new Error('현재 입력을 다시 분석한 뒤에 저장할 수 있습니다.');
    const result = state.current, threshold = currentThreshold(), sample = currentSample();
    const modified = sample ? FIELD_NAMES.filter(name => result.inputs[name] !== sample.inputs[name]) : [];
    return {
      schema_version: 'claim-review-demo-v1',
      purpose: 'prototype_demonstration',
      case_id: state.caseId,
      source_row: sample ? sample.source_row : null,
      prediction_id: result.prediction_id,
      analyzed_at: result.analyzed_at,
      inputs: copy(result.inputs),
      prediction: { model_version: result.model_version, score: result.score, probability: result.probability, score_scale: '0-100; not calibrated real-world probability' },
      review_policy: { threshold, recommendation: decision(result.score, threshold), provisional: true },
      explanation: {
        method: 'linear_logit_contribution_relative_to_training_transformed_mean', unit: 'log_odds',
        base: result.base_log_odds, contribution_sum: result.contribution_sum, log_odds: result.log_odds,
        reconstruction_error: result.reconstruction_error, contributions: copy(result.contributions)
      },
      input_processing: copy(result.input_processing),
      warnings: copy(result.warnings),
      review_records: copy(state.records.filter(record => record.case_id === state.caseId)),
      context: {
        demo_model_training_rows: META.training_rows,
        sample_was_in_training_data: sample ? true : null,
        input_source: sample ? 'sample' : 'manual_entry',
        inputs_match_sample: sample ? modified.length === 0 : null,
        modified_fields: modified,
        performance_source: 'separate held-out cross-validation',
        currency: 'original dataset units; not converted to KRW',
        storage: 'browser tab memory; no server persistence'
      }
    };
  }
  function downloadResult(event) {
    const messageId = event && event.currentTarget && event.currentTarget.id === 'exportFromHandoff' ? 'handoffMessage' : 'reviewMessage';
    let data;
    try { data = makeExport(); }
    catch (error) { setMessage(messageId, error.message, 'error'); return false; }
    const name = `${data.case_id}_${data.prediction_id}_result.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = el('a', { href: url, download: name, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(messageId, `결과 JSON을 내려받았습니다: ${name}`, 'ok');
    return true;
  }

  /* ================= 연결 데이터 ================= */
  function renderHandoff() {
    const result = state.current, phase = state.phase, banner = $('handoffState');
    banner.hidden = phase === 'fresh';
    banner.classList.toggle('danger', phase === 'blocked');
    if (phase === 'stale') banner.textContent = '입력이 바뀌어 다시 분석해야 합니다. 아래 입력은 마지막으로 분석한 값이며, 결과 JSON은 다시 분석한 뒤에 만들 수 있습니다.';
    else if (phase === 'blocked') banner.textContent = '입력 오류로 분석이 차단되었습니다. 현재 입력에 대한 결과가 없습니다.';
    else if (phase === 'empty') banner.textContent = '아직 분석 결과가 없습니다. 청구 분석 화면에서 입력을 분석하면 여기에 표시됩니다.';
    $('inputJson').textContent = result ? JSON.stringify(result.inputs, null, 2) : '분석한 입력이 없습니다.';
    $('outputJson').textContent = phase === 'fresh' ? JSON.stringify(makeExport(), null, 2) : '현재 입력을 다시 분석하면 표시됩니다.';
  }
  function runSelfCheck() {
    const rows = PAYLOAD.cases.map(sample => {
      try {
        const result = analyzeCase(sample.inputs);
        if (result.status !== 'ok') return { id: sample.id, expected: sample.expected_score, score: null, diff: null, pass: false };
        const diff = Math.abs(result.score - sample.expected_score);
        return { id: sample.id, expected: sample.expected_score, score: result.score, diff, pass: diff <= EXPECTED_TOLERANCE };
      } catch (error) {
        return { id: sample.id, expected: sample.expected_score, score: null, diff: null, pass: false };
      }
    });
    state.selfCheck = { rows, passed: rows.every(row => row.pass) };
  }
  function buildHandoffStatic() {
    const check = state.selfCheck;
    $('selfCheckStatus').textContent = check.passed ? `${check.rows.length}건 모두 일치` : '불일치 있음';
    $('selfCheckStatus').className = 'chip ' + (check.passed ? 'good' : 'bad');
    setChildren($('selfCheckTable'), ...check.rows.map(row => el('tr', null,
      el('td', { text: row.id }),
      el('td', { class: 'num', text: row.expected.toFixed(9) }),
      el('td', { class: 'num', text: row.score === null ? '계산 실패' : row.score.toFixed(9) }),
      el('td', { class: 'num', text: row.diff === null ? '—' : row.diff.toExponential(2) }),
      el('td', { text: row.pass ? '일치' : '불일치' }))));
    if (!check.passed) {
      $('integrityAlert').hidden = false;
      setChildren($('integrityAlert'), icon('alert', 18), el('div', null,
        el('b', { text: '계산 점검에 실패했습니다. ' }),
        '내장 예시의 계산값이 기록된 기대 점수와 다릅니다. 소스와 데이터가 맞지 않을 수 있으니 이 파일의 결과를 사용하지 마세요.'));
    }

    setChildren($('packageIncluded'),
      el('li', { text: `모델 계산 파라미터 — ${nf(META.training_rows, 0)}건으로 학습한 로지스틱 회귀의 계수, 전처리 값(중앙값·평균·표준편차), 설명 기준값` }),
      el('li', { text: `입력 항목 정의 ${FIELDS.length}개 — 한국어 이름, 선택지, 필수 여부, 단위` }),
      el('li', { text: `입력 예시 ${PAYLOAD.cases.length}건과 각 예시의 기대 점수` }),
      el('li', { text: `평가 자료 — 평가 폴드 1개의 ${nf(EVAL.rows.length, 0)}건(사기 표시·예측값·순위), 교차검증 첫 반복의 기준 점수별 집계, 평가 ${CV_DESIGN.folds * CV_DESIGN.repeats}회 평균` }));
    setChildren($('packageExcluded'),
      el('li', { text: `원본 학습 자료 ${nf(META.training_rows, 0)}건 전체 (행 단위 자료)` }),
      el('li', { text: '학습 코드와 Python 모델 — 이 화면에서는 다시 학습하지 않습니다' }),
      el('li', { text: 'CSV 업로드, 로그인, 서버 저장, 외부 서비스 연동' }));
    $('packageMeta').textContent = `모델 버전 ${PAYLOAD.model.version} · 자료 생성일 ${META.created} · 원본 자료 SHA-256 ${String(META.data_sha256).slice(0, 12)}…`;

    setChildren($('schemaTable'), ...FIELDS.map(field => {
      const spec = PAYLOAD.model.spec[field.name], isNumber = field.type === 'number';
      let blank;
      if (field.required) blank = '입력 요구 (비우면 분석 차단)';
      else if (isNumber) blank = `학습 자료 중앙값 ${nf(spec.median)}`;
      else blank = '미상 범주로 계산';
      return el('tr', null,
        el('td', { text: field.label }),
        el('td', null, el('code', { text: field.name })),
        el('td', { text: isNumber ? (field.integer ? '정수' : '숫자') + (field.unit ? ` (${field.unit})` : '') : `선택지 ${field.options.filter(o => o.value !== MISSING).length}개` + (hasMissingOption(field) ? ' + 미상' : '') }),
        el('td', { text: field.required ? '필수' : '선택' }),
        el('td', { text: isNumber ? (rangeText(field).replace('정수 ', '') || '제한 없음') : '목록의 값만' }),
        el('td', { text: isNumber ? `${nf(spec.min)}~${nf(spec.max)}` : '—' }),
        el('td', { text: blank }));
    }));
  }

  /* ================= 모델 평가 ================= */
  const gain = { gains: null, n: 0, total: 0, geometry: null, k: 40, pinned: false };

  /* 평가 폴드의 시험 예측값을 기록된 순위대로 훑으며 사기 표시를 누적한다. gains[key][k] = 상위 k건 안의 사기 표시 수 */
  function buildFoldGains() {
    gain.n = EVAL.rows.length;
    gain.total = EVAL.rows.reduce((sum, row) => sum + row.label, 0);
    gain.gains = {};
    for (const series of SERIES) {
      const ordered = [...EVAL.rows].sort((a, b) => a.ranks[series.key] - b.ranks[series.key]);
      let found = 0;
      gain.gains[series.key] = [0, ...ordered.map(row => (found += row.label))];
    }
  }
  const baselineAt = k => k * gain.total / gain.n;
  function niceTicks(max, target) {
    const raw = max / target, power = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= raw - 1e-9) || raw;
    const ticks = [];
    for (let value = 0; value <= max + 1e-9; value += step) ticks.push(Math.round(value * 1e6) / 1e6);
    return ticks;
  }
  function drawGainChart() {
    const host = $('gainChart'), width = Math.floor(host.clientWidth);
    if (!width || !gain.gains) return;                       // 숨겨진 화면에서는 그리지 않는다
    const height = Math.round(Math.max(230, Math.min(320, width * 0.52)));
    const m = { top: 28, right: 14, bottom: 44, left: 40 };
    const pw = width - m.left - m.right, ph = height - m.top - m.bottom;
    const x = k => m.left + (k / gain.n) * pw, y = v => m.top + ph - (v / gain.total) * ph;
    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' });
    for (const value of niceTicks(gain.total, 5)) {
      root.append(
        svg('line', { x1: m.left, x2: m.left + pw, y1: y(value), y2: y(value), style: 'stroke:var(--grid);stroke-width:1' }),
        svg('text', { x: m.left - 8, y: y(value) + 4, 'text-anchor': 'end', text: String(value) }));
    }
    for (const value of niceTicks(gain.n, 4)) {
      root.append(svg('text', { x: x(value), y: m.top + ph + 18, 'text-anchor': 'middle', text: String(value) }));
    }
    root.append(
      svg('text', { class: 'axis-title', x: 0, y: 12, text: '포함된 사기 표시 (건)' }),
      svg('text', { class: 'axis-title', x: m.left + pw / 2, y: height - 6, 'text-anchor': 'middle', text: '검토한 건수 (점수가 높은 순)' }),
      svg('line', { x1: x(0), y1: y(0), x2: x(gain.n), y2: y(gain.total), style: `stroke:${BASELINE.color};stroke-width:1.5` }));
    for (const series of SERIES) {
      root.append(svg('polyline', {
        points: gain.gains[series.key].map((value, k) => `${x(k).toFixed(1)},${y(value).toFixed(1)}`).join(' '),
        style: `fill:none;stroke:${series.color};stroke-width:2;stroke-linejoin:round;stroke-linecap:round`
      }));
    }
    const cross = svg('g', { id: 'gainCross', style: 'display:none' },
      svg('line', { y1: m.top, y2: m.top + ph, style: 'stroke:var(--ink-2);stroke-width:1' }),
      SERIES.map(series => svg('circle', { r: 4.5, 'data-series': series.key, style: `fill:${series.color};stroke:var(--surface);stroke-width:2` })),
      svg('circle', { r: 3.5, 'data-series': 'baseline', style: `fill:${BASELINE.color};stroke:var(--surface);stroke-width:2` }));
    root.append(cross);
    setChildren(host, root);
    gain.geometry = { m, pw, ph, width, x, y };
  }
  function showGainTip(k) {
    const g = gain.geometry, cross = document.getElementById('gainCross'), tip = $('gainTooltip');
    if (!g || !cross) return;
    k = Math.max(1, Math.min(gain.n, Math.round(k)));
    gain.k = k;
    cross.style.display = '';
    const line = cross.querySelector('line');
    line.setAttribute('x1', g.x(k));
    line.setAttribute('x2', g.x(k));
    for (const dot of cross.querySelectorAll('circle')) {
      const key = dot.getAttribute('data-series');
      dot.setAttribute('cx', g.x(k));
      dot.setAttribute('cy', g.y(key === 'baseline' ? baselineAt(k) : gain.gains[key][k]));
    }
    setChildren(tip,
      el('div', { class: 'tip-title', text: `점수가 높은 ${k}건을 검토하면` }),
      SERIES.map(series => el('div', { class: 'tip-row' },
        el('i', { style: `background:${series.color}` }), el('b', { text: `${gain.gains[series.key][k]}건` }), el('span', { text: series.label }))),
      el('div', { class: 'tip-row' },
        el('i', { style: `background:${BASELINE.color}` }), el('b', { text: `${nf(baselineAt(k), 1)}건` }), el('span', { text: BASELINE.label })));
    tip.hidden = false;
    const tipWidth = tip.offsetWidth, right = g.x(k) + 12;
    tip.style.left = Math.max(0, right + tipWidth > g.width ? g.x(k) - 12 - tipWidth : right) + 'px';
    tip.style.top = g.m.top + 'px';
  }
  function hideGainTip() {
    const cross = document.getElementById('gainCross');
    if (cross) cross.style.display = 'none';
    $('gainTooltip').hidden = true;
  }
  function bindGainChart() {
    const host = $('gainChart');
    const kAt = event => {
      const g = gain.geometry, rect = host.getBoundingClientRect();
      return g ? ((event.clientX - rect.left - g.m.left) / g.pw) * gain.n : gain.k;
    };
    host.addEventListener('pointermove', event => showGainTip(kAt(event)));
    host.addEventListener('pointerdown', event => showGainTip(kAt(event)));
    host.addEventListener('pointerleave', event => {   // 터치에서는 손을 떼도 마지막 위치의 값을 남겨 둔다
      if (event.pointerType !== 'touch' && document.activeElement !== host) hideGainTip();
    });
    host.addEventListener('focus', () => showGainTip(gain.k));
    host.addEventListener('blur', hideGainTip);
    host.addEventListener('keydown', event => {
      const step = event.shiftKey ? 10 : 1;
      let k = gain.k;
      if (event.key === 'ArrowRight') k += step;
      else if (event.key === 'ArrowLeft') k -= step;
      else if (event.key === 'Home') k = 1;
      else if (event.key === 'End') k = gain.n;
      else return;
      event.preventDefault();
      showGainTip(k);
    });
  }
  function seriesHead(first) {
    return el('tr', null, el('th', { text: first }),
      SERIES.map(series => el('th', { class: 'num', text: series.label })), el('th', { class: 'num', text: BASELINE.label }));
  }
  function evalBar(label, value, max, color) {
    return el('div', { class: 'eval-row', title: `${label}: ${nf(value)}건 / ${max}건` },
      el('div', { class: 'eval-head' }, el('span', { text: label }), el('b', { text: `${value.toFixed(2)}건` })),
      el('div', { class: 'eval-track' }, el('div', { style: `width:${(value / max * 100).toFixed(2)}%;background:${color}` })));
  }
  function buildEvaluation() {
    buildFoldGains();
    const runs = CV_DESIGN.folds * CV_DESIGN.repeats, baseRate = META.fraud_labels / META.training_rows;
    const firstRepeat = EVAL.threshold_first_repeat, repeatRows = firstRepeat.length ? firstRepeat[0].tp + firstRepeat[0].fp + firstRepeat[0].fn + firstRepeat[0].tn : 0;
    const repeatFrauds = firstRepeat.length ? firstRepeat[0].tp + firstRepeat[0].fn : 0;
    const scopeFold = `범위 A · 평가 폴드 1개 · 시험 ${nf(gain.n, 0)}건`;
    const scopeRepeat = `범위 B · 교차검증 첫 반복 · 시험 예측 ${nf(repeatRows, 0)}건`;
    const scopeMean = `범위 C · 평가 ${runs}회 평균 · 회당 시험 ${nf(EVAL.n, 0)}건`;
    $('scopeFold').textContent = scopeFold;
    $('scopeRepeat').textContent = scopeRepeat;
    $('scopeMean').textContent = scopeMean;

    const tile = (scope, plain, label, value, unit, text) => el('article', { class: 'panel metric' },
      el('span', { class: 'scope' + (plain ? ' plain' : ''), text: scope }),
      el('span', { class: 'metric-label', text: label }),
      el('strong', null, value, unit ? el('small', { text: unit }) : null),
      el('p', { text }));
    setChildren($('evalMetrics'),
      tile('모델 학습', true, '학습에 사용된 자료', nf(META.training_rows, 0), '건',
        `사기 표시 ${nf(META.fraud_labels, 0)}건 · 그 외 ${nf(META.training_rows - META.fraud_labels, 0)}건. 원본 행은 이 패키지에 들어 있지 않습니다.`),
      tile('범위 A', false, '평가 폴드 1개', nf(gain.n, 0), '건',
        `사기 표시 ${nf(gain.total, 0)}건 포함. 누적 그래프가 이 범위입니다.`),
      tile('범위 B', false, '교차검증 첫 반복', nf(repeatRows, 0), '건',
        `사기 표시 ${nf(repeatFrauds, 0)}건 포함. 기준 점수별 집계가 이 범위입니다.`),
      tile('범위 C', false, '반복 교차검증 평균', `${CV_DESIGN.folds}분할 × ${CV_DESIGN.repeats}회`, '',
        `회마다 ${nf(META.training_rows - EVAL.n, 0)}건으로 학습하고 ${nf(EVAL.n, 0)}건으로 시험한 ${runs}회의 평균입니다.`));

    // 범위 A: 평가 폴드 1개
    setChildren($('gainLegend'),
      SERIES.map(series => el('span', null, el('i', { style: `background:${series.color}` }), series.label)),
      el('span', null, el('i', { style: `background:${BASELINE.color}` }), BASELINE.label));
    setChildren($('gainTableHead'), seriesHead('검토한 건수'));
    const foldSteps = [10, 20, 40, 60, 100, gain.n].filter((k, i, list) => k <= gain.n && list.indexOf(k) === i);
    setChildren($('gainTable'), ...foldSteps.map(k => el('tr', null,
      el('td', { text: `상위 ${k}건` + (k === gain.n ? ' (전체)' : '') }),
      SERIES.map(series => el('td', { class: 'num', text: `${gain.gains[series.key][k]}건` })),
      el('td', { class: 'num', text: `${nf(baselineAt(k), 1)}건` }))));
    const tiedLevels = new Set(EVAL.rows.map(row => row.scores.Severity)).size;
    $('gainNote').textContent =
      `손상 정도만 쓰는 모델은 점수가 ${tiedLevels}가지뿐이라 동점이 많습니다. 동점 안의 순서는 평가 자료에 기록된 순위를 그대로 따랐습니다. ` +
      `무작위 선택 기대값은 이 폴드의 사기 표시 비율(${gain.total}/${gain.n} = ${percent(gain.total / gain.n, 0)})에 검토 건수를 곱한 계산값입니다.`;
    const at40 = Math.min(40, gain.n);
    $('gainChart').setAttribute('aria-label',
      `평가 폴드 1개 ${gain.n}건의 누적 그래프. 점수가 높은 ${at40}건을 검토하면 ` +
      SERIES.map(series => `${series.label} ${gain.gains[series.key][at40]}건`).join(', ') +
      `, ${BASELINE.label} ${nf(baselineAt(at40), 1)}건. 좌우 화살표 키로 검토 건수를 바꿀 수 있습니다.`);
    gain.k = at40;

    // 범위 C: 평가 15회 평균
    const budgets = [...new Set(EVAL.mean_budgets.map(row => row.k))].sort((a, b) => a - b);
    const meanAt = (key, k) => EVAL.mean_budgets.find(row => row.model === key && row.k === k);
    const headline = budgets.includes(40) ? 40 : budgets[budgets.length - 1];
    $('budgetLead').textContent = `시험 ${nf(EVAL.n, 0)}건 가운데 점수가 높은 ${headline}건(상위 ${percent(headline / EVAL.n, 0)})을 골랐을 때 그 안에 포함된 사기 표시 건수입니다. 평가 ${runs}회의 평균입니다.`;
    setChildren($('evaluationBars'),
      SERIES.map(series => evalBar(series.label, meanAt(series.key, headline).found, headline, series.color)),
      evalBar(BASELINE.label, headline * baseRate, headline, BASELINE.color));
    setChildren($('budgetTableHead'), seriesHead('고른 건수'));
    setChildren($('budgetTable'), ...budgets.map(k => el('tr', null,
      el('td', { text: `상위 ${k}건` }),
      SERIES.map(series => {
        const row = meanAt(series.key, k);
        return el('td', { class: 'num' }, `${row.found.toFixed(2)}건`, el('span', { class: 'sub', text: `${percent(row.precision)}가 사기 표시` }));
      }),
      el('td', { class: 'num' }, `${(k * baseRate).toFixed(2)}건`, el('span', { class: 'sub', text: `${percent(baseRate)}가 사기 표시` })))));
    const a = meanAt('Logistic', headline).found, b = meanAt('Severity', headline).found;
    $('budgetInsight').textContent =
      `${headline}건 기준으로 ${SERIES[0].label}은 평균 ${a.toFixed(2)}건, ${SERIES[1].label}은 평균 ${b.toFixed(2)}건입니다. ` +
      (Math.abs(a - b) < 1
        ? '두 모델이 거의 비슷했습니다. 현재 결과로 복잡한 모델의 우월성을 주장하기는 어렵습니다.'
        : '두 모델의 차이를 해석할 때는 평가 횟수와 자료 규모를 함께 고려해야 합니다.') +
      ` 무작위 선택 기대값은 전체 사기 표시 비율(${percent(baseRate)})에 건수를 곱한 계산값입니다.`;

    // 범위 B: 교차검증 첫 반복
    setChildren($('evaluationThresholds'), ...firstRepeat.map(row => {
      const points = Math.round(row.threshold * 100), offered = THRESHOLDS.includes(points);
      return el('tr', { class: offered ? null : 'reference' },
        el('td', { text: `${points}점 이상` + (offered ? '' : ' (참고)') }),
        el('td', { class: 'num', text: `${nf(row.selected, 0)}건` }),
        el('td', { class: 'num', text: `${nf(row.tp, 0)}건` }),
        el('td', { class: 'num', text: `${nf(row.fp, 0)}건` }),
        el('td', { class: 'num', text: `${nf(row.fn, 0)}건` }),
        el('td', { class: 'num', text: percent(row.precision) }),
        el('td', { class: 'num', text: percent(row.recall) }));
    }));
    const low = firstRepeat.find(row => Math.round(row.threshold * 100) === THRESHOLDS[0]);
    const high = firstRepeat.find(row => Math.round(row.threshold * 100) === THRESHOLDS[1]);
    $('thresholdInsight').textContent = low && high
      ? `기준을 ${THRESHOLDS[1]}점에서 ${THRESHOLDS[0]}점으로 낮추면 확인 대상이 ${nf(high.selected, 0)}건에서 ${nf(low.selected, 0)}건으로 ${nf(low.selected - high.selected, 0)}건 늘고, ` +
        `그 안의 사기 표시는 ${nf(high.tp, 0)}건에서 ${nf(low.tp, 0)}건으로 ${nf(low.tp - high.tp, 0)}건 늘어납니다. ` +
        `늘어난 확인 대상 가운데 ${nf(low.fp - high.fp, 0)}건은 사기 표시가 아닌 청구입니다. 직원 수와 조사 시간은 별도로 고려해야 합니다.`
      : '';
  }

  /* ================= 예시 · 화면 전환 ================= */
  function buildCases() {
    setChildren($('caseList'), PAYLOAD.cases.map(sample => {
      const check = state.selfCheck.rows.find(row => row.id === sample.id);
      return el('button', { type: 'button', class: 'case-button', 'aria-pressed': 'false', 'data-case': sample.id, onclick: () => loadCase(sample.id) },
        el('span', { class: 'case-top' },
          el('span', { class: 'case-id', text: sample.id }),
          el('span', { class: 'case-score' }, check && check.score !== null ? scoreText(check.score) : '—', el('small', { text: '점' }))),
        el('strong', { text: sample.title }),
        el('span', { class: 'case-sub', text: '예시 원래 값 기준' }));
    }));
  }
  function renderCases() {
    for (const button of document.querySelectorAll('.case-button')) {
      const selected = state.caseKind === 'sample' && state.caseId === button.dataset.case;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
    $('newManual').setAttribute('aria-pressed', state.caseKind === 'manual' ? 'true' : 'false');
  }
  function resetCaseState() {
    state.current = null;
    state.previous = null;
    state.blocked = false;
    for (const name of Object.keys(state.errors)) clearFieldError(name);
    state.generalError = '';
    clearDraft();
  }
  /* 예시를 불러와 바로 분석한다. */
  function loadCase(id) {
    const sample = PAYLOAD.cases.find(c => c.id === id);
    if (!sample) return;
    state.caseId = id;
    state.caseKind = 'sample';
    resetCaseState();
    writeInputs(sample.inputs);
    renderCases();
    renderCaseContext();
    if (!runAnalysis()) renderHistory();
  }
  /* 빈 양식으로 새 청구를 직접 입력한다. 분석하기 전에는 결과가 없다. */
  function loadManual() {
    state.manualCount += 1;
    state.caseId = 'USER-' + String(state.manualCount).padStart(3, '0');
    state.caseKind = 'manual';
    resetCaseState();
    writeInputs(null);
    for (const group of PAYLOAD.groups) $('group-' + group.id).open = true;
    state.phase = 'empty';
    updateInputCount();
    renderCaseContext();
    renderCases();
    renderHistory();
    renderPhase();
  }
  /* 표가 영역보다 넓으면 표 안에서 가로로 밀어 본다. 그럴 때만 안내 문구를 보이고 키보드 초점을 받을 수 있게 한다. */
  function markScrollableTables() {
    for (const box of document.querySelectorAll('.table-scroll')) {
      let hint = box.nextElementSibling;
      if (!hint || !hint.classList.contains('scroll-hint')) {
        hint = el('p', { class: 'hint scroll-hint', hidden: true, text: '표가 화면보다 넓습니다. 표를 옆으로 밀면 나머지 열을 볼 수 있습니다.' });
        box.after(hint);
      }
      const scrollable = box.clientWidth > 0 && box.scrollWidth > box.clientWidth + 1;
      hint.hidden = !scrollable;
      if (scrollable) { box.setAttribute('tabindex', '0'); box.setAttribute('role', 'region'); box.setAttribute('aria-label', '가로로 밀어 볼 수 있는 표'); }
      else { box.removeAttribute('tabindex'); box.removeAttribute('role'); box.removeAttribute('aria-label'); }
    }
  }
  function switchView(view) {
    if (!VIEW_LABEL[view]) return;
    state.view = view;
    for (const id of Object.keys(VIEW_LABEL)) $(id + 'View').hidden = id !== view;
    for (const button of document.querySelectorAll('.nav')) {
      const active = button.dataset.view === view;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    $('viewName').textContent = VIEW_LABEL[view];
    document.title = `${VIEW_LABEL[view]} | 보험 청구 심사 지원 대시보드`;
    setMessage('handoffMessage', '', '');
    renderHandoff();
    if (view === 'evaluation') drawGainChart();
    markScrollableTables();
    window.scrollTo(0, 0);
  }

  /* ================= 시작 ================= */
  function bindEvents() {
    $('claimForm').addEventListener('submit', event => { event.preventDefault(); runAnalysis({ reveal: true }); });
    $('claimForm').addEventListener('input', onFormInput);
    $('resetCase').addEventListener('click', () => (state.caseKind === 'sample' ? loadCase(state.caseId) : loadManual()));
    $('newManual').addEventListener('click', () => { loadManual(); $('field-' + FIELD_NAMES[0]).focus(); });
    $('expandAll').addEventListener('click', () => { for (const group of PAYLOAD.groups) $('group-' + group.id).open = true; });
    $('collapseAll').addEventListener('click', () => { for (const group of PAYLOAD.groups) $('group-' + group.id).open = false; });
    $('toggleKeys').addEventListener('change', event => document.body.classList.toggle('show-keys', event.target.checked));
    for (const radio of document.querySelectorAll('input[name="threshold"]')) {
      radio.addEventListener('change', () => {   // 기준이 바뀌면 검토 구분만 다시 그린다. 점수와 영향 요인은 손대지 않는다
        renderRecommendation();
        renderHandoff();
        if (state.current) setReviewMessage(`검토 기준을 ${currentThreshold()}점으로 바꿨습니다. 모델 점수는 그대로이고, 기록에는 저장 시점의 기준이 남습니다.`, '');
      });
    }
    $('reviewNote').addEventListener('input', updateNoteCount);
    $('saveReview').addEventListener('click', saveReview);
    $('exportResult').addEventListener('click', downloadResult);
    $('exportFromHandoff').addEventListener('click', downloadResult);
    for (const button of document.querySelectorAll('.nav')) button.addEventListener('click', () => switchView(button.dataset.view));
    const help = $('helpDialog');   // <dialog>를 지원하지 않는 오래된 브라우저에서는 그냥 펼쳐 보인다
    $('helpButton').addEventListener('click', () => (typeof help.showModal === 'function' ? help.showModal() : help.setAttribute('open', '')));
    $('closeHelp').addEventListener('click', () => (typeof help.close === 'function' ? help.close() : help.removeAttribute('open')));
    help.addEventListener('click', event => {   // 도움말 바깥(어두운 영역)을 누르면 닫는다
      if (event.target !== help || typeof help.close !== 'function') return;
      const box = help.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) help.close();
    });
    $('allDetails').addEventListener('toggle', markScrollableTables);
    bindGainChart();
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.view === 'evaluation') { hideGainTip(); drawGainChart(); }
        markScrollableTables();
      }, 120);
    });
  }
  function init() {
    runSelfCheck();
    buildCases();
    buildFields();
    buildEvaluation();
    buildHandoffStatic();
    bindEvents();
    updateNoteCount();
    loadCase(PAYLOAD.cases[0].id);
    markScrollableTables();
  }

  /* 개발자 도구와 검증 스크립트에서 상태를 확인할 수 있도록 일부만 내보낸다. */
  window.ClaimDashboard = { state, THRESHOLDS, readInputs, runAnalysis, makeExport, saveReview, loadCase, loadManual, switchView, currentThreshold, scoreText };

  init();
})();
