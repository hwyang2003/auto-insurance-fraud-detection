/* 화면 동작 검사 — 브라우저 안에서 실행된다.
 *
 * run_browser_checks.mjs가 이 파일을 독립 실행 HTML에 주입한 뒤 window.__runUiChecks(options)를 호출한다.
 * 실제 화면의 입력 요소와 버튼을 조작하고, 화면에 보이는 내용과 내부 상태를 함께 확인한다.
 * options: { sampleResult: data/sample_result.json 내용, expectLayout: 'side-by-side' | 'stacked' }
 */
window.__runUiChecks = function (options) {
  'use strict';
  const D = window.ClaimDashboard, P = PAYLOAD, $ = id => document.getElementById(id);
  const TOL = 1e-8, results = [];

  /* ---------- 도구 ---------- */
  const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));
  const setField = (name, value) => { const node = $('field-' + name); node.value = value; fire(node, 'input'); fire(node, 'change'); };
  const analyze = () => $('analyzeButton').click();
  const loadCase = id => document.querySelector(`.case-button[data-case="${id}"]`).click();
  const goto = view => document.querySelector(`.nav[data-view="${view}"]`).click();
  const setThreshold = value => document.querySelector(`label[for="threshold-${value}"]`).click();
  /* 실제로 그려지는지 확인한다. 접힌 <details> 안의 내용(content-visibility: hidden)도 보이지 않는 것으로 본다. */
  const shown = node => !!node && node.getClientRects().length > 0 && (typeof node.checkVisibility !== 'function' || node.checkVisibility());
  const text = id => $(id).textContent.replace(/\s+/g, ' ').trim();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sampleOf = id => P.cases.find(c => c.id === id);
  const state = () => D.state;
  const snapshot = () => ({ score: text('scoreValue'), up: text('positiveDrivers'), down: text('negativeDrivers'), all: text('allContributions'), calc: text('calculationSummary'), processing: text('processingList'), fill: $('meterFill').style.width });
  const check = (id, title, fn) => {
    let outcome;
    try { outcome = fn(); } catch (error) { outcome = { pass: false, detail: 'exception: ' + (error && error.message) }; }
    results.push({ id, title, pass: !!outcome && outcome.pass === true, detail: outcome ? outcome.detail : null });
  };
  const all = facts => Object.values(facts).every(value => value === true);

  /* 저장 버튼이 만드는 JSON을 가로채 내용만 확인한다(이 검사 중에는 실제 파일을 내려받지 않는다). */
  const RealBlob = window.Blob, realAnchorClick = HTMLAnchorElement.prototype.click;
  let captured = null, downloadName = null;
  window.Blob = function (parts, opts) { if (opts && opts.type === 'application/json') captured = parts.join(''); return new RealBlob(parts, opts); };
  HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute('download')) { downloadName = this.getAttribute('download'); return undefined; } return realAnchorClick.call(this); };

  try {
    /* ---------- 요청받은 확인 사항 ---------- */
    check('U1', '예시 5건: 화면에서 계산한 점수가 expected_score와 1e-8 이내로 일치', () => {
      const rows = P.cases.map(c => {
        loadCase(c.id);
        const score = state().current.score;
        return { id: c.id, score, expected: c.expected_score, abs_diff: Math.abs(score - c.expected_score), phase: state().phase, shown: text('scoreValue'), export_score: D.makeExport().prediction.score };
      });
      return { pass: rows.length === 5 && rows.every(r => r.abs_diff <= TOL && r.phase === 'fresh' && r.export_score === r.score && r.shown === r.score.toFixed(1)), detail: rows };
    });

    check('U2', 'DEMO-001 기본 점수 약 57.898465222점, 기본 검토 기준 10점', () => {
      loadCase('DEMO-001');
      const facts = {
        score: Math.abs(state().current.score - 57.898465222) < 5e-10,
        shown: text('scoreValue') === '57.9',
        default_threshold_10: $('threshold-10').checked && D.currentThreshold() === 10,
        pill: text('recommendation') === '추가 확인 권고',
        result_visible: shown($('scoreValue'))
      };
      return { pass: all(facts), detail: { ...facts, score: state().current.score } };
    });

    check('U3', 'DEMO-001의 피해 정도만 경미한 손상으로 바꿔 재분석하면 약 9.059383729점', () => {
      loadCase('DEMO-001');
      const before = snapshot(), idBefore = state().current.prediction_id;
      setField('incident_severity', 'Minor Damage');
      const stale = { phase: state().phase === 'stale', banner: shown($('phaseBanner')), dimmed: $('resultRegion').classList.contains('is-stale'), tag: shown($('staleTag')), old_score_still_labelled_previous: text('scoreValue') === '57.9', context_notes_change: text('caseContext').includes('1개 항목 수정됨') };
      analyze();
      const after = snapshot();
      const facts = {
        stale_state_shown_before_reanalysis: all(stale),
        score: Math.abs(state().current.score - 9.059383729) < 5e-10,
        shown: after.score === '9.1',
        phase_fresh: state().phase === 'fresh',
        new_prediction_id: state().current.prediction_id !== idBefore,
        drivers_updated: after.up !== before.up && after.all !== before.all && after.fill !== before.fill,
        change_summary: shown($('changeSummary')) && text('changeSummary').includes('피해 정도') && text('changeSummary').includes('큰 손상 → 경미한 손상'),
        pill: text('recommendation') === '일반 검토'
      };
      return { pass: all(facts), detail: { ...facts, stale, score: state().current.score, change_summary: text('changeSummary') } };
    });

    check('U4', 'DEMO-003은 약 11.758962783점이고, 기준을 10점→20점으로 바꾸면 검토 구분만 바뀜', () => {
      loadCase('DEMO-003');
      setThreshold(10);
      const before = snapshot(), id = state().current.prediction_id, score = state().current.score, pill10 = text('recommendation');
      setThreshold(20);
      const after = snapshot(), pill20 = text('recommendation'), exported = D.makeExport();
      const facts = {
        score: Math.abs(score - 11.758962783) < 5e-10,
        shown: before.score === '11.8',
        pill_at_10: pill10 === '추가 확인 권고',
        pill_at_20: pill20 === '일반 검토',
        score_and_factors_unchanged: same(before, after) && state().current.score === score && state().current.prediction_id === id,
        marker_moved: $('meterThreshold').style.left === '20%' && text('meterThresholdLabel') === '기준 20점',
        sentence_mentions_20: text('resultSentence').includes('20점'),
        export_policy: exported.review_policy.threshold === 20 && exported.review_policy.recommendation === 'standard_review' && exported.prediction.score === score
      };
      setThreshold(10);
      facts.back_to_10 = text('recommendation') === '추가 확인 권고' && $('meterThreshold').style.left === '10%' && same(before, snapshot());
      return { pass: all(facts), detail: { ...facts, score } };
    });

    check('U5', '필수 입력을 비우면 필드별 오류가 나오고 분석이 차단됨 (필수 12개 각각)', () => {
      const rows = P.fields.filter(f => f.required).map(field => {
        loadCase('DEMO-001');
        const idBefore = state().current.prediction_id;
        setField(field.name, '');
        analyze();
        const error = $('error-' + field.name);
        return {
          field: field.name, phase: state().phase,
          error_shown: shown(error) && error.textContent.includes('입력해 주세요'),
          marked_invalid: $('field-' + field.name).getAttribute('aria-invalid') === 'true',
          summary_shown: shown($('inputErrors')) && text('inputErrors').includes('1개'),
          no_new_result: state().current.prediction_id === idBefore,
          result_hidden: !shown($('resultRegion')) && shown($('resultPlaceholder')),
          buttons_disabled: $('saveReview').disabled && $('exportResult').disabled
        };
      });
      return { pass: rows.length === 12 && rows.every(r => r.phase === 'blocked' && r.error_shown && r.marked_invalid && r.summary_shown && r.no_new_result && r.result_hidden && r.buttons_disabled), detail: rows };
    });

    check('U6', '입력 수정 후 재분석 전에는 검토 기록 저장과 결과 내보내기가 차단됨', () => {
      loadCase('DEMO-001');
      const recordsBefore = state().records.length;
      setField('witnesses', '3');
      const facts = {
        phase_stale: state().phase === 'stale',
        save_disabled: $('saveReview').disabled,
        export_disabled: $('exportResult').disabled && $('exportFromHandoff').disabled,
        lock_note: shown($('reviewLock')) && text('reviewLock').includes('다시 분석'),
        banner: shown($('phaseBanner')) && text('phaseBanner').includes('이전 입력')
      };
      // 버튼을 거치지 않고 직접 불러도 막히는지 확인
      $('review-basic').checked = true;
      $('reviewNote').value = '재분석 전 저장 시도';
      facts.direct_save_refused = D.saveReview() === false && state().records.length === recordsBefore;
      let threw = false;
      try { D.makeExport(); } catch (error) { threw = true; }
      facts.direct_export_refused = threw;
      captured = null;
      $('exportResult').click();
      $('saveReview').click();
      facts.clicks_do_nothing = captured === null && state().records.length === recordsBefore;
      // 원래 값으로 되돌리면 표시 중인 결과가 다시 현재 입력의 결과가 된다
      setField('witnesses', '2');
      facts.revert_restores_fresh = state().phase === 'fresh' && !$('saveReview').disabled && !shown($('phaseBanner'));
      // 다시 바꾸고 재분석하면 풀린다
      setField('witnesses', '3');
      analyze();
      facts.reanalysis_unlocks = state().phase === 'fresh' && !$('saveReview').disabled && !$('exportResult').disabled && state().current.inputs.witnesses === 3;
      return { pass: all(facts), detail: facts };
    });

    check('U7', '메모를 기록해도 모델 점수는 그대로이고, JSON에 당시 입력과 결과가 저장됨', () => {
      loadCase('DEMO-002');
      const before = snapshot(), score = state().current.score, id = state().current.prediction_id, recordsBefore = state().records.length;
      const facts = {};
      // 판단이나 메모가 없으면 기록하지 않는다
      $('saveReview').click();
      facts.requires_judgement = state().records.length === recordsBefore && text('reviewMessage').includes('판단을 선택');
      document.querySelector('label[for="review-additional"]').click();
      $('saveReview').click();
      facts.requires_memo = state().records.length === recordsBefore && text('reviewMessage').includes('메모');
      const memo = '서류 확인 예정 <img src=x onerror="window.__xss=1"> <b>굵게</b> <script>window.__xss=2<\/script> & "따옴표"';
      $('reviewNote').value = memo;
      fire($('reviewNote'), 'input');
      $('saveReview').click();
      const record = state().records[state().records.length - 1], history = $('reviewHistory');
      facts.record_added = state().records.length === recordsBefore + 1 && record.memo === memo && record.review_status === 'additional_review';
      facts.record_keeps_inputs_and_result = same(record.inputs_at_review, state().current.inputs) && record.model_score_at_review === score && record.prediction_id === id
        && record.threshold_at_review === 10 && record.model_recommendation_at_review === 'additional_review';
      facts.score_unchanged = state().current.score === score && state().current.prediction_id === id && same(before, snapshot());
      facts.memo_shown_as_text = history.querySelector('img, b, script') === null && history.textContent.includes(memo) && window.__xss === undefined;
      facts.history_count = text('historyCount') === '1' && $('historyDetails').open;
      facts.draft_cleared = $('reviewNote').value === '' && document.querySelector('input[name="reviewStatus"]:checked') === null;
      captured = null; downloadName = null;
      $('exportResult').click();
      const exported = captured ? JSON.parse(captured) : null;
      facts.export_created = !!exported && downloadName === `DEMO-002_${id}_result.json`;
      if (exported) {
        facts.export_inputs_and_result = same(exported.inputs, state().current.inputs) && exported.prediction.score === score && exported.prediction_id === id && exported.explanation.contributions.length === 24;
        facts.export_has_record = exported.review_records.length === 1 && exported.review_records[0].memo === memo && same(exported.review_records[0].inputs_at_review, state().current.inputs)
          && exported.review_records[0].model_score_at_review === score;
        facts.export_keeps_missing_as_null = exported.inputs.collision_type === null && exported.input_processing.length === 3;
      }
      return { pass: all(facts), detail: { ...facts, score, download_name: downloadName } };
    });

    check('U8', '세 화면 이동과 예시 전환이 정상 동작', () => {
      const views = ['evaluation', 'handoff', 'analysis'].map(view => {
        goto(view);
        return {
          view,
          only_this_visible: ['analysis', 'evaluation', 'handoff'].every(v => shown($(v + 'View')) === (v === view)),
          nav_current: document.querySelector('.nav[aria-current="page"]').dataset.view === view,
          breadcrumb: text('viewName') === { analysis: '청구 분석', evaluation: '모델 평가', handoff: '연결 데이터' }[view],
          heading: shown($(view + 'Heading'))
        };
      });
      const cases = P.cases.map(c => {
        loadCase(c.id);
        const inputs = D.readInputs();
        return {
          id: c.id,
          inputs_loaded: P.model.cols.every(name => inputs[name] === c.inputs[name]),
          selected: document.querySelector('.case-button.selected').dataset.case === c.id && document.querySelectorAll('.case-button.selected').length === 1,
          analysed: state().phase === 'fresh' && state().current.case_id === c.id && Math.abs(state().current.score - c.expected_score) <= TOL,
          context: text('caseContext').startsWith(c.id)
        };
      });
      return { pass: views.every(v => v.only_this_visible && v.nav_current && v.breadcrumb && v.heading) && cases.every(c => c.inputs_loaded && c.selected && c.analysed && c.context), detail: { views, cases } };
    });

    /* ---------- 화면 폭 ---------- */
    check('U9', '현재 화면 폭에서 가로 스크롤이 생기지 않고 배치가 기대와 같음', () => {
      const measure = label => {
        const root = document.documentElement, width = window.innerWidth;
        const offenders = [...document.querySelectorAll('main *, .sidebar *')].filter(node => {
          if (!shown(node) || node.closest('.table-scroll, pre, .chart-tooltip, svg')) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && (rect.right > width + 1 || rect.left < -1);
        }).slice(0, 5).map(node => `${node.tagName.toLowerCase()}#${node.id || ''}.${String(node.className && node.className.baseVal !== undefined ? node.className.baseVal : node.className).split(' ')[0]}`);
        // 표의 열이 글자 한두 자 폭으로 찌그러지지 않았는지도 본다(넓은 표는 표 안에서 가로로 밀어야 한다)
        const crushed = [...document.querySelectorAll('main td, main th')].filter(cell => shown(cell) && cell.textContent.trim().length >= 4 && cell.getBoundingClientRect().width < 44).length;
        const hints = [...document.querySelectorAll('.scroll-hint')].filter(shown).length;
        return { state: label, scroll_width: root.scrollWidth, inner_width: width, ok: root.scrollWidth <= width && offenders.length === 0 && crushed === 0, offenders, crushed_table_cells: crushed, table_scroll_hints: hints };
      };
      const rows = [];
      goto('analysis');
      loadCase('DEMO-002');
      $('expandAll').click();
      $('allDetails').open = true;
      const input = document.querySelector('.input-panel').getBoundingClientRect(), result = $('resultColumn').getBoundingClientRect();
      const layout = result.left >= input.right - 1 ? 'side-by-side' : (result.top >= input.bottom - 1 ? 'stacked' : 'overlap');
      rows.push(measure('청구 분석 · 최신 결과 · 모두 펼침'));
      setField('injury_claim', '99999');
      rows.push(measure('청구 분석 · 재분석 필요'));
      setField('injury_claim', '');
      setField('incident_severity', '');
      analyze();
      rows.push(measure('청구 분석 · 분석 차단'));
      $('newManual').click();
      rows.push(measure('청구 분석 · 빈 양식'));
      loadCase('DEMO-001');
      goto('evaluation');
      rows.push(measure('모델 평가'));
      goto('handoff');
      rows.push(measure('연결 데이터'));
      goto('analysis');
      $('allDetails').open = false;
      for (const group of P.groups) $('group-' + group.id).open = !!group.open;
      const wideTablesExplained = options.expectLayout !== 'stacked' || rows.find(r => r.state === '연결 데이터').table_scroll_hints > 0;
      return { pass: rows.every(r => r.ok) && wideTablesExplained && (!options.expectLayout || layout === options.expectLayout), detail: { layout, expected_layout: options.expectLayout || null, wide_tables_explained: wideTablesExplained, rows } };
    });

    /* ---------- 유지해야 할 동작 ---------- */
    check('U10', '숫자 0, 미상(빈칸), 문자열 "None"을 화면에서도 구분', () => {
      const facts = {};
      loadCase('DEMO-001');
      setField('witnesses', '0');
      analyze();
      const zeroScore = state().current.score;
      facts.zero_is_value = state().current.inputs.witnesses === 0 && !text('processingList').includes('목격자 수') && text('missingCount') === '미상 처리 없음';
      setField('witnesses', '');
      analyze();
      facts.blank_is_unknown = state().current.inputs.witnesses === null && text('processingList').includes('목격자 수') && text('processingList').includes('중앙값') && text('missingCount') === '미상 처리 1건';
      facts.zero_and_blank_differ = state().current.score !== zeroScore;
      setField('authorities_contacted', 'None');
      analyze();
      facts.none_is_category = state().current.inputs.authorities_contacted === 'None' && !text('processingList').includes('연락한 기관') && text('allContributions').includes('연락한 기관 없음');
      setField('collision_type', '__MISSING__');
      analyze();
      facts.unknown_category = state().current.inputs.collision_type === null && text('processingList').includes('충돌 방향') && text('processingList').includes('미상 범주');
      facts.umbrella_zero_kept = state().current.inputs.umbrella_limit === 0;
      captured = null;
      $('exportResult').click();
      facts.export_distinguishes = !!captured && captured.includes('"witnesses": null') && captured.includes('"authorities_contacted": "None"') && captured.includes('"umbrella_limit": 0');
      return { pass: all(facts), detail: facts };
    });

    check('U11', '잘못된 범위·정수 위반은 차단하고, 학습 범위 밖의 값은 경고와 함께 계산', () => {
      const blocked = [['incident_hour_of_the_day', '24', '허용 범위'], ['witnesses', '1.5', '정수'], ['vehicle_claim', '-1', '허용 범위'], ['capital-loss', '5', '허용 범위'], ['number_of_vehicles_involved', '0', '허용 범위']].map(([name, value, expected]) => {
        loadCase('DEMO-001');
        setField(name, value);
        analyze();
        return { field: name, value, ok: state().phase === 'blocked' && shown($('error-' + name)) && $('error-' + name).textContent.includes(expected) && !shown($('resultRegion')) };
      });
      loadCase('DEMO-001');
      setField('number_of_vehicles_involved', '9');
      analyze();
      const warning = { phase: state().phase, text: text('rangeWarnings'), chip: text('warningCount') };
      const warned = warning.phase === 'fresh' && warning.text.includes('학습 자료에서 본 범위 밖') && warning.text.includes('학습 자료 범위: 1~4') && warning.chip === '경고 1건';
      return { pass: blocked.every(r => r.ok) && warned, detail: { blocked, warning } };
    });

    check('U12', '분석에 실패하면 이전 결과를 정상 결과처럼 보여 주지 않음', () => {
      loadCase('DEMO-001');
      const idBefore = state().current.prediction_id, facts = {};
      setField('vehicle_claim', '-5');
      analyze();
      facts.blocked = state().phase === 'blocked' && state().current.prediction_id === idBefore;
      facts.previous_score_not_visible = !shown($('scoreValue')) && !shown($('recommendation')) && !shown($('positiveDrivers')) && !text('formStatus').includes('57.9');
      facts.placeholder = shown($('resultPlaceholder')) && text('placeholderTitle') === '분석이 차단되었습니다';
      facts.banner = shown($('phaseBanner')) && $('phaseBanner').classList.contains('danger') && text('phaseBanner').includes('숨겼습니다');
      facts.export_blocked = $('exportResult').disabled && $('saveReview').disabled;
      // 다른 유효한 값으로 고치기만 하고 아직 분석하지 않은 상태: 여전히 결과를 보여 주지 않는다
      setField('vehicle_claim', '60000');
      facts.still_hidden_until_reanalysis = state().phase === 'blocked' && !shown($('scoreValue')) && !shown($('error-vehicle_claim')) && $('exportResult').disabled;
      analyze();
      facts.reanalysis_shows_new_result = state().phase === 'fresh' && shown($('scoreValue')) && state().current.prediction_id !== idBefore && state().current.inputs.vehicle_claim === 60000;
      // 실패 후 분석했던 값으로 되돌아오면 그 결과를 다시 보여 준다
      const idNow = state().current.prediction_id;
      setField('vehicle_claim', '-5');
      analyze();
      setField('vehicle_claim', '60000');
      facts.revert_after_failure = state().phase === 'fresh' && shown($('scoreValue')) && state().current.prediction_id === idNow && !shown($('inputErrors'));
      return { pass: all(facts), detail: facts };
    });

    check('U13', '빈 양식 직접 입력: 분석 전에는 결과가 없고, 필수 12개를 채워야 분석됨', () => {
      const facts = {};
      $('newManual').click();
      facts.empty_state = state().phase === 'empty' && state().caseKind === 'manual' && state().current === null && !shown($('resultRegion')) && shown($('resultPlaceholder')) && $('saveReview').disabled && $('exportResult').disabled;
      facts.context = text('caseContext').includes('USER-') && text('analyzeButton') === '분석하기' && document.querySelectorAll('.case-button.selected').length === 0;
      const blank = D.readInputs();
      facts.all_blank = P.model.cols.every(name => blank[name] === null);
      analyze();
      const errors = [...document.querySelectorAll('.field-error')].filter(shown).length;
      facts.blocked_with_12_errors = state().phase === 'blocked' && errors === 12 && state().current === null && text('inputErrors').includes('12개');
      const source = sampleOf('DEMO-004');
      for (const field of P.fields) {
        const value = source.inputs[field.name];
        setField(field.name, value === null ? (field.type === 'category' ? '__MISSING__' : '') : String(value));
      }
      facts.errors_cleared_while_fixing = [...document.querySelectorAll('.field-error')].filter(shown).length === 0;
      analyze();
      const exported = state().phase === 'fresh' ? D.makeExport() : null;
      facts.analysed = state().phase === 'fresh' && Math.abs(state().current.score - source.expected_score) <= TOL;
      facts.export_marks_manual_entry = !!exported && exported.case_id === state().caseId && exported.source_row === null && exported.context.input_source === 'manual_entry' && exported.context.sample_was_in_training_data === null;
      const manualId = state().caseId;
      $('resetCase').click();
      facts.reset_clears_form = state().phase === 'empty' && state().caseId !== manualId && P.model.cols.every(name => D.readInputs()[name] === null);
      return { pass: all(facts), detail: { ...facts, shown_errors_after_blank_submit: errors } };
    });

    check('U14', '초기화: 예시의 원래 값으로 되돌리고 다시 분석', () => {
      loadCase('DEMO-005');
      setField('incident_severity', 'Minor Damage');
      setField('vehicle_claim', '100');
      analyze();
      const changed = state().current.score;
      $('resetCase').click();
      const inputs = D.readInputs(), source = sampleOf('DEMO-005');
      const facts = {
        changed_first: Math.abs(changed - source.expected_score) > 1e-6,
        inputs_restored: P.model.cols.every(name => inputs[name] === source.inputs[name]),
        score_restored: state().phase === 'fresh' && Math.abs(state().current.score - source.expected_score) <= TOL,
        no_stale_summary: !shown($('changeSummary')) && !shown($('phaseBanner'))
      };
      return { pass: all(facts), detail: facts };
    });

    check('U15', '저장 JSON 구조가 data/sample_result.json과 호환 (기존 키 유지, 값 일치)', () => {
      const saved = options.sampleResult;
      if (!saved) return { pass: false, detail: 'sampleResult가 전달되지 않음' };
      loadCase(saved.case_id);
      setThreshold(saved.review_policy.threshold);
      const made = D.makeExport(), close = (a, b) => Math.abs(a - b) < 1e-12;
      const facts = {
        top_level_keys_kept: Object.keys(saved).every(key => key in made),
        identity: made.schema_version === saved.schema_version && made.purpose === saved.purpose && made.case_id === saved.case_id && made.source_row === saved.source_row,
        inputs: same(made.inputs, saved.inputs),
        prediction: made.prediction.model_version === saved.prediction.model_version && close(made.prediction.score, saved.prediction.score) && close(made.prediction.probability, saved.prediction.probability) && made.prediction.score_scale === saved.prediction.score_scale,
        review_policy: same(made.review_policy, saved.review_policy),
        explanation: made.explanation.method === saved.explanation.method && made.explanation.unit === 'log_odds' && close(made.explanation.base, saved.explanation.base) && close(made.explanation.log_odds, saved.explanation.log_odds)
          && made.explanation.contributions.length === saved.explanation.contributions.length
          && made.explanation.contributions.every((c, i) => c.field === saved.explanation.contributions[i].field && c.used_value === saved.explanation.contributions[i].used_value && close(c.contribution, saved.explanation.contributions[i].contribution)),
        processing_and_warnings: same(made.input_processing, saved.input_processing) && same(made.warnings, saved.warnings) && Array.isArray(made.review_records),
        context_keys_kept: Object.keys(saved.context).every(key => key in made.context && same(made.context[key], saved.context[key]))
      };
      return { pass: all(facts), detail: { ...facts, added_context_keys: Object.keys(made.context).filter(key => !(key in saved.context)) } };
    });

    check('U16', '검토 기록은 탭 메모리에만 두고, 새로고침 시 사라진다고 안내', () => {
      let stored = 0;
      try { stored = window.localStorage.length + window.sessionStorage.length; } catch (error) { stored = 0; }
      const hint = document.querySelector('.review-panel').textContent;
      const facts = { notice: hint.includes('메모리에만') && hint.includes('새로고침'), nothing_in_browser_storage: stored === 0, records_in_memory: Array.isArray(state().records) };
      return { pass: all(facts), detail: facts };
    });

    check('U17', '도움말, 개발용 필드명 표시, 모두 펼치기·접기', () => {
      const facts = {};
      $('helpButton').click();
      facts.help_opens = $('helpDialog').open === true;
      $('closeHelp').click();
      facts.help_closes = $('helpDialog').open === false;
      loadCase('DEMO-001');
      $('expandAll').click();
      facts.expand_all = P.groups.every(group => $('group-' + group.id).open);
      const key = document.querySelector('#fieldGroups .field-key');
      facts.keys_hidden_by_default = !shown(key);
      $('toggleKeys').click();
      facts.keys_shown_on_toggle = shown(key) && key.textContent === P.fields[0].name;
      $('toggleKeys').click();
      facts.keys_hidden_again = !shown(key);
      $('collapseAll').click();
      facts.collapse_all = P.groups.every(group => !$('group-' + group.id).open);
      for (const group of P.groups) $('group-' + group.id).open = !!group.open;
      facts.detail_closed_by_default = !$('allDetails').open && !shown($('allContributions'));
      return { pass: all(facts), detail: facts };
    });

    check('U18', '모델 평가 화면: 세 범위를 구분해 표시하고, 수치가 평가 자료와 일치', () => {
      goto('evaluation');
      const ev = P.evaluation, rows = ev.rows, facts = {};
      const top = (key, k) => [...rows].sort((a, b) => a.ranks[key] - b.ranks[key]).slice(0, k).reduce((sum, r) => sum + r.label, 0);
      facts.scope_labels = text('scopeFold').includes('범위 A') && text('scopeFold').includes('200건') && text('scopeRepeat').includes('범위 B') && text('scopeRepeat').includes('1,000건') && text('scopeMean').includes('범위 C') && text('scopeMean').includes('15회');
      const gainRows = [...$('gainTable').rows];
      facts.fold_table = gainRows.length === 6 && [10, 20, 40, 60, 100, 200].every((k, i) => {
        const cells = [...gainRows[i].cells].map(cell => cell.textContent.trim());
        return cells[0].includes(`${k}건`) && cells[1] === `${top('Logistic', k)}건` && cells[2] === `${top('Severity', k)}건`;
      });
      const budgetRows = [...$('budgetTable').rows];
      facts.mean_table = budgetRows.length === 4 && budgetRows.every(row => {
        const k = Number(row.cells[0].textContent.replace(/\D/g, ''));
        const a = ev.mean_budgets.find(r => r.model === 'Logistic' && r.k === k), b = ev.mean_budgets.find(r => r.model === 'Severity' && r.k === k);
        return !!a && !!b && row.cells[1].textContent.includes(a.found.toFixed(2) + '건') && row.cells[2].textContent.includes(b.found.toFixed(2) + '건');
      });
      const thresholdRows = [...$('evaluationThresholds').rows];
      facts.threshold_table = thresholdRows.length === ev.threshold_first_repeat.length && thresholdRows.every((row, i) => {
        const r = ev.threshold_first_repeat[i], cells = [...row.cells].map(cell => cell.textContent.replace(/[,건]/g, '').trim());
        return cells[0].startsWith(String(Math.round(r.threshold * 100)) + '점') && Number(cells[1]) === r.selected && Number(cells[2]) === r.tp && Number(cells[3]) === r.fp && Number(cells[4]) === r.fn;
      });
      const lines = [...document.querySelectorAll('#gainChart svg polyline')];
      facts.chart_drawn = lines.length === 2 && lines.every(line => line.getAttribute('points').trim().split(/\s+/).length === rows.length + 1);
      const legend = [...document.querySelectorAll('#gainLegend > span')].map(node => node.textContent.trim());
      facts.legend = same(legend, ['24개 정보 모델', '손상 정도만 쓰는 모델', '무작위 선택 기대값']);
      const bars = [...document.querySelectorAll('#evaluationBars .eval-row')];
      const at40 = key => ev.mean_budgets.find(r => r.model === key && r.k === 40).found;
      facts.mean_bars = bars.length === 3 && bars[0].textContent.includes(at40('Logistic').toFixed(2) + '건') && bars[1].textContent.includes(at40('Severity').toFixed(2) + '건')
        && bars[2].textContent.includes((40 * P.metadata.fraud_labels / P.metadata.training_rows).toFixed(2) + '건')
        && bars.every(bar => parseFloat(bar.querySelector('.eval-track > div').style.width) > 0);
      facts.tiles = document.querySelectorAll('#evalMetrics .metric').length === 4 && text('evalMetrics').includes('원본 행은 이 패키지에 들어 있지 않습니다');
      facts.not_new_validation = $('evaluationView').textContent.includes('성능을 새로 검증한 것이 아닙니다');
      // 그래프의 값 읽기(키보드)
      $('gainChart').focus();
      const tipRows = [...document.querySelectorAll('#gainTooltip .tip-row')].map(node => node.textContent.trim());
      facts.tooltip = shown($('gainTooltip')) && text('gainTooltip').includes('40건') && tipRows.length === 3
        && tipRows[0].startsWith(`${top('Logistic', 40)}건`) && tipRows[1].startsWith(`${top('Severity', 40)}건`) && tipRows[2].startsWith('10건');
      $('gainChart').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
      facts.tooltip_keyboard = text('gainTooltip').includes('50건을 검토하면') && document.querySelector('#gainTooltip .tip-row').textContent.startsWith(`${top('Logistic', 50)}건`);
      $('gainChart').blur();
      facts.tooltip_hides = !shown($('gainTooltip'));
      goto('analysis');
      return { pass: all(facts), detail: { ...facts, fold_top40: { logistic: top('Logistic', 40), severity: top('Severity', 40) } } };
    });

    check('U19', '연결 데이터 화면: 미리보기가 저장 내용과 같고, 패키지 구성과 자체 점검을 표시', () => {
      loadCase('DEMO-001');
      goto('handoff');
      const facts = {};
      facts.preview_equals_export = same(JSON.parse($('outputJson').textContent), D.makeExport()) && same(JSON.parse($('inputJson').textContent), state().current.inputs);
      const checks = [...$('selfCheckTable').rows];
      facts.self_check = checks.length === 5 && checks.every(row => row.cells[4].textContent === '일치') && text('selfCheckStatus') === '5건 모두 일치' && !shown($('integrityAlert'));
      facts.package_scope = text('packageExcluded').includes('원본 학습 자료 1,000건 전체') && text('packageIncluded').includes('입력 예시 5건') && text('packageIncluded').includes('평가 폴드 1개의 200건');
      facts.schema_table = $('schemaTable').rows.length === 24;
      setField('witnesses', '0');
      facts.stale_blocks_preview = shown($('handoffState')) && $('exportFromHandoff').disabled && !$('outputJson').textContent.trim().startsWith('{');
      setField('witnesses', '2');
      facts.fresh_again = !shown($('handoffState')) && !$('exportFromHandoff').disabled;
      captured = null;
      $('exportFromHandoff').click();
      facts.export_from_this_view = !!captured && same(JSON.parse(captured), D.makeExport());
      goto('analysis');
      return { pass: all(facts), detail: facts };
    });

    check('U20', '표현: 영향값은 로그오즈 기여로 표시하고, 금액은 원본 단위, 점수는 확률로 단정하지 않음', () => {
      loadCase('DEMO-001');
      const numbers = [...document.querySelectorAll('.driver-number')].map(node => node.textContent);
      const body = $('analysisView').textContent;
      const visibleText = ['analysisView', 'evaluationView', 'handoffView', 'helpDialog'].map(id => $(id).textContent).join(' ');
      const facts = {
        contribution_format: numbers.length === 6 && numbers.every(value => /^[+−]\d+\.\d{3}$/.test(value)),
        log_odds_note: body.includes('로그오즈') && body.includes('점수에 그대로 더하거나 빼는 배점이 아니며'),
        no_risk_point_wording: !/위험\s*점수/.test(visibleText),
        claim_units: ['injury_claim', 'property_claim', 'vehicle_claim'].every(name => $('unit-' + name).textContent === '원본 단위'),
        no_currency_symbols: !/[₩$]|KRW|만\s*원/.test(body),
        probability_disclaimer: text('scorePanel').includes('검증된 사기 확률이 아니며'),
        demo_scope_note: body.includes('이 화면의 점수로 모델 성능을 평가하지 않으며')
      };
      return { pass: all(facts), detail: { ...facts, sample_numbers: numbers } };
    });
    check('U21', '어느 상태에서도 화면에 깨진 출력([object …], undefined, NaN)이 없음', () => {
      const broken = /\[object |undefined|NaN/;
      const views = ['analysisView', 'evaluationView', 'handoffView'];
      const scan = label => ({ state: label, bad: views.filter(id => broken.test($(id).textContent)).concat(broken.test($('helpDialog').textContent) ? ['helpDialog'] : []) });
      const rows = [];
      loadCase('DEMO-002');
      rows.push(scan('최신 결과 (미상 3건)'));
      setField('injury_claim', '123');
      rows.push(scan('재분석 필요'));
      setField('injury_claim', '');
      analyze();
      rows.push(scan('분석 차단'));
      $('newManual').click();
      rows.push(scan('빈 양식'));
      loadCase('DEMO-001');
      setField('number_of_vehicles_involved', '9');
      analyze();
      rows.push(scan('경고 있는 결과'));
      goto('evaluation');
      $('gainChart').focus();
      rows.push(scan('모델 평가 (그래프 값 표시)'));
      $('gainChart').blur();
      goto('handoff');
      rows.push(scan('연결 데이터'));
      goto('analysis');
      const nullInAnalysis = / null\b|\bnull /.test($('analysisView').textContent);
      return { pass: rows.every(r => r.bad.length === 0) && !nullInAnalysis, detail: { rows, null_text_in_analysis_view: nullInAnalysis } };
    });
  } finally {
    window.Blob = RealBlob;
    HTMLAnchorElement.prototype.click = realAnchorClick;
    try { goto('analysis'); setThreshold(10); loadCase('DEMO-001'); } catch (error) { /* 정리 실패는 검사 결과에 영향을 주지 않는다 */ }
  }

  const failed = results.filter(r => !r.pass);
  return {
    viewport: { inner_width: window.innerWidth, inner_height: window.innerHeight, device_pixel_ratio: window.devicePixelRatio },
    passed: results.length - failed.length,
    failed: failed.length,
    results
  };
};
