/* 실제 브라우저에서 독립 실행 HTML의 화면 동작을 검사한다. (Node.js 22 이상, 외부 패키지 없음)
 *
 *   node validation/run_browser_checks.mjs                  검사 실행 → validation/rerun_browser_checks.json
 *   node validation/run_browser_checks.mjs --shots <폴더>    화면 캡처(PNG)도 함께 저장
 *
 * 설치된 Chrome / Edge / Chromium을 창 없이 띄워 DevTools 프로토콜로 조작한다.
 * PC(1440×900)와 모바일(390×844, 기기 에뮬레이션) 두 조건에서 validation/ui_checks.js를 실행하고,
 * 실제 키 입력·클릭·파일 내려받기·새로고침도 확인한다. 브라우저를 못 찾으면 CHROME_PATH로 경로를 지정한다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1] || 'shots') : null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PROFILES = [
  { name: 'PC 1440×900', key: 'pc', width: 1440, height: 900, scale: 1, mobile: false, expectLayout: 'side-by-side' },
  { name: '모바일 390×844 (기기 에뮬레이션)', key: 'mobile', width: 390, height: 844, scale: 2, mobile: true, expectLayout: 'stacked' }
];

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}`)); else resolve(message.result);
      } else if (message.method) for (const listener of [...this.listeners]) listener(message);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId, payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify(payload)); });
  }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  waitFor(predicate, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const off = this.on(message => { if (predicate(message)) { clearTimeout(timer); off(); resolve(message); } });
      const timer = setTimeout(() => { off(); reject(new Error('브라우저 응답 대기 시간 초과')); }, timeout);
    });
  }
}

async function launch(browserPath, profileDir) {
  const child = spawn(browserPath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps', '--mute-audio', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('브라우저 시작 시간 초과')), 30000);
    child.stderr.on('data', chunk => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`브라우저가 바로 종료되었습니다 (코드 ${code})`)); });
  });
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', () => reject(new Error('DevTools 연결 실패'))); });
  return { child, cdp: new Cdp(socket), socket };
}

async function openPage(cdp, profile, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  const log = { exceptions: [], console_errors: [], requests: [] };
  cdp.on(message => {
    if (message.sessionId !== sessionId) return;
    const p = message.params;
    if (message.method === 'Runtime.exceptionThrown') log.exceptions.push((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text);
    else if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(p.type)) log.console_errors.push(p.args.map(a => a.value ?? a.description).join(' '));
    else if (message.method === 'Log.entryAdded' && p.entry.level === 'error') log.console_errors.push(p.entry.text);
    else if (message.method === 'Network.requestWillBeSent') log.requests.push(p.request.url.slice(0, 96));
  });
  for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await send(domain + '.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: profile.width, height: profile.height, deviceScaleFactor: profile.scale, mobile: profile.mobile });
  if (profile.mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const waitLoad = () => cdp.waitFor(message => message.sessionId === sessionId && message.method === 'Page.loadEventFired');
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error((response.exceptionDetails.exception && response.exceptionDetails.exception.description) || response.exceptionDetails.text);
    return response.result.value;
  };
  const page = {
    targetId, send, evaluate, log,
    async navigate() { const loaded = waitLoad(); await send('Page.navigate', { url }); await loaded; },
    async reload() { const loaded = waitLoad(); await send('Page.reload'); await loaded; },
    /* 요소 가운데를 실제 마우스(또는 터치)로 누른다. */
    async tap(selector) {
      const point = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; node.scrollIntoView({ block: 'center' }); const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!point) throw new Error('요소를 찾지 못함: ' + selector);
      if (profile.mobile) {
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
      }
      await sleep(120);
    },
    /* 입력란에 초점을 두고 실제 글자 입력 이벤트를 보낸다. */
    async type(selector, text) {
      await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({ block: 'center' }); node.focus(); node.select(); })()`);
      await send('Input.insertText', { text });
      await sleep(60);
    },
    async pressEnter() {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await sleep(120);
    },
    async capture(file, clip) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: 1 } });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    },
    async captureSegments(prefix, segmentHeight, maxSegments) {
      await sleep(200);
      const { cssContentSize } = await send('Page.getLayoutMetrics');
      const total = Math.ceil(cssContentSize.height), files = [];
      for (let index = 0, y = 0; y < total && index < maxSegments; index += 1, y += segmentHeight) {
        const file = path.join(shotsDir, `${prefix}-${String(index + 1).padStart(2, '0')}.png`);
        await page.capture(file, { x: 0, y, width: profile.width, height: Math.min(segmentHeight, total - y) });
        files.push(path.basename(file));
      }
      return { page_height: total, files };
    }
  };
  await page.navigate();
  return page;
}

async function runProfile(cdp, profile, url, uiSource, sampleResult, downloadDir) {
  const page = await openPage(cdp, profile, url);
  const results = [];
  const check = async (id, title, fn) => {
    let outcome;
    try { outcome = await fn(); } catch (error) { outcome = { pass: false, detail: 'exception: ' + error.message }; }
    results.push({ id, title, pass: outcome.pass === true, detail: outcome.detail ?? null });
  };
  const allTrue = facts => Object.values(facts).every(value => value === true);

  // 1) 화면 안에서 실행하는 검사 묶음
  const ui = await page.evaluate(`${uiSource}\n;window.__runUiChecks(${JSON.stringify({ sampleResult, expectLayout: profile.expectLayout })})`);
  results.push(...ui.results);

  // 2) 실제 입력 장치 이벤트로 확인하는 검사
  await page.reload();
  await check('R1', '실제 키 입력: 값을 고치면 재분석 필요 상태가 되고, Enter로 재분석됨', async () => {
    await page.type('#field-injury_claim', '7000');
    const typed = await page.evaluate(`({ value: document.getElementById('field-injury_claim').value, phase: ClaimDashboard.state.phase, save_disabled: document.getElementById('saveReview').disabled })`);
    await page.pressEnter();
    const after = await page.evaluate(`({ phase: ClaimDashboard.state.phase, input: ClaimDashboard.state.current.inputs.injury_claim, save_disabled: document.getElementById('saveReview').disabled, id: ClaimDashboard.state.current.prediction_id })`);
    const facts = { typed_value: typed.value === '7000', stale_after_typing: typed.phase === 'stale' && typed.save_disabled, enter_reanalyses: after.phase === 'fresh' && after.input === 7000 && !after.save_disabled && after.id.endsWith('P0002') };
    return { pass: allTrue(facts), detail: facts };
  });
  await check('R2', '실제 키 입력: 숫자로 읽을 수 없는 입력(1e)은 유효하지 않은 숫자로 차단', async () => {
    await page.type('#field-vehicle_claim', '1e');
    const typed = await page.evaluate(`({ bad_input: document.getElementById('field-vehicle_claim').validity.badInput, read: Number.isNaN(ClaimDashboard.readInputs().vehicle_claim) })`);
    await page.pressEnter();
    const after = await page.evaluate(`({ phase: ClaimDashboard.state.phase, error: document.getElementById('error-vehicle_claim').textContent, errors: Object.keys(ClaimDashboard.state.errors), hidden: document.getElementById('resultRegion').hidden })`);
    const facts = { browser_reports_bad_input: typed.bad_input === true && typed.read === true, blocked: after.phase === 'blocked' && after.hidden === true && after.errors.length === 1, message: after.error.includes('유효한 숫자') };
    return { pass: allTrue(facts), detail: { ...facts, error: after.error } };
  });
  await check('R3', '실제 클릭(터치): 예시 선택과 검토 기준 전환', async () => {
    await page.tap('.case-button[data-case="DEMO-003"]');
    const loaded = await page.evaluate(`({ case_id: ClaimDashboard.state.caseId, phase: ClaimDashboard.state.phase, score: document.getElementById('scoreValue').textContent, pill: document.getElementById('recommendation').textContent.trim() })`);
    await page.tap('label[for="threshold-20"]');
    const at20 = await page.evaluate(`({ threshold: ClaimDashboard.currentThreshold(), score: document.getElementById('scoreValue').textContent, pill: document.getElementById('recommendation').textContent.trim() })`);
    await page.tap('label[for="threshold-10"]');
    const at10 = await page.evaluate(`({ threshold: ClaimDashboard.currentThreshold(), pill: document.getElementById('recommendation').textContent.trim() })`);
    const facts = { example_loaded: loaded.case_id === 'DEMO-003' && loaded.phase === 'fresh' && loaded.score === '11.8' && loaded.pill === '추가 확인 권고', threshold_20: at20.threshold === 20 && at20.score === '11.8' && at20.pill === '일반 검토', threshold_10: at10.threshold === 10 && at10.pill === '추가 확인 권고' };
    return { pass: allTrue(facts), detail: facts };
  });
  await check('R4', '결과 JSON 저장: 파일이 실제로 내려받아지고 내용이 화면의 결과와 같음', async () => {
    for (const name of fs.readdirSync(downloadDir)) fs.rmSync(path.join(downloadDir, name));
    await page.tap('.case-button[data-case="DEMO-001"]');
    await page.tap('label[for="review-basic"]');
    await page.evaluate(`(() => { const note = document.getElementById('reviewNote'); note.scrollIntoView({ block: 'center' }); note.focus(); })()`);
    await page.send('Input.insertText', { text: '검증용 메모: 제출 서류와 청구금액 대조 예정' });
    await page.tap('#saveReview');
    const expected = await page.evaluate('ClaimDashboard.makeExport()');
    await page.tap('#exportResult');
    let file = null;
    for (let attempt = 0; attempt < 50 && !file; attempt += 1) {
      await sleep(100);
      file = fs.readdirSync(downloadDir).find(name => name.endsWith('.json')) || null;
    }
    if (!file) return { pass: false, detail: '내려받은 파일을 찾지 못함' };
    const saved = JSON.parse(fs.readFileSync(path.join(downloadDir, file), 'utf8'));
    const facts = {
      file_name: file === `${expected.case_id}_${expected.prediction_id}_result.json`,
      same_as_screen: JSON.stringify(saved) === JSON.stringify(expected),
      has_inputs_and_score: Object.keys(saved.inputs).length === 24 && Math.abs(saved.prediction.score - 57.898465222) < 5e-10,
      has_review_record: saved.review_records.length === 1 && saved.review_records[0].memo.startsWith('검증용 메모') && saved.review_records[0].review_status === 'basic_review' && saved.review_records[0].model_score_at_review === saved.prediction.score
    };
    return { pass: allTrue(facts), detail: { ...facts, file, bytes: fs.statSync(path.join(downloadDir, file)).size } };
  });
  await check('R5', '새로고침하면 검토 기록이 사라지고 기본 상태(DEMO-001, 기준 10점)로 돌아옴', async () => {
    const before = await page.evaluate('ClaimDashboard.state.records.length');
    await page.reload();
    const after = await page.evaluate(`({ records: ClaimDashboard.state.records.length, count: document.getElementById('historyCount').textContent, case_id: ClaimDashboard.state.caseId, threshold: ClaimDashboard.currentThreshold(), score: document.getElementById('scoreValue').textContent })`);
    const facts = { had_record_before: before >= 1, records_gone: after.records === 0 && after.count === '0', default_state: after.case_id === 'DEMO-001' && after.threshold === 10 && after.score === '57.9' };
    return { pass: allTrue(facts), detail: facts };
  });
  await check('R6', '외부 네트워크 요청 없음 (요청 기록 확인)', async () => {
    const external = page.log.requests.filter(request => !/^(file:|data:|blob:|about:)/.test(request));
    return { pass: external.length === 0 && page.log.requests.some(request => request.startsWith('file:')), detail: { external_requests: external, request_kinds: [...new Set(page.log.requests.map(request => request.split(':')[0]))], total_requests: page.log.requests.length } };
  });
  await check('R7', '페이지 오류와 콘솔 오류 없음', async () => ({ pass: page.log.exceptions.length === 0 && page.log.console_errors.length === 0, detail: { exceptions: page.log.exceptions, console_errors: page.log.console_errors } }));

  // 3) 화면 캡처 (선택)
  let shots = null;
  if (shotsDir) {
    shots = {};
    const segment = profile.mobile ? 1100 : 1000, key = profile.key;
    await page.reload();
    await page.evaluate(`window.scrollTo(0, 0)`);
    shots.analysis = await page.captureSegments(`${key}-1-analysis`, segment, 8);
    await page.evaluate(`(() => { const n = document.getElementById('field-incident_severity'); n.value = 'Minor Damage'; n.dispatchEvent(new Event('input', { bubbles: true })); window.scrollTo(0, 0); })()`);
    shots.stale = await page.captureSegments(`${key}-2-stale`, segment, profile.mobile ? 5 : 2);
    await page.evaluate(`(() => { for (const [name, value] of [['incident_severity', ''], ['injury_claim', ''], ['incident_hour_of_the_day', '24']]) { const n = document.getElementById('field-' + name); n.value = value; n.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('analyzeButton').click(); document.activeElement.blur(); window.scrollTo(0, 0); })()`);
    shots.blocked = await page.captureSegments(`${key}-3-blocked`, segment, profile.mobile ? 5 : 2);
    await page.evaluate(`(() => { document.getElementById('newManual').click(); document.activeElement.blur(); window.scrollTo(0, 0); })()`);
    shots.manual = await page.captureSegments(`${key}-4-manual`, segment, 2);
    await page.reload();
    await page.evaluate(`(() => { ClaimDashboard.loadCase('DEMO-002'); document.getElementById('allDetails').open = true; document.querySelector('label[for="review-additional"]').click(); const note = document.getElementById('reviewNote'); note.value = '충돌 방향과 경찰 보고서 확보 여부를 확인한 뒤 다시 검토'; note.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('saveReview').click(); window.scrollTo(0, 0); })()`);
    shots.detail = await page.captureSegments(`${key}-5-detail`, segment, 8);
    await page.evaluate(`ClaimDashboard.switchView('evaluation')`);
    await sleep(250);
    await page.evaluate(`(() => { document.getElementById('gainChart').focus(); window.scrollTo(0, 0); })()`);
    shots.evaluation = await page.captureSegments(`${key}-6-evaluation`, segment, 6);
    await page.evaluate(`(() => { document.getElementById('gainChart').blur(); ClaimDashboard.switchView('handoff'); window.scrollTo(0, 0); })()`);
    shots.handoff = await page.captureSegments(`${key}-7-handoff`, segment, 6);
    await page.evaluate(`(() => { ClaimDashboard.switchView('analysis'); document.getElementById('helpButton').click(); window.scrollTo(0, 0); })()`);
    await sleep(150);
    const help = path.join(shotsDir, `${key}-8-help.png`);
    await page.capture(help, { x: 0, y: 0, width: profile.width, height: profile.height });
    shots.help = { files: [path.basename(help)] };
  }

  await cdp.send('Target.closeTarget', { targetId: page.targetId });
  const failed = results.filter(result => !result.pass);
  return { name: profile.name, viewport: { ...ui.viewport, emulated_mobile: profile.mobile }, passed: results.length - failed.length, failed: failed.length, page_errors: [...page.log.exceptions, ...page.log.console_errors], results, screenshots: shots };
}

async function main() {
  const htmlName = fs.readdirSync(root).find(name => name.normalize('NFC') === '보험청구_관리자_대시보드.html');
  if (!htmlName) { console.error('독립 실행 HTML이 없습니다. 먼저 python3 rebuild_from_payload.py 를 실행하세요.'); return 2; }
  const browserPath = findBrowser();
  if (!browserPath) { console.error('Chrome / Edge / Chromium을 찾지 못했습니다. CHROME_PATH 환경 변수로 실행 파일 경로를 지정하세요. (검사는 실행되지 않았습니다)'); return 2; }
  if (typeof WebSocket !== 'function') { console.error('Node.js 22 이상이 필요합니다. (검사는 실행되지 않았습니다)'); return 2; }
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

  const htmlPath = path.join(root, htmlName), url = pathToFileURL(htmlPath).href;
  const uiSource = fs.readFileSync(path.join(root, 'validation/ui_checks.js'), 'utf8');
  const sampleResult = JSON.parse(fs.readFileSync(path.join(root, 'data/sample_result.json'), 'utf8'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-dashboard-check-'));
  const profileDir = path.join(workDir, 'profile'), downloadDir = path.join(workDir, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });

  const { child, cdp, socket } = await launch(browserPath, profileDir);
  const profiles = [];
  let version;
  try {
    version = await cdp.send('Browser.getVersion');
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
    for (const profile of PROFILES) {
      const outcome = await runProfile(cdp, profile, url, uiSource, sampleResult, downloadDir);
      profiles.push(outcome);
      console.log(`\n[${outcome.name}] 화면 폭 ${outcome.viewport.inner_width}px`);
      for (const result of outcome.results) console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.id}  ${result.title}`);
    }
  } finally {
    try { await cdp.send('Browser.close'); } catch (error) { /* 이미 닫힘 */ }
    socket.close();
    await new Promise(resolve => { child.on('exit', resolve); setTimeout(resolve, 3000); });
    child.kill();
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
  }

  const failed = profiles.reduce((sum, profile) => sum + profile.failed, 0), passed = profiles.reduce((sum, profile) => sum + profile.passed, 0);
  const report = {
    kind: 'browser_checks',
    executed_at: new Date().toISOString(),
    browser: `${version.product} (headless)`,
    runtime: `Node.js ${process.version}`,
    html: { file: htmlName.normalize('NFC'), bytes: fs.statSync(htmlPath).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(htmlPath)).digest('hex') },
    status: failed ? 'failed' : 'passed',
    passed,
    failed,
    not_executed: ['Safari, Firefox 등 다른 브라우저 엔진에서의 확인', '실제 휴대전화 기기에서의 확인 (390px는 Chrome의 기기 에뮬레이션)', '화면 낭독기(스크린 리더)를 사용한 확인'],
    profiles
  };
  fs.writeFileSync(path.join(root, 'validation/rerun_browser_checks.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${passed}/${passed + failed} 통과 → validation/rerun_browser_checks.json` + (shotsDir ? `, 화면 캡처 → ${shotsDir}` : ''));
  return failed ? 1 : 0;
}

main().then(code => process.exit(code), error => { console.error('검사를 끝내지 못했습니다:', error.message); process.exit(2); });
