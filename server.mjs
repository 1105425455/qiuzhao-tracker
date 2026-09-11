import { createServer as httpServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { FIELDS, normalize, CAPTURE_HOSTS, progressCandidate, classifyDirection } from './model.mjs';
import { MODEL_CATALOG, apiForModel } from './models.mjs';
import { analyze, recognizeImage, extractApplications } from './ai.mjs';
import { normalizeEvent, legacyEventKey } from './calendar.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const Papa = createRequire(import.meta.url)('./vendor/papaparse.js');
const files = new Map([
  ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']], ['/model.mjs', ['model.mjs', 'text/javascript']],
  ['/vendor/papaparse.js', ['vendor/papaparse.js', 'text/javascript']],
  ['/vendor/lucide.js', ['vendor/lucide.js', 'text/javascript']],
  ['/calendar.mjs', ['calendar.mjs', 'text/javascript']],
  ['/calendar-ui.mjs', ['calendar-ui.mjs', 'text/javascript']],
  ['/bridge.mjs', ['bridge.mjs', 'text/javascript']],
  ['/browser-check', ['browser-check.html', 'text/html']],
  ['/browser-check/login', ['browser-check.html', 'text/html']],
  ['/vendor/fullcalendar.js', ['vendor/fullcalendar.js', 'text/javascript']],
  ['/vendor/fullcalendar-zh-cn.js', ['vendor/fullcalendar-zh-cn.js', 'text/javascript']]
]);
const aliases = { recordId: 'id', status: 'stage', platform: 'source', interviewTime: 'nextDate', 公司: 'company', 岗位名称: 'position', 岗位: 'position', 投递时间: 'applyTime', 当前状态: 'stage', 简历筛选结果: 'screening', 岗位链接: 'url', 简历版本: 'resumeVersion', 方向: 'direction', 工作地点: 'location', 备注: 'notes', 志愿: 'rank', 项目: 'program' };
const legacyStages = { 筛选中: '已投递', '笔试/测评': '笔试' };
const signature = record => JSON.stringify([record.company, record.position, record.applyTime, record.url]);
// A single-page app may append a slash, a hash route or sub-path after load, so
// accept the same origin when the requested path is a prefix of the current one.
export function samePage(a, b) {
  if (a.origin !== b.origin) return false;
  const norm = p => p.replace(/\/+$/, '') || '/';
  const pa = norm(a.pathname), pb = norm(b.pathname);
  return pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
}
export function looksLikeLogin(url) {
  const path = `${url.pathname}${url.hash}`;
  const search = url.search || '';
  return /([?&#]|^|\/)(login|signin|sign-in|signon|sso|passport)([=/?#]|$)/i.test(path + search) || /[?&](redirect|returnUrl|from)=(login|signin)/i.test(path + search);
}

export function importPreview(csv, existing) {
  if (typeof csv !== 'string' || Buffer.byteLength(csv) > 2_000_000) throw new Error('CSV 不能超过 2 MB');
  const parsed = Papa.parse(csv.replace(/^\uFEFF/, ''), { header: true, skipEmptyLines: 'greedy' });
  const errors = parsed.errors.map(e => `第 ${(e.row ?? 0) + 2} 行：${e.message}`);
  const headers = parsed.meta.fields || [];
  const mapped = headers.map(h => aliases[h] || h);
  const allowed = [...FIELDS, 'observedAt', 'priority', 'updatedAt'];
  for (const field of mapped) if (!allowed.includes(field)) errors.push(`无法识别列：${field}；请保留原文件后调整列名`);
  if (new Set(mapped).size !== mapped.length || parsed.meta.renamedHeaders) errors.push('存在重复列名');
  if (!mapped.includes('company') || !mapped.includes('position')) errors.push('CSV 必须包含 company 和 position（或公司、岗位）列');
  if (parsed.data.length > 5000) errors.push('单次最多导入 5000 条');
  const records = [], known = new Map(existing.map(r => [r.id, r])), seen = new Set(existing.map(signature));
  let skipped = 0;
  for (const [index, row] of parsed.data.entries()) {
    if (errors.length > 100) break;
    try {
      const mappedRow = {};
      for (const [key, value] of Object.entries(row)) mappedRow[aliases[key] || key] = value;
      mappedRow.stage = legacyStages[mappedRow.stage] || mappedRow.stage || (mappedRow.applyTime ? '已投递' : '待投递');
      if (mappedRow.priority) mappedRow.notes = `${mappedRow.notes || ''}\n优先级：${mappedRow.priority}`.trim();
      const record = normalize(mappedRow);
      if (record.id && known.has(record.id)) {
        if (JSON.stringify(normalize(known.get(record.id))) === JSON.stringify(record)) { skipped++; continue; }
        throw new Error('记录 ID 已存在且内容不同，不覆盖原记录');
      }
      // An explicit different ID means a distinct application, even for the same role.
      if (!record.id && seen.has(signature(record))) { skipped++; continue; }
      record.id ||= randomUUID();
      known.set(record.id, record);
      seen.add(signature(record));
      records.push(record);
    } catch (error) { errors.push(`第 ${index + 2} 行：${error.message}`); }
  }
  return { records, errors, skipped };
}

export function createServer({ dataDir = join(root, '../data/tracker'), aiConfig, fetchAI = fetch } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const snapshots = readdirSync(dataDir).filter(s => /^revision-\d+\.json$/.test(s)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  let state = snapshots.length ? JSON.parse(readFileSync(join(dataDir, snapshots.at(-1)), 'utf8')) : { records: [], revision: 0 };
  if (!Array.isArray(state.records) || !Number.isSafeInteger(state.revision)) throw new Error('本地台账损坏，停止写入；请保留原文件');
  state.events ??= [];
  if (!Array.isArray(state.events)) throw new Error('本地日程损坏，停止写入；请保留原文件');
  for (const record of state.records) normalize(record);
  // One-time-safe reclassify: older rows stored before the direction classifier
  // was widened may sit in "其他". Recompute from the position; keep user value
  // only when the classifier still cannot tell.
  let reclassified = 0;
  for (const record of state.records) {
    if (record.direction !== '其他') continue;
    const guess = classifyDirection(`${record.position} ${record.company}`);
    if (guess !== '其他') { record.direction = guess; reclassified++; }
  }
  if (reclassified) {
    const migrated = { records: state.records, events: state.events ?? [], revision: state.revision + 1 };
    writeFileSync(join(dataDir, `revision-${migrated.revision}.json`), JSON.stringify(migrated, null, 2), { flag: 'wx', mode: 0o600 });
    state = migrated;
  }
  for (const event of state.events) normalizeEvent(event);
  const pairToken = randomBytes(24).toString('hex');
  const configPath = join(dataDir, 'llm-config.json');
  // Selected model lives in a tiny side file so switching models never rewrites
  // the key or the gateway config.
  const modelPath = join(dataDir, 'llm-model.txt');
  let selectedModel = null;
  const readModel = () => {
    if (selectedModel) return selectedModel;
    if (existsSync(modelPath)) { const value = readFileSync(modelPath, 'utf8').trim(); if (/^[\w.:-]{1,100}$/.test(value)) selectedModel = value; }
    return selectedModel;
  };
  const provider = () => {
    if (aiConfig) return { ...aiConfig, model: readModel() || aiConfig.model };
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : { baseUrl: 'https://api.example.com/v1', model: 'your-model', enabled: false };
    if (config.apiKeyFile) {
      const keyFile = resolve(dataDir, config.apiKeyFile);
      const allowed = [resolve(dataDir), resolve(join(dataDir, '..'))];
      if (!allowed.some(root => keyFile.startsWith(`${root}/`) || keyFile === root)) throw new Error('服务端密钥文件位置无效');
      config.apiKey = readFileSync(keyFile, 'utf8').trim();
    }
    config.model = readModel() || config.model;
    return config;
  };
  // Public view of provider config that never exposes the key itself.
  const settingsView = () => {
    const config = provider();
    return { baseUrl: config.baseUrl, model: config.model, api: apiForModel(config.model), apiFormat: config.apiFormat || 'auto', enabled: config.enabled === true, hasKey: Boolean(config.apiKey), models: MODEL_CATALOG };
  };
  function saveSettings(body) {
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : { baseUrl: 'https://api.example.com/v1', model: 'your-model', enabled: false };
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
      const value = body.baseUrl.trim().replace(/\/+$/, '');
      let parsed; try { parsed = new URL(value); } catch { throw new Error('接口地址不是合法网址'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('接口地址必须是 HTTP/HTTPS 且不含账号密码');
      config.baseUrl = value;
    }
    if (typeof body.model === 'string' && body.model.trim()) {
      if (!/^[\w.:-]{1,100}$/.test(body.model.trim())) throw new Error('模型名称格式不正确');
      config.model = body.model.trim();
      writeFileSync(modelPath, config.model, { mode: 0o600 }); selectedModel = config.model;
    }
    if (body.apiFormat && ['auto', 'anthropic', 'openai'].includes(body.apiFormat)) config.apiFormat = body.apiFormat;
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      const keyFile = join(dataDir, 'llm-api-key.txt');
      writeFileSync(keyFile, body.apiKey.trim(), { mode: 0o600 });
      config.apiKeyFile = './llm-api-key.txt';
      delete config.apiKey;
    }
    if (body.enabled === true || body.enabled === false) config.enabled = body.enabled;
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    return settingsView();
  }
  let batch = null;
  let pageJob = null;
  let bridge = { lastSeen: 0, version: '' };
  let selfTest = null;
  // Last successful check time per record id. Kept in a side file so showing a
  // timestamp never has to rewrite a ledger revision and disturb pending updates.
  const checkPath = join(dataDir, 'check-times.json');
  let checkTimes = existsSync(checkPath) ? JSON.parse(readFileSync(checkPath, 'utf8')) : {};
  if (!checkTimes || typeof checkTimes !== 'object' || Array.isArray(checkTimes)) checkTimes = {};
  function noteChecked(id, at) {
    checkTimes[id] = at;
    try { writeFileSync(checkPath, JSON.stringify(checkTimes), { mode: 0o600 }); } catch { /* best effort */ }
  }
  const diagnostics = [];
  function log(event) {
    const entry = { at: new Date().toISOString(), ...event };
    diagnostics.push(entry); if (diagnostics.length > 80) diagnostics.shift();
    console.log(JSON.stringify(entry));
  }
  function browserReady() {
    if (Date.now() - bridge.lastSeen > 15000 || bridge.version !== '0.3.0') throw new Error('浏览器采集扩展未连接或版本过旧，尚未执行。请在连接设置中连接 0.3.0 版扩展');
  }
  function pageResult() {
    if (!pageJob) return { job: null };
    if (['queued', 'analyzing', 'needs-images'].includes(pageJob.status) && Date.now() - Date.parse(pageJob.at) > 5 * 60 * 1000) { pageJob.status = 'failed'; pageJob.message = '本次解析超时，请重试；未写入任何记录'; }
    const { cards, ...visible } = pageJob;
    return { job: visible };
  }
  function planRows(rows, url) {
    return rows.map(row => {
      const r = row.record;
      const scoped = state.records.filter(old => old.url === url);
      const matches = scoped.filter(old => r.sourceUid ? old.sourceUid === r.sourceUid : r.applyTime && old.company === r.company && old.position === r.position && old.applyTime === r.applyTime);
      const uncertain = !r.sourceUid && !r.applyTime && scoped.some(old => old.company === r.company && old.position === r.position);
      return { ...row, targetId: matches.length === 1 ? matches[0].id : '', action: matches.length > 1 || uncertain ? 'conflict' : matches.length === 1 ? 'update' : 'add' };
    });
  }
  const result = () => {
    const config = provider();
    const records = state.records.map(r => (checkTimes[r.id] && !r.lastCheckedAt) ? { ...r, lastCheckedAt: checkTimes[r.id] } : r);
    return { ...state, records, aiEnabled: config.enabled === true, aiModel: config.model, aiConfigured: Boolean(config.apiKey), aiBaseUrl: config.baseUrl, models: MODEL_CATALOG };
  };
  const batchResult = () => {
    if (!batch) return { batch: null };
    if (Date.now() - Date.parse(batch.at) > 60 * 60 * 1000) for (const task of batch.tasks) if (['queued', 'needs-image', 'ai-running'].includes(task.status)) { task.status = 'failed'; task.message = '本轮核对超时，请重新发起'; }
    return { batch };
  };
  function save(records, events = state.events) {
    if (records.length > 5000) throw new Error('台账最多 5000 条');
    if (events.length > 10000) throw new Error('日程最多 10000 条');
    const next = { records, events, revision: state.revision + 1 };
    writeFileSync(join(dataDir, `revision-${next.revision}.json`), JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
    state = next;
    return result();
  }
  function revision(body) {
    if (body.baseRevision !== state.revision) throw Object.assign(new Error('数据已在其他窗口更新，请刷新后重试'), { status: 409 });
  }
  function stamp(record, before, note) {
    const at = new Date().toISOString();
    return { ...record, updatedAt: at, history: [...(before?.history || []), { at, stage: record.stage, screening: record.screening, note: note || (before ? '手动确认更新' : '新增记录') }] };
  }
  const server = httpServer(async (req, res) => {
    const port = server.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const requestId = randomUUID().slice(0, 8), started = Date.now();
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      if (url.pathname.startsWith('/api/') && !['/api/diagnostics', '/api/refresh', '/api/pages', '/api/state'].includes(url.pathname)) log({ requestId, method: req.method, route: /^\/api\/[a-z/-]+$/.test(url.pathname) ? url.pathname : '/api/unknown', status: res.statusCode, durationMs: Date.now() - started });
    });
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      if (!hosts.includes(req.headers.host)) return send(403, { error: '仅允许本机访问' });
      const extension = req.headers.origin?.startsWith('chrome-extension://');
      const extensionRoute = ['/api/refresh/tasks', '/api/refresh/result', '/api/refresh/image', '/api/bridge/hello', '/api/bridge/self-test/result', '/api/pages/result', '/api/pages/images'].includes(url.pathname);
      if (req.headers.origin && !hosts.map(h => `http://${h}`).includes(req.headers.origin) && !(extension && extensionRoute)) return send(403, { error: '跨站请求被拒绝' });
      if (extensionRoute && extension) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tracker-Request, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') return send(204, '');
      }
      if (extensionRoute) {
        const token = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
        if (token.length !== pairToken.length || !timingSafeEqual(token, Buffer.from(pairToken))) return send(403, { error: '采集配对码无效，请重新配对' });
      }
      if (req.method === 'GET') {
        if (url.pathname === '/api/state') return send(200, result());
        if (url.pathname === '/api/health') return send(200, { ok: true, version: 4 });
        if (url.pathname === '/api/diagnostics') return send(200, { version: 4, bridge: { connected: Date.now() - bridge.lastSeen < 15000, version: bridge.version, lastSeen: bridge.lastSeen }, aiEnabled: provider().enabled === true, selfTest, events: diagnostics });
        if (url.pathname === '/api/ai/settings') return send(200, settingsView());
        if (url.pathname === '/api/pages') return send(200, pageResult());
        if (url.pathname === '/api/refresh') return send(200, batchResult());
        if (url.pathname === '/api/refresh/tasks') {
          batchResult();
          pageResult();
          return send(200, { batchId: batch?.id, tasks: batch?.applied ? [] : (batch?.tasks || []).filter(t => ['queued', 'needs-image'].includes(t.status)).map(t => ({ id: t.id, company: t.company, position: t.position, url: t.url })), page: pageJob?.status === 'queued' ? { id: pageJob.id, url: pageJob.url } : null, selfTest: selfTest?.status === 'queued' ? { id: selfTest.id } : null });
        }
        if (url.pathname === '/api/pairing') return send(200, { token: pairToken, endpoint: `http://127.0.0.1:${port}` });
        if (url.pathname === '/api/export') {
          const csv = Papa.unparse({ fields: FIELDS, data: state.records.map(r => FIELDS.map(f => r[f] || '')) }, { escapeFormulae: true });
          res.setHeader('Content-Disposition', 'attachment; filename="autumn-applications.csv"');
          return send(200, `\uFEFF${csv}`, 'text/csv');
        }
        if (files.has(url.pathname)) {
          const [file, type] = files.get(url.pathname);
          return send(200, readFileSync(join(root, file)), type);
        }
        return send(404, { error: '页面不存在' });
      }
      if (req.method !== 'POST') return send(405, { error: '不支持此操作；没有删除接口' });
      if (req.headers['x-tracker-request'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: '请求校验失败' });
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 2_100_000) throw new Error('请求内容过大'); chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = JSON.parse(raw); } catch { throw new Error('JSON 格式不正确'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求格式不正确');
      if (url.pathname === '/api/bridge/hello') {
        if (body.version !== '0.3.0') throw new Error('请更新官网采集扩展至 0.3.0');
        bridge = { version: body.version, lastSeen: Date.now() };
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/bridge/self-test/start') {
        browserReady();
        if (body.confirmed !== true) throw new Error('请确认测试截图外发，并在自检通过后启用自动 AI 兜底');
        selfTest = { id: randomUUID(), status: 'queued', at: new Date().toISOString(), message: '等待浏览器自检，不使用真实投递记录' };
        return send(200, { selfTest });
      }
      if (url.pathname === '/api/bridge/self-test/result') {
        const test = selfTest;
        if (!test || test.id !== body.id || test.status !== 'queued' || Date.now() - Date.parse(test.at) > 180000) throw new Error('自检任务失效，请重试');
        const required = ['matched', 'duplicateBlocked', 'loginBlocked', 'stable', 'detached'];
        if (body.error || required.some(key => body.checks?.[key] !== true)) { test.status = 'failed'; test.message = '浏览器自检未通过，AI 未启用'; return send(200, { ok: false, message: test.message }); }
        test.status = 'running'; test.message = '浏览器检查通过，正在核验 800px 测试截图';
        try {
          const recognized = await recognizeImage({ ...provider(), enabled: true }, { company: '本地自检', position: '浏览器自检岗位' }, body.image, fetchAI);
          if (recognized.candidate.stage !== '二面' || selfTest !== test) throw new Error('自检结果不符');
          const proof = { at: new Date().toISOString(), extensionVersion: bridge.version, checks: Object.fromEntries(required.map(key => [key, true])), imageRecognition: true, realRecruitmentSiteValidated: false };
          writeFileSync(join(dataDir, `acceptance-${test.id}.json`), JSON.stringify(proof, null, 2), { flag: 'wx', mode: 0o600 });
          if (aiConfig) aiConfig.enabled = true;
          else { const settings = JSON.parse(readFileSync(configPath, 'utf8')); settings.enabled = true; writeFileSync(configPath, JSON.stringify(settings, null, 2), { mode: 0o600 }); }
          test.status = 'passed'; test.message = '自检通过；后续规则失败自动用 AI 兜底，结果仍需确认';
        } catch { test.status = 'failed'; test.message = '图片接口或自检识别未通过，AI 未启用；请查看服务日志'; }
        return send(200, { ok: test.status === 'passed', message: test.message });
      }
      if (url.pathname === '/api/pages/start') {
        browserReady(); revision(body);
        if (!provider().enabled) throw new Error('AI 尚未启用，浏览器采集验收完成后才会解析招聘页面');
        if (pageJob && ['queued', 'analyzing', 'needs-images'].includes(pageResult().job?.status)) throw new Error('已有页面正在解析');
        const source = new URL(body.url);
        normalize({ company: '网址校验', position: '网址校验', url: body.url });
        if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || /(?:token|password|secret|authorization)=/i.test(`${source.search}${source.hash}`)) throw new Error('请填写正常招聘投递页网址，且网址本身不含登录凭证');
        if (typeof body.company !== 'string' || body.company.length > 200) throw new Error('公司名称格式不正确');
        pageJob = { id: randomUUID(), url: source.href, company: body.company.trim(), at: new Date().toISOString(), baseRevision: state.revision, status: 'queued', message: '准备读取已登录的投递列表', rows: [], warnings: [] };
        return send(200, pageResult());
      }
      if (url.pathname === '/api/pages/result') {
        const job = pageJob;
        if (!job || job.id !== body.id || job.status !== 'queued') throw new Error('页面任务已失效');
        const fail = message => { job.status = 'failed'; job.message = message; if (body.debug) job.debug = { textLen: body.debug.textLen, cards: body.debug.cards, found: body.debug.found, leaves: body.debug.leaves, titleMatched: body.debug.titleMatched }; log({ event: 'page.failed', requestId, reason: message, debug: job.debug }); return send(200, { ok: true }); };
        if (body.error) return fail(String(body.error).slice(0, 300));
        const source = new URL(body.url), expected = new URL(job.url);
        if (!samePage(source, expected)) return fail(`页面来源改变或需要登录（当前：${source.origin}${source.pathname}）`);
        if (looksLikeLogin(source)) return fail('页面跳到了登录页，请先在该网站登录后重试');
        if (!Array.isArray(body.cards) || !body.cards.length || body.cards.length > 20) return fail('未读取到投递卡片');
        const cards = body.cards.map(card => ({ text: card.text, position: typeof card.position === 'string' ? card.position.slice(0, 200) : '', uid: card.uid || '', group: card.group === true }));
        if (cards.some(card => typeof card.text !== 'string' || card.text.length > 3500 || /验证码|密码|身份证|access_token|authorization|1[3-9]\d{9}/i.test(card.text) || typeof card.uid !== 'string' || (card.uid && !/^[\w.:-]{1,200}$/.test(card.uid)))) return fail('卡片内容过大或含敏感信息，不发送给 AI');
        job.status = 'analyzing'; job.message = `规则正在识别 ${cards.length} 个投递区域`;
        job.cards = cards; job.title = typeof body.title === 'string' ? body.title.slice(0, 200) : ''; job.more = body.more === true; job.skipped = Number.isInteger(body.skipped) ? body.skipped : 0;
        job.pageText = typeof body.pageText === 'string' ? body.pageText.slice(0, 3500) : cards.map(card => card.text).join('\n').slice(0, 3500);
        if (/验证码|密码|身份证|access_token|authorization/i.test(job.pageText)) return fail('页面有登录或敏感信息，不外发');
        const ruleRows = [];
        for (const [index, card] of cards.entries()) {
          const parsed = progressCandidate(card.text);
          if (card.group || !job.company || !card.position || !card.text.includes(card.position) || parsed.ambiguous || !Object.keys(parsed.candidate).length) continue;
          const date = card.text.match(/(?:投递|申请|应聘)时间\s*[：:]?\s*(\d{4}-\d{2}-\d{2})/)?.[1] || '';
          try {
            const record = normalize({ company: job.company, position: card.position, applyTime: date, stage: parsed.candidate.stage || '已投递', screening: parsed.candidate.screening || '待反馈', url: job.url, rawStatus: parsed.evidence, source: '官网列表规则', sourceUid: card.uid, direction: classifyDirection(card.position) });
            ruleRows.push({ index, record });
          } catch { /* Ambiguous or inconsistent records are reviewed with the whole-page image. */ }
        }
        job.rows = planRows(ruleRows, job.url);
        const needsImage = ruleRows.length !== cards.length;
        job.status = needsImage ? 'needs-images' : 'ready'; job.message = needsImage ? '规则无法完整确认，自动发送 800px 整页截图给 AI' : `规则识别 ${job.rows.length} 条投递，等待确认`;
        return send(200, { ok: true, needsImage });
      }
      if (url.pathname === '/api/pages/images') {
        const job = pageJob;
        if (!job || job.id !== body.id || job.status !== 'needs-images') throw new Error('截图任务已失效');
        if (body.error) { job.status = 'ready'; job.message = '截图复核未完成，仅保留已确认的文字候选'; job.warnings.push(String(body.error).slice(0, 300)); return send(200, { ok: true }); }
        const source = new URL(body.url), expected = new URL(job.url);
        if (!samePage(source, expected) || looksLikeLogin(source)) throw new Error('截图来源改变或为登录页');
        job.status = 'analyzing';
        try {
          const parsed = await extractApplications(provider(), { ...job, recordPage: true, cards: [{ text: job.pageText, image: body.image, group: true }] }, fetchAI);
          if (pageJob !== job || job.status !== 'analyzing') return send(409, { error: '任务已结束' });
          if (parsed.rows.length) job.rows = planRows(parsed.rows, job.url);
          job.warnings = parsed.warnings && parsed.warnings.length ? parsed.warnings : job.warnings;
          if (!parsed.rows.length) job.warnings.push('整页截图未能识别出岗位，仅保留已有规则候选');
        } catch (error) { job.warnings.push(`整页截图识别失败：${error && error.message ? error.message : '未知原因'}；未修改台账`); log({ event: 'page.image.failed', requestId, reason: error && error.message }); }
        job.status = 'ready'; job.message = `已识别 ${job.rows.length} 条投递，等待确认`;
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/pages/reset') {
        // Drop a finished/failed job so a reopened dialog never re-shows old results.
        if (pageJob && ['ready', 'failed', 'imported'].includes(pageJob.status)) { log({ event: 'page.reset', requestId, previous: pageJob.status }); pageJob = null; }
        return send(200, pageResult());
      }
      if (url.pathname === '/api/pages/cancel') {
        if (pageJob?.id === body.id) { pageJob.status = 'failed'; pageJob.message = '本次解析已停止，未确认的记录不写入'; }
        return send(200, pageResult());
      }
      if (url.pathname === '/api/ai/settings') {
        if (body.confirmed !== true) throw new Error('修改 AI 设置需要确认');
        const saved = saveSettings(body);
        log({ event: 'ai.settings', requestId, baseUrl: saved.baseUrl, model: saved.model, enabled: saved.enabled, hasKey: saved.hasKey });
        return send(200, saved);
      }
      if (url.pathname === '/api/ai/test') {
        const config = provider();
        if (!config.apiKey) throw new Error('还没有填写 API Key');
        const reply = await analyze({ ...config, enabled: true }, { consent: true, text: '只回复：连接正常。' }, fetchAI).catch(error => { throw new Error(error.message); });
        log({ event: 'ai.test', requestId, ok: true, model: config.model });
        return send(200, { ok: true, text: reply.text.slice(0, 100) });
      }
      if (url.pathname === '/api/pages/apply') {
        const job = pageJob;
        if (!job || job.id !== body.id || job.status !== 'ready' || body.confirmed !== true) throw new Error('请等待解析结束并确认需要保存的记录');
        revision({ baseRevision: job.baseRevision });
        if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > job.rows.length) throw new Error('请选择要保存的投递');
        const used = new Set(), records = [...state.records];
        const checkedAt = new Date().toISOString();
        for (const input of body.rows) {
          const row = job.rows.find(row => row.index === input.index);
          if (!row || row.action === 'conflict' || used.has(input.index)) throw new Error('候选重复或身份不明确，请人工核对');
          used.add(input.index);
          const before = row.targetId ? state.records.find(record => record.id === row.targetId) : null;
          // The values were just read from the official page, so this import also
          // counts as a check — record the time instead of leaving it "未核对".
          const record = normalize({ ...before, ...row.record, company: input.company, position: input.position, applyTime: input.applyTime, stage: input.stage, screening: input.screening, lastCheckedAt: checkedAt, id: before?.id || randomUUID(), ...(before ? { notes: before.notes, nextDate: before.nextDate, nextAction: before.nextAction, resumeVersion: before.resumeVersion } : {}) });
          const updated = stamp(record, before, '官网投递列表解析：用户确认');
          noteChecked(updated.id, checkedAt);
          if (before) records[records.findIndex(item => item.id === before.id)] = updated; else records.push(updated);
        }
        const saved = save(records); job.status = 'imported'; job.cards = []; job.message = `已保存 ${used.size} 条投递`; return send(200, saved);
      }
      if (url.pathname === '/api/events') {
        revision(body);
        const event = normalizeEvent(body.event);
        const before = state.events.find(item => item.id === event.id);
        if (event.id && !before) throw new Error('日程不存在，请刷新后重试');
        if (before && body.confirmed !== true) throw new Error('修改已有日程需要确认');
        if (event.recordId && !state.records.some(record => record.id === event.recordId)) throw new Error('关联的投递记录不存在');
        if (event.legacyKey) {
          if (before && event.legacyKey !== before.legacyKey) throw new Error('原有安排的来源不可变更');
          if (!before) {
            const record = state.records.find(record => record.id === event.recordId);
            if (!record || !record.nextDate || legacyEventKey(record) !== event.legacyKey) throw new Error('原有安排已变化，请刷新后重新核对');
            if (state.events.some(item => item.legacyKey === event.legacyKey)) throw new Error('这条原有安排已建立日程，请刷新后编辑');
          }
        }
        if (before?.legacyKey && !event.legacyKey) throw new Error('请保留原有安排的来源');
        event.id ||= randomUUID();
        const at = new Date().toISOString();
        const updated = { ...event, updatedAt: at, history: [...(before?.history || []), { at, date: event.date, startTime: event.startTime, endTime: event.endTime, allDay: event.allDay, title: event.title, status: event.status }] };
        return send(200, save(state.records, before ? state.events.map(item => item.id === event.id ? updated : item) : [...state.events, updated]));
      }
      if (url.pathname === '/api/records/delete') {
        revision(body);
        if (body.confirmed !== true) throw new Error('删除需要确认');
        const target = state.records.find(record => record.id === body.id);
        if (!target) throw new Error('记录不存在，请刷新后重试');
        const records = state.records.filter(record => record.id !== body.id);
        const events = state.events.filter(event => event.recordId !== body.id);
        log({ event: 'record.deleted', requestId, company: target.company, remaining: records.length });
        return send(200, save(records, events));
      }
      if (url.pathname === '/api/refresh/start') {
        browserReady();
        revision(body);
        batchResult();
        if (batch && !batch.applied && batch.tasks.some(t => ['queued', 'needs-image', 'ai-running'].includes(t.status))) throw new Error('已有核对任务进行中，请先等待或结束本轮');
        const requestedIds = Array.isArray(body.ids) ? new Set(body.ids.filter(id => typeof id === 'string')) : null;
        const records = state.records.filter(r => r.stage !== '待投递' && (!requestedIds || requestedIds.has(r.id)));
        if (!records.length) throw new Error('目前没有已投递记录，请先新增或导入台账');
        batch = { id: randomUUID(), at: new Date().toISOString(), baseRevision: state.revision, applied: false, allowAI: provider().enabled === true, tasks: records.map(r => {
          let message = '';
          if (!r.url) message = '未填写官网进度网址';
          else if (!['http:', 'https:'].includes(new URL(r.url).protocol)) message = '请填写 HTTP/HTTPS 投递页网址';
          return { id: r.id, company: r.company, position: r.position, url: r.url, before: { stage: r.stage, screening: r.screening }, status: message ? 'failed' : 'queued', message };
        }) };
        return send(200, batchResult());
      }
      if (url.pathname === '/api/refresh/cancel') {
        if (!batch || body.batchId !== batch.id) throw new Error('本轮任务已失效');
        for (const task of batch.tasks) if (['queued', 'needs-image', 'ai-running'].includes(task.status)) { task.status = 'failed'; task.message = '用户结束本轮，原记录保留'; }
        return send(200, batchResult());
      }
      if (url.pathname === '/api/refresh/result') {
        batchResult();
        const task = batch?.tasks.find(t => t.id === body.id);
        if (!batch || body.batchId !== batch.id || batch.applied || !task || !['queued', 'needs-image'].includes(task.status)) throw new Error('任务已过期或结果已接收');
        const fail = message => { task.status = 'failed'; task.message = message; return send(200, { ok: true }); };
        if (body.error) {
          let validSource = false;
          try { const source = new URL(body.url); validSource = source.origin === new URL(task.url).origin && !looksLikeLogin(source); } catch { /* Keep an unverified page out of the model. */ }
          if (body.fallbackAllowed === true && validSource && batch.allowAI && provider().enabled) { task.status = 'needs-image'; task.message = '规则定位失败，自动用 800px 整页截图核对'; return send(200, { ok: true, needsAI: true }); }
          return fail(String(body.error).slice(0, 300));
        }
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 5000) return fail('未提取到单条记录原文或文本过长');
        const source = new URL(body.url);
        // Same-origin is enough; do not require the page text to literally repeat
        // the stored position name (that caused many false "岗位不匹配" failures).
        if (source.origin !== new URL(task.url).origin || looksLikeLogin(source)) return fail('登录失效或来源改变');
        if (/验证码|密码|身份证|access_token|authorization/i.test(body.text)) return fail('原文可能包含敏感信息，未保留');
        const parsed = progressCandidate(body.text);
        if (parsed.ambiguous || !Object.keys(parsed.candidate).length) {
          if (batch.allowAI && provider().enabled) { task.status = 'needs-image'; task.message = '规则不确定，等待单条卡片截图'; return send(200, { ok: true, needsAI: true }); }
          return fail(parsed.ambiguous ? '原文状态冲突，需要人工核对' : '未识别到明确的当前步骤，原记录保留');
        }
        const record = state.records.find(r => r.id === task.id);
        let candidate;
        try { candidate = normalize({ ...record, ...parsed.candidate }); } catch { return fail('新步骤与已有记录矛盾，需要人工核对'); }
        task.candidate = { stage: candidate.stage, screening: candidate.screening };
        task.evidence = parsed.evidence; task.checkedAt = new Date().toISOString(); task.method = '规则';
        noteChecked(task.id, task.checkedAt);
        task.status = candidate.stage === task.before.stage && candidate.screening === task.before.screening ? 'unchanged' : 'changed';
        task.message = task.status === 'changed' ? '发现步骤变化' : '官网状态未变化';
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/refresh/image') {
        const task = batch?.tasks.find(t => t.id === body.id);
        if (!batch || body.batchId !== batch.id || !batch.allowAI || batch.applied || !task || task.status !== 'needs-image') throw new Error('没有已授权的截图兜底任务');
        if (new URL(body.url).origin !== new URL(task.url).origin || looksLikeLogin(new URL(body.url))) throw new Error('截图来源不匹配或为登录页');
        task.status = 'ai-running'; task.message = '正在核对截图';
        try {
          const parsed = await recognizeImage(provider(), task, body.image, fetchAI);
          if (batch.id !== body.batchId || task.status !== 'ai-running') return send(409, { error: '任务已结束，丢弃迟到的 AI 结果' });
          const record = state.records.find(r => r.id === task.id);
          const candidate = normalize({ ...record, ...parsed.candidate });
          task.candidate = { stage: candidate.stage, screening: candidate.screening }; task.evidence = parsed.evidence; task.method = 'AI 截图'; task.checkedAt = new Date().toISOString();
          noteChecked(task.id, task.checkedAt);
          task.status = candidate.stage === task.before.stage && candidate.screening === task.before.screening ? 'unchanged' : 'changed'; task.message = 'AI 截图候选，等待批量确认';
        } catch (error) { if (task.status === 'ai-running') { task.status = 'failed'; task.message = `截图识别未通过：${error && error.message ? error.message : '未知原因'}`; log({ event: 'refresh.image.failed', requestId, task: task.id, reason: error && error.message }); } }
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/refresh/apply') {
        if (!batch || batch.id !== body.batchId || batch.applied) throw new Error('任务已失效或已更新');
        revision({ baseRevision: batch.baseRevision });
        if (body.confirmed !== true) throw new Error('请确认批量更新');
        if (batch.tasks.some(t => ['queued', 'needs-image', 'ai-running'].includes(t.status))) throw new Error('核对尚未完成，请等待或结束本轮');
        const successful = new Map(batch.tasks.filter(t => ['changed', 'unchanged'].includes(t.status)).map(t => [t.id, t]));
        if (!successful.size) throw new Error('没有可更新的核对结果，原记录未改变');
        const records = state.records.map(r => { const t = successful.get(r.id); return t ? stamp({ ...r, ...t.candidate, rawStatus: t.evidence, lastCheckedAt: t.checkedAt }, r, t.status === 'changed' ? '批量核对：确认步骤变化' : '批量核对：步骤无变化') : r; });
        const saved = save(records); batch.applied = true;
        return send(200, saved);
      }
      if (url.pathname === '/api/model') {

        if (body.confirmed !== true) throw new Error('切换模型需要确认');
        if (typeof body.model !== 'string' || !/^[\w.:-]{1,100}$/.test(body.model)) throw new Error('模型名称格式不正确');
        writeFileSync(modelPath, body.model, { mode: 0o600 });
        selectedModel = body.model;
        log({ event: 'model.switched', requestId, model: body.model, api: apiForModel(body.model) });
        return send(200, result());
      }
      if (url.pathname === '/api/ai/preview') {
        if (!provider().enabled) return send(403, { error: 'AI 未启用，模型接口验收待完成' });
        return send(200, await analyze(provider(), body, fetchAI));
      }
      if (url.pathname === '/api/import-preview') return send(200, importPreview(body.csv, state.records));
      if (url.pathname === '/api/import') {
        revision(body);
        if (body.confirmed !== true) throw new Error('请先预览并确认导入');
        const preview = importPreview(body.csv, state.records);
        if (preview.errors.length) throw new Error(preview.errors.join('\n'));
        if (!preview.records.length) throw new Error('没有可新增的记录');
        return send(200, save([...state.records, ...preview.records.map(r => stamp(r))]));
      }
      if (url.pathname === '/api/records') {
        revision(body);
        const record = normalize(body.record);
        const before = state.records.find(r => r.id === record.id);
        if (record.id && !before) throw new Error('记录不存在，请刷新后重试');
        if (before && body.confirmed !== true) throw new Error('修改已有记录需要确认');
        record.id ||= randomUUID();
        const updated = stamp(record, before);
        return send(200, save(before ? state.records.map(r => r.id === record.id ? updated : r) : [...state.records, updated]));
      }
      return send(404, { error: '接口不存在' });
    } catch (error) {
      const internal = error.code || error.name === 'TypeError' || error.name === 'SyntaxError';
      return send(error.status || 400, { error: internal ? '处理失败；原记录未被覆盖，请检查本地服务和文件' : error.message, requestId });
    }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4319);
  const server = createServer();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用；请换一个 PORT，不要结束其他程序。` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`秋招台账 http://127.0.0.1:${port}`));
}
