import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { normalize, screeningCandidate, progressCandidate, classifyDirection } from './model.mjs';
import { createServer, importPreview, samePage, looksLikeLogin } from './server.mjs';
import { recognizeImage, analyze, extractApplications, parseLooseJson } from './ai.mjs';
import { apiForModel, MODEL_CATALOG } from './models.mjs';
import { normalizeEvent, scheduledEvents, legacyEventKey } from './calendar.mjs';
import { fitImage } from './extension/image.js';
import { stableFingerprint } from './extension/fingerprint.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const base = { company: '测试公司', position: '语音算法', applyTime: '2026-09-01', stage: '已投递', screening: '待反馈', direction: '语音算法', url: 'https://iflytek.zhiye.com/campus/jobs' };
async function announce(origin) {
  const pair = await (await fetch(origin + '/api/pairing')).json();
  const response = await fetch(origin + '/api/bridge/hello', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Request': '1', Authorization: `Bearer ${pair.token}` }, body: JSON.stringify({ version: '0.3.0' }) });
  assert.equal(response.status, 200); return pair;
}
test('source matching tolerates SPA reroutes but flags real login pages', () => {
  const base = new URL('https://join.tencentmusic.com/deliver');
  assert(samePage(new URL('https://join.tencentmusic.com/deliver'), base));
  assert(samePage(new URL('https://join.tencentmusic.com/deliver/'), base));
  assert(samePage(new URL('https://join.tencentmusic.com/deliver#/list'), base));
  assert(samePage(new URL('https://join.tencentmusic.com/deliver/application/123'), base));
  assert(!samePage(new URL('https://join.tencentmusic.com/other'), base));
  assert(!samePage(new URL('https://evil.example/deliver'), base));
  // An "author" style path must NOT be treated as login (old bug).
  assert(!looksLikeLogin(new URL('https://join.tencentmusic.com/author/list')));
  assert(!looksLikeLogin(new URL('https://x.com/deliver/auth-code')));
  assert(looksLikeLogin(new URL('https://x.com/login')));
  assert(looksLikeLogin(new URL('https://x.com/sso/callback')));
  assert(looksLikeLogin(new URL('https://x.com/passport/signin')));
  assert(looksLikeLogin(new URL('https://x.com/deliver?redirect=login')));
});
test('single progress page yields one record, not one per step', async () => {
  const input = { url: 'https://x.com/progress', company: '某公司', recordPage: true, title: '应聘进度', singlePage: true, cards: [{ text: '应聘进度 投递时间：2026-09-10 投递岗位：元宝-多模态对话系统研究 当前状态：简历投递成功 投递简历 测评 面试 Offer 三方协议', image: png, group: true }] };
  const parsed = await extractApplications(config, input, async () => fakeReply({ applications: [{ index: 0, applied: true, confidence: 'high', company: '某公司', position: '元宝-多模态对话系统研究', applyTime: '2026-09-10', stage: '已投递', screening: '待反馈', evidence: '当前状态：简历投递成功' }] }));
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].record.position, '元宝-多模态对话系统研究');
  assert.equal(parsed.rows[0].record.stage, '已投递');
});
test('loose JSON parser repairs fences, prose, trailing commas and truncation', () => {
  assert.deepEqual(parseLooseJson('```json\n{"applications":[]}\n```'), { applications: [] });
  assert.deepEqual(parseLooseJson('好的，结果如下：{"applications":[{"position":"x"}]} 完成'), { applications: [{ position: 'x' }] });
  assert.deepEqual(parseLooseJson('{"applications":[{"position":"x"},]}'), { applications: [{ position: 'x' }] });
  const arr = parseLooseJson('[{"position":"a"},{"position":"b"}]');
  assert.equal(arr.applications.length, 2);
  // Truncated last object gets dropped, earlier records preserved.
  const truncated = parseLooseJson('{"applications":[{"position":"a"},{"position":"b","stage":"笔试"');
  assert.equal(truncated.applications.length >= 1, true);
  assert.equal(parseLooseJson('完全不是 JSON'), null);
});

test('extractApplications retries once and still returns rows for messy multi-job output', async () => {
  let calls = 0;
  const mock = async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '这是说明文字，不是JSON' } }] }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"applications":[{"index":0,"applied":true,"confidence":"high","position":"语音算法","stage":"已投递","screening":"待反馈","evidence":"简历投递"}]}\n```' } }] }), { status: 200 });
  };
  const input = { url: 'https://x.com', recordPage: true, cards: [{ group: true, text: '投递记录' }] };
  const result = await extractApplications(config, input, mock);
  assert.equal(calls, 2);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].record.position, '语音算法');
});
test('custom provider settings save and never echo the key', async () => {
  const testRoot = join(root, '.test-runs'); mkdirSync(testRoot, { recursive: true });
  const dataDir = mkdtempSync(join(testRoot, 'provider-'));
  const req = async (server, path, body) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Tracker-Request': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const server = createServer({ dataDir, fetchAI: async () => new Response(JSON.stringify({ choices: [{ message: { content: '连接正常。' } }] }), { status: 200 }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    let view = (await req(server, '/api/ai/settings')).data;
    assert.equal(view.hasKey, false);
    assert.equal((await req(server, '/api/ai/settings', { baseUrl: 'https://my-gateway.example.com/v1', model: 'my-model-x', apiFormat: 'anthropic', apiKey: 'secret-abc-123', enabled: true })).status, 400);
    view = (await req(server, '/api/ai/settings', { baseUrl: 'https://my-gateway.example.com/v1', model: 'my-model-x', apiFormat: 'anthropic', apiKey: 'secret-abc-123', enabled: true, confirmed: true })).data;
    assert.equal(view.baseUrl, 'https://my-gateway.example.com/v1');
    assert.equal(view.model, 'my-model-x');
    assert.equal(view.apiFormat, 'anthropic');
    assert.equal(view.hasKey, true);
    assert(!JSON.stringify(view).includes('secret-abc-123'));
    // HTTP is useful for local Ollama/LM Studio gateways; credentials in the URL are not.
    assert.equal((await req(server, '/api/ai/settings', { baseUrl: 'http://127.0.0.1:11434/v1', confirmed: true })).status, 200);
    assert.equal((await req(server, '/api/ai/settings', { baseUrl: 'https://user:pass@x.com/v1', confirmed: true })).status, 400);
    // Key file is stored on disk, not returned by any endpoint.
    const state = (await req(server, '/api/state')).data;
    assert(!JSON.stringify(state).includes('secret-abc-123'));
    assert(readdirSync(dataDir).includes('llm-api-key.txt'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('rank regex tolerates spaces, full-width and Chinese digits', () => {
  const rankRe = /第\s*[1-9一二三四五六七八九０-９0-9]\s*志愿/;
  for (const sample of ['第1志愿', '第 1 志愿', '第2志愿', '第 2 志愿', '第１志愿', '第一志愿']) assert(rankRe.test(sample), sample);
  assert(!rankRe.test('志愿填报说明'));
});
test('direction classifier covers image and other algorithm families', () => {
  assert.equal(classifyDirection('算法工程师（图像算法）-广州-2027届秋招(J18074)'), '图像算法');
  assert.equal(classifyDirection('计算机视觉算法工程师'), '图像算法');
  assert.equal(classifyDirection('（2027届）多模态视频生成算法工程师'), '多模态算法');
  assert.equal(classifyDirection('（2027届）AIGC语音大模型算法工程师'), '语音算法');
  assert.equal(classifyDirection('大模型算法工程师（LLM方向）'), '大模型算法');
  assert.equal(classifyDirection('推荐算法工程师'), '推荐搜索');
  assert.equal(classifyDirection('机器学习算法工程师'), '通用算法');
  assert.equal(classifyDirection('前端开发工程师'), '其他');
});test('steps only use explicit current labels; no inferred rejection or interview round', () => {
  assert.deepEqual(progressCandidate('岗位\n当前状态：二面中\n已投递\n一面中').candidate, { stage: '二面' });
  assert.deepEqual(progressCandidate('岗位\n面试中').candidate, { stage: '面试中' });
  assert.deepEqual(progressCandidate('岗位\n流程结束').candidate, { stage: '已结束' });
  assert.equal(progressCandidate('待笔试\n二面中').ambiguous, true);
  assert.deepEqual(progressCandidate('简历未通过').candidate, { stage: '已结束', screening: '未通过' });
  assert.deepEqual(progressCandidate('算法工程师（图像算法）-广州-2027届秋招(J18074)\n当前进度：笔试-未处理\n校园招聘 2026-09-03 15:38 投递').candidate, { stage: '笔试' });
  assert.deepEqual(progressCandidate('算法工程师\n当前进度：测评已完成').candidate, { stage: '笔试' });
});
test('validate dates, URLs and contradictory states', () => {
  for (const applyTime of ['2026-02-30', '2026-13-01', '2026/09/01']) assert.throws(() => normalize({ ...base, applyTime }));
  for (const url of ['javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/?token=x']) assert.throws(() => normalize({ ...base, url }));
  assert.throws(() => normalize({ ...base, screening: '未通过' }));
  assert.equal(normalize({ ...base, applyTime: '' }).applyTime, '');
  assert.throws(() => normalize({ ...base, stage: '待投递' }));
  assert.equal(normalize({ ...base, stage: '已结束' }).screening, '待反馈');
});
test('status capture never equates end or action buttons with rejection', () => {
  assert.equal(screeningCandidate('流程结束\n撤回申请\n未回复').screening, null);
  assert.equal(screeningCandidate('如果简历未通过，请继续投递').screening, null);
  assert.equal(screeningCandidate('语音算法\n简历筛选通过').screening, '通过');
  assert.equal(screeningCandidate('简历通过\n简历未通过').ambiguous, true);
});
test('CSV proper quoting, duplicates and safe preview', () => {
  const preview = importPreview('\uFEFF公司,岗位名称,备注\r\n"测试,公司",语音算法,"第一行\n第二行 ""引号"""', []);
  assert.deepEqual(preview.errors, []); assert.equal(preview.records.length, 1); assert.equal(preview.records[0].notes, '第一行\n第二行 "引号"');
  const csv = 'company,position,applyTime,stage\n测试公司,语音算法,2026-09-01,已投递';
  assert.equal(importPreview(csv, [normalize({ ...base, url: '' })]).skipped, 1);
  assert(importPreview('company,position,unknown\nx,y,z', []).errors.length);
  assert(importPreview('company,company,position\nx,y,z', []).errors.length);
  assert(importPreview('company,position\n"broken,x', []).errors.length);
  const distinct = importPreview('id,company,position\na,公司,算法\nb,公司,算法', []);
  assert.equal(distinct.records.length, 2);
  assert(importPreview('id,company,position\na,公司,算法\na,另一公司,算法', []).errors.length);
});
test('loopback API, durable revisions, confirmation, import and disabled AI', async () => {
  const testRoot = join(root, '.test-runs'); mkdirSync(testRoot, { recursive: true });
  const dataDir = mkdtempSync(join(testRoot, 'run-'));
  const server = createServer({ dataDir }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, extras = {}) => fetch(origin + path, { ...extras, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Request': '1', ...extras.headers }, body: JSON.stringify(body) }) });
  try {
    assert.deepEqual((await (await request('/api/state')).json()).records, []);
    assert.equal((await request('/api/records', { record: base, baseRevision: 0 }, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const invalidHost = await new Promise((resolve, reject) => {
      const req = httpRequest(`${origin}/api/state`, { headers: { Host: 'evil.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(invalidHost, 403);
    assert.equal((await request('/api/records', { record: base, baseRevision: 0 }, { headers: { 'X-Tracker-Request': '0' } })).status, 403);
    const first = await (await request('/api/records', { record: base, baseRevision: 0 })).json();
    assert.equal(first.revision, 1); assert.equal(first.records.length, 1);
    const original = readFileSync(join(dataDir, 'revision-1.json'), 'utf8');
    const record = { ...first.records[0], screening: '通过' };
    assert.equal((await request('/api/records', { record, baseRevision: 1 })).status, 400);
    assert.equal((await request('/api/records', { record, baseRevision: 0, confirmed: true })).status, 409);
    const second = await (await request('/api/records', { record, baseRevision: 1, confirmed: true })).json();
    assert.equal(second.revision, 2); assert.equal(second.records[0].history.length, 2);
    assert.equal(readFileSync(join(dataDir, 'revision-1.json'), 'utf8'), original);
    assert.equal((await request('/api/records', undefined, { method: 'DELETE' })).status, 405);
    assert.equal((await request('/data/tracker/revision-1.json')).status, 404);
    assert.equal((await request('/api/ai/preview', { consent: true, model: 'anything', text: 'test' })).status, 403);
    const csv = await (await request('/api/export')).text();
    const preview = await (await request('/api/import-preview', { csv })).json();
    assert.equal(preview.skipped, 1); assert.deepEqual(preview.errors, []);
    const invalid = 'company,position,applyTime,stage\n测试公司,多模态,2026-02-30,已投递';
    assert.equal((await request('/api/import', { csv: invalid, baseRevision: 2, confirmed: true })).status, 400);
    assert.equal(readdirSync(dataDir).length, 2);
    const formula = 'company,position,notes\n另一公司,多模态,=SUM(1)';
    assert.equal((await request('/api/import', { csv: formula, baseRevision: 2, confirmed: true })).status, 200);
    assert.match(await (await request('/api/export')).text(), /'=SUM\(1\)/);
    assert.equal((await request('/api/refresh/tasks')).status, 403);
    await announce(origin);
    const started = await (await request('/api/refresh/start', { baseRevision: 3 })).json();
    assert.equal(started.batch.tasks.length, 1);
    const pair = await (await request('/api/pairing')).json();
    const extension = { headers: { Authorization: `Bearer ${pair.token}`, Origin: 'chrome-extension://test' } };
    assert.equal((await request('/api/refresh/result', { batchId: started.batch.id, id: record.id, url: base.url, text: '语音算法\n当前状态：二面中' }, extension)).status, 200);
    assert.equal((await (await request('/api/state')).json()).records[0].stage, '已投递');
    assert.equal((await request('/api/refresh/apply', { batchId: started.batch.id })).status, 400);
    const applied = await (await request('/api/refresh/apply', { batchId: started.batch.id, confirmed: true })).json();
    assert.equal(applied.records[0].stage, '二面'); assert(applied.records[0].lastCheckedAt);
    assert.equal((await request('/api/refresh/apply', { batchId: started.batch.id, confirmed: true })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
  const restored = createServer({ dataDir }); restored.listen(0, '127.0.0.1'); await once(restored, 'listening');
  try { assert.equal((await (await fetch(`http://127.0.0.1:${restored.address().port}/api/state`)).json()).records.length, 2); } finally { await new Promise(resolve => restored.close(resolve)); }
});

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKqsAAAAASUVORK5CYII=';
const config = { baseUrl: 'https://api.example.com/v1', apiKey: 'test-only', model: 'gpt-5.6-sol', enabled: true };
const fakeReply = value => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 });
test('AI image protocol, explicit consent, validation and no key in output', async () => {
  let calls = 0;
  const mock = async (url, options) => {
    calls++; assert.equal(url, `${config.baseUrl}/chat/completions`); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); assert.equal(body.model, 'gpt-5.6-sol'); assert.equal(body.messages[1].content[1].type, 'image_url');
    return fakeReply({ position: base.position, stage: '二面', screening: null, evidence: '二面已安排', confidence: 'high' });
  };
  await assert.rejects(recognizeImage({ ...config, enabled: false }, base, png, mock)); assert.equal(calls, 0);
  await assert.rejects(analyze(config, { text: 'test', consent: false }, mock)); assert.equal(calls, 0);
  const result = await recognizeImage(config, base, png, mock); assert.equal(result.candidate.stage, '二面');
  await assert.rejects(recognizeImage(config, base, png, async () => fakeReply({ position: base.position, stage: '已结束', screening: '未通过', evidence: '流程结束', confidence: 'high' })));
  await assert.rejects(recognizeImage(config, base, png, async () => fakeReply({ position: '其他岗位', stage: 'Offer', evidence: '录用', confidence: 'high' })));
  await assert.rejects(recognizeImage(config, base, png, async () => fakeReply({ position: base.position, stage: '二面', evidence: '二面', confidence: 'low' })));
  await assert.rejects(recognizeImage(config, base, 'data:image/png;base64,dGVzdA==', mock));
});

test('model catalog drives the right API shape for Claude and Gemini', async () => {
  assert.equal(apiForModel('claude-opus-5'), 'anthropic');
  assert.equal(apiForModel('gemini-3.8-flash'), 'openai');
  assert.equal(apiForModel('gpt-5.6-sol'), 'openai');
  assert(MODEL_CATALOG.some(m => m.id === 'claude-opus-5') && MODEL_CATALOG.some(m => m.id === 'gemini-3.8-flash'));
  // Anthropic-format request must hit /messages with x-api-key and a base64 image source.
  const claude = { ...config, model: 'claude-opus-5' };
  let seen = null;
  await recognizeImage(claude, base, png, async (url, options) => {
    seen = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ position: base.position, stage: '二面', screening: null, evidence: '二面已安排', confidence: 'high' }) }] }), { status: 200 });
  });
  assert.equal(seen.url, `${claude.baseUrl}/messages`);
  assert.equal(seen.headers['x-api-key'], claude.apiKey);
  assert.equal(seen.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen.body.model, 'claude-opus-5');
  assert.equal(seen.body.messages[0].content[1].type, 'image');
  assert.equal(seen.body.messages[0].content[1].source.type, 'base64');
  // OpenAI-format model keeps using chat/completions with Bearer.
  const gemini = { ...config, model: 'gemini-3.8-flash' };
  await recognizeImage(gemini, base, png, async (url, options) => {
    assert.equal(url, `${gemini.baseUrl}/chat/completions`);
    assert.equal(options.headers.Authorization, `Bearer ${gemini.apiKey}`);
    return fakeReply({ position: base.position, stage: '二面', screening: null, evidence: '二面已安排', confidence: 'high' });
  });
});

test('batch refresh all submitted records, AI fallback only on rule failure, preserve failures', async () => {
  const testRoot = join(root, '.test-runs'); mkdirSync(testRoot, { recursive: true });
  const dataDir = mkdtempSync(join(testRoot, 'batch-')); let calls = 0;
  const server = createServer({ dataDir, aiConfig: config, fetchAI: async () => { calls++; return fakeReply({ position: '多模态算法', stage: '二面', screening: null, evidence: '二面已安排', confidence: 'high' }); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, body, token) => {
    const response = await fetch(origin + path, { headers: { 'Content-Type': 'application/json', 'X-Tracker-Request': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  try {
    for (const [i, extra] of [{}, { position: '多模态算法' }, { position: '视觉算法', url: '' }].entries()) assert.equal((await req('/api/records', { record: { ...base, ...extra }, baseRevision: i })).status, 200);
    let state = (await req('/api/state')).data; assert(!JSON.stringify(state).includes(config.apiKey));
    const token = (await req('/api/pairing')).data.token;
    await announce(origin);
    const batch = (await req('/api/refresh/start', { baseRevision: 3, allowAI: true })).data.batch;
    assert.equal(batch.tasks.length, 3); assert.equal(batch.tasks[2].status, 'failed');
    assert.equal((await req('/api/refresh/start', { baseRevision: 3 })).status, 400);
    const result = (id, text) => req('/api/refresh/result', { batchId: batch.id, id, text, url: base.url }, token);
    await result(state.records[0].id, '语音算法\n简历筛选通过'); assert.equal(calls, 0);
    assert.equal((await result(state.records[1].id, '多模态算法\n下一轮已安排')).data.needsAI, true);
    assert.equal((await req('/api/refresh/apply', { batchId: batch.id, confirmed: true })).status, 400);
    assert.equal((await req('/api/refresh/image', { batchId: batch.id, id: state.records[1].id, url: base.url, image: png }, token)).status, 200); assert.equal(calls, 1);
    assert.equal((await req('/api/state')).data.records[1].stage, '已投递');
    state = (await req('/api/refresh/apply', { batchId: batch.id, confirmed: true })).data;
    assert.equal(state.records[0].screening, '通过'); assert.equal(state.records[1].stage, '二面'); assert.equal(state.records[1].screening, '待反馈');
    assert.equal(state.records[2].lastCheckedAt, ''); assert.equal(state.records[2].history.length, 1);
    const stale = (await req('/api/refresh/start', { baseRevision: 4 })).data.batch;
    await req('/api/records', { record: { ...state.records[0], notes: '新的手动备注' }, baseRevision: 4, confirmed: true });
    await req('/api/refresh/cancel', { batchId: stale.id });
    assert.equal((await req('/api/refresh/apply', { batchId: stale.id, confirmed: true })).status, 409);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('calendar validates real dates, same-day time ranges and all-day appointments', () => {
  const event = { title: '算法岗一面', date: '2026-09-30', startTime: '09:30', endTime: '10:30', kind: '面试', status: '待进行' };
  assert.equal(normalizeEvent(event).startTime, '09:30');
  for (const patch of [{ date: '2026-02-29' }, { date: '2026-09-31' }, { startTime: '24:00' }, { startTime: '' }, { endTime: '09:00' }, { endTime: '09:30' }, { allDay: true }, { title: '' }, { status: '已删除' }]) assert.throws(() => normalizeEvent({ ...event, ...patch }));
  assert.equal(normalizeEvent({ title: '笔试时间待定', date: '2028-02-29', kind: '笔试', allDay: true }).allDay, true);
  assert.equal(normalizeEvent({ ...event, endTime: '' }).endTime, '');
});

test('legacy arrangements appear without migration and converted appointments do not duplicate', () => {
  const record = { ...normalize(base), id: 'old-record', nextDate: '2026-10-01', nextAction: '预约笔试', stage: '笔试' };
  const copy = structuredClone(record);
  const initial = scheduledEvents([record]);
  assert.equal(initial.length, 1); assert.equal(initial[0].date, '2026-10-01'); assert.equal(initial[0].allDay, true);
  assert.equal(initial[0].legacyKey, legacyEventKey(record)); assert.deepEqual(record, copy);
  const edited = { ...initial[0], id: 'event-1', date: '2026-10-02', startTime: '14:00', allDay: false, legacy: false };
  assert.deepEqual(scheduledEvents([record], [edited]), [edited]);
  const future = { ...record, nextDate: '2026-10-05', nextAction: '等待二面' };
  assert.equal(scheduledEvents([future], [edited]).length, 2);
});

test('calendar persists several rounds independently and preserves them across record updates and imports', async () => {
  const testRoot = join(root, '.test-runs'); mkdirSync(testRoot, { recursive: true });
  const dataDir = mkdtempSync(join(testRoot, 'calendar-'));
  let server = createServer({ dataDir }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body) => {
    const response = await fetch(origin + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Request': '1' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    let state = (await request('/api/records', { record: { ...base, nextDate: '2026-09-10', nextAction: '笔试安排' }, baseRevision: 0 })).data;
    const record = structuredClone(state.records[0]);
    assert.deepEqual(state.events, []);
    const oldSnapshot = readFileSync(join(dataDir, 'revision-1.json'), 'utf8');
    const event = { recordId: record.id, title: '算法笔试', date: '2026-09-10', startTime: '10:00', endTime: '11:00', kind: '笔试', legacyKey: legacyEventKey(record) };
    assert.equal((await request('/api/events', { event: { ...event, recordId: 'missing' }, baseRevision: 1 })).status, 400);
    state = (await request('/api/events', { event, baseRevision: 1 })).data;
    assert.equal(state.events.length, 1); assert.deepEqual(state.records[0], record);
    assert.equal(scheduledEvents(state.records, state.events).length, 1);
    assert.equal(readFileSync(join(dataDir, 'revision-1.json'), 'utf8'), oldSnapshot);
    assert.equal((await request('/api/events', { event, baseRevision: 2 })).status, 400);
    const first = state.events[0];
    assert.equal((await request('/api/events', { event: { ...first, status: '已完成' }, baseRevision: 2 })).status, 400);
    state = (await request('/api/events', { event: { ...first, status: '已完成' }, baseRevision: 2, confirmed: true })).data;
    assert.equal(state.events[0].history.length, 2);
    state = (await request('/api/events', { event: { recordId: record.id, title: '算法一面', date: '2026-09-12', startTime: '14:00', kind: '面试' }, baseRevision: 3 })).data;
    state = (await request('/api/events', { event: { recordId: record.id, title: '算法二面', date: '2026-09-15', allDay: true, kind: '面试' }, baseRevision: 4 })).data;
    assert.equal(state.events.length, 3); assert.equal(new Set(state.events.map(e => e.id)).size, 3);
    const events = structuredClone(state.events);
    state = (await request('/api/records', { record: { ...record, stage: '一面' }, baseRevision: 5, confirmed: true })).data;
    assert.deepEqual(state.events, events);
    assert.equal((await request('/api/events', { event: { ...first, date: '2026-09-20' }, baseRevision: 5, confirmed: true })).status, 409);
    state = (await request('/api/import', { csv: 'company,position\n另一公司,多模态', baseRevision: 6, confirmed: true })).data;
    assert.deepEqual(state.events, events);
    await announce(origin);
    const batch = (await request('/api/refresh/start', { baseRevision: 7 })).data.batch;
    const pair = (await request('/api/pairing')).data;
    await fetch(origin + '/api/refresh/result', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Request': '1', Authorization: `Bearer ${pair.token}` }, body: JSON.stringify({ batchId: batch.id, id: record.id, url: record.url, text: '语音算法\n当前状态：二面中' }) });
    state = (await request('/api/refresh/apply', { batchId: batch.id, confirmed: true })).data;
    assert.deepEqual(state.events, events); assert.equal(state.records[0].stage, '二面');
    assert.equal((await fetch(origin + '/api/events', { method: 'DELETE' })).status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); }
  server = createServer({ dataDir }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  try { const state = (await request('/api/state')).data; assert.equal(state.events.length, 3); assert.equal(state.events[0].status, '已完成'); } finally { await new Promise(resolve => server.close(resolve)); }
});

test('whole-page screenshots keep aspect ratio and never exceed 800px', async () => {
  assert.deepEqual(fitImage(1600, 900), { width: 800, height: 450 });
  assert.deepEqual(fitImage(1600, 4000), { width: 320, height: 800 });
  assert.deepEqual(fitImage(400, 300), { width: 400, height: 300 });
  assert.throws(() => fitImage(0, 10));
  const oversized = Buffer.from(png.split(',')[1], 'base64'); oversized.writeUInt32BE(801, 16);
  let calls = 0;
  await assert.rejects(recognizeImage(config, base, `data:image/png;base64,${oversized.toString('base64')}`, async () => { calls++; }));
  assert.equal(calls, 0);
});

test('stable fingerprint is insensitive to timestamps but sensitive to job count', async () => {
  const url = 'https://iwhalecloud1.zhiye.com/personal/deliveryRecord';
  const header = '已完成的投递（1）算法工程师（图像算法）-广州-2027届秋招(J18074)当前进度：笔试-未处理';
  const a = await stableFingerprint(url, [`${header} 测评已完成 2026-09-03 15:38 投递`]);
  const b = await stableFingerprint(url, [`${header} 测评已完成 2026-09-03 15:39 投递`]);
  assert.equal(a, b);
  assert.notEqual(await stableFingerprint(url, [header]), await stableFingerprint(url, [`${header} 多模态算法Offer`]));
  assert.notEqual(await stableFingerprint(url + '/x', [header]), await stableFingerprint(url, [header]));
});

test('whole-page AI extracts multiple positions without inventing dates or rejection', async () => {
  const applications = [
    { index: 0, applied: true, confidence: 'high', company: '测试企业', position: '语音算法', applyTime: '', stage: '已投递', screening: '待反馈', evidence: '语音算法 已投递' },
    { index: 0, applied: true, confidence: 'high', company: '测试企业', position: '多模态算法', applyTime: '', stage: '面试中', screening: '待反馈', evidence: '多模态算法 面试中' }
  ];
  const input = { url: 'https://app.mokahr.com/campus-recruitment/test/#/applications', company: '', cards: [{ text: '我的投递', image: png, group: true }] };
  const result = await extractApplications(config, input, async (_, options) => { const body = JSON.parse(options.body); assert.equal(body.messages[1].content.at(-1).type, 'image_url'); return fakeReply({ applications }); });
  assert.equal(result.rows.length, 2); assert.equal(result.rows[0].record.company, '测试企业'); assert.equal(result.rows[0].record.applyTime, ''); assert.equal(result.rows[1].record.screening, '待反馈');
  assert.equal(new Set(result.rows.map(row => row.index)).size, 2);
  const refused = await extractApplications(config, input, async () => fakeReply({ applications: [{ ...applications[0], stage: '已结束', screening: '未通过', evidence: '流程结束' }] }));
  assert.equal(refused.rows.length, 0);
});

test('record page trusts listed items but rejects invented dates and rejection', async () => {
  // A "my applications" page lists applied jobs; evidence need not repeat 已投递.
  const input = { url: 'https://iwhalecloud1.zhiye.com/personal/deliveryRecord', company: '', recordPage: true, title: '投递记录', cards: [{ text: '投递记录', image: png, group: true }] };
  const good = await extractApplications(config, input, async () => fakeReply({ applications: [
    { index: 0, applied: true, confidence: 'high', company: '', position: '算法工程师', applyTime: '2026-09-03', stage: '笔试', screening: '待反馈', evidence: '当前进度：笔试-未处理' },
    { index: 0, applied: true, confidence: 'high', company: '', position: '多模态算法工程师', applyTime: '', stage: '面试中', screening: '通过', evidence: '当前进度：面试中；简历筛选通过' }
  ] }));
  assert.equal(good.rows.length, 2); assert.deepEqual(good.warnings, []);
  assert.equal(good.rows[0].record.stage, '笔试'); assert.equal(good.rows[0].record.screening, '待反馈');
  // No explicit rejection wording => reject the row instead of marking 未通过.
  const bad = await extractApplications(config, input, async () => fakeReply({ applications: [{ index: 0, applied: true, confidence: 'high', company: '', position: '算法工程师', applyTime: '2026-09-03', stage: '已结束', screening: '未通过', evidence: '流程结束' }] }));
  assert.equal(bad.rows.length, 0); assert(bad.warnings.length >= 1);
  // Invalid calendar date must be dropped, not saved as-is.
  const badDate = await extractApplications(config, input, async () => fakeReply({ applications: [{ index: 0, applied: true, confidence: 'high', company: '', position: '算法工程师', applyTime: '2026-02-30', stage: '已投递', screening: '待反馈', evidence: '投递 2026-02-30' }] }));
  assert.equal(badDate.rows.length, 1); assert.equal(badDate.rows[0].record.applyTime, ''); assert(badDate.warnings.some(w => /日期/.test(w)));
});

test('Moka page discovery runs rules then whole-page AI, previews and confirms multiple records', async () => {
  const testRoot = join(root, '.test-runs'); mkdirSync(testRoot, { recursive: true });
  const dataDir = mkdtempSync(join(testRoot, 'pages-')); let calls = 0;
  const source = 'https://app.mokahr.com/campus-recruitment/test/#/applications';
  const responseRows = [
    { index: 0, applied: true, confidence: 'high', company: base.company, position: '语音算法', applyTime: '2026-09-01', stage: '二面', screening: '待反馈', evidence: '语音算法 二面中' },
    { index: 0, applied: true, confidence: 'high', company: base.company, position: '多模态算法', applyTime: '', stage: '已投递', screening: '待反馈', evidence: '多模态算法 已投递' }
  ];
  const server = createServer({ dataDir, aiConfig: { ...config }, fetchAI: async () => { calls++; return fakeReply({ applications: responseRows }); } }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, body, token) => { const response = await fetch(origin + path, { headers: { 'Content-Type': 'application/json', 'X-Tracker-Request': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; };
  try {
    let state = (await req('/api/records', { record: { ...base, url: source, notes: '保留手动备注', nextAction: '联系HR' }, baseRevision: 0 })).data;
    assert.equal((await req('/api/refresh/start', { baseRevision: 1 })).status, 400);
    assert.equal((await req('/api/pages/start', { url: source, company: '', baseRevision: 1 })).status, 400);
    const pair = await announce(origin);
    const job = (await req('/api/pages/start', { url: source, company: '', baseRevision: 1 })).data.job;
    const result = await req('/api/pages/result', { id: job.id, url: source, title: '我的投递', pageText: '我的投递 语音算法 多模态算法', cards: [{ text: '我的投递 语音算法 多模态算法', group: true }] }, pair.token);
    assert.equal(result.data.needsImage, true); assert.equal(calls, 0);
    assert.equal((await req('/api/pages/apply', { id: job.id, rows: [], confirmed: true })).status, 400);
    assert.equal((await req('/api/pages/images', { id: job.id, url: source, image: png }, pair.token)).status, 200); assert.equal(calls, 1);
    const preview = (await req('/api/pages')).data.job; assert.equal(preview.status, 'ready'); assert.equal(preview.rows.length, 2); assert.equal(preview.rows[0].action, 'update'); assert.equal(preview.rows[1].action, 'add');
    assert.equal((await req('/api/state')).data.records.length, 1);
    state = (await req('/api/pages/apply', { id: job.id, rows: preview.rows.map(row => ({ index: row.index, ...row.record })), confirmed: true })).data;
    assert.equal(state.records.length, 2); assert.equal(state.records[0].stage, '二面'); assert.equal(state.records[0].notes, '保留手动备注'); assert.equal(state.records[0].nextAction, '联系HR');
    // A freshly imported row counts as checked, so it is not left as 未核对.
    assert(state.records.every(r => typeof r.lastCheckedAt === 'string' && r.lastCheckedAt.length > 0));
    // After saving, a reset clears the finished job so the dialog does not
    // re-show the previous results on the next open.
    const reset = (await req('/api/pages/reset', { baseRevision: state.revision })).data;
    assert.equal(reset.job, null);
    const diagnostic = (await req('/api/diagnostics')).data; assert(diagnostic.events.some(item => item.route === '/api/pages/apply')); assert(!JSON.stringify(diagnostic).includes(config.apiKey));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('browser acceptance keeps AI disabled until guard checks and image test pass', async () => {
  const testRoot = join(root, '.test-runs'); mkdirSync(testRoot, { recursive: true });
  const dataDir = mkdtempSync(join(testRoot, 'acceptance-')); const settings = { ...config, enabled: false }; let calls = 0;
  const server = createServer({ dataDir, aiConfig: settings, fetchAI: async () => { calls++; return fakeReply({ position: '浏览器自检岗位', stage: '二面', screening: null, evidence: '当前状态：二面中', confidence: 'high' }); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, body, token) => { const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Request': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  try {
    const pair = await announce(origin);
    assert.equal((await req('/api/bridge/self-test/start', { confirmed: false })).status, 400);
    let test = (await req('/api/bridge/self-test/start', { confirmed: true })).data.selfTest;
    await req('/api/bridge/self-test/result', { id: test.id, checks: {}, image: png }, pair.token); assert.equal(settings.enabled, false); assert.equal(calls, 0);
    test = (await req('/api/bridge/self-test/start', { confirmed: true })).data.selfTest;
    const result = await req('/api/bridge/self-test/result', { id: test.id, checks: { matched: true, duplicateBlocked: true, loginBlocked: true, stable: true, detached: true }, image: png }, pair.token);
    assert.equal(result.data.ok, true); assert.equal(calls, 1); assert.equal(settings.enabled, true);
    assert(readdirSync(dataDir).some(name => name.startsWith('acceptance-')));
    assert.equal((await (await fetch(origin + '/api/state')).json()).records.length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('company preferences group together; deleting one keeps the others and snapshots', async () => {
  const testRoot = join(root, '.test-runs'); mkdirSync(testRoot, { recursive: true });
  const dataDir = mkdtempSync(join(testRoot, 'prefs-'));
  const server = createServer({ dataDir }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, body) => { const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Request': '1' }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  try {
    let state = (await req('/api/records', { record: { ...base, company: '虎牙直播', rank: '第1志愿', position: '多模态视频生成算法工程师', applyTime: '2026-09-07' }, baseRevision: 0 })).data;
    state = (await req('/api/records', { record: { ...base, company: '虎牙直播', rank: '第2志愿', position: 'AIGC语音大模型算法工程师', applyTime: '2026-09-07' }, baseRevision: 1 })).data;
    state = (await req('/api/records', { record: { ...base, company: '浩鲸科技', rank: '第1志愿', position: '算法工程师（图像算法）', applyTime: '2026-09-03' }, baseRevision: 2 })).data;
    assert.equal(state.records.length, 3);
    assert.equal(state.records.filter(r => r.company === '虎牙直播').length, 2);
    assert.equal(state.records.find(r => r.company === '虎牙直播' && r.rank === '第1志愿').position, '多模态视频生成算法工程师');
    const first = state.records.find(r => r.company === '虎牙直播' && r.rank === '第1志愿').id;
    // Unsafe/unknown rows: 人才计划 rank must be accepted too.
    state = (await req('/api/records', { record: { ...base, company: '某研究院', rank: '人才计划', position: '研究算法工程师' }, baseRevision: 3 })).data;
    assert.equal(state.records.find(r => r.company === '某研究院').rank, '人才计划');
    assert.equal((await req('/api/records/delete', { id: first, baseRevision: 4 })).status, 400);
    const revisionBefore = state.revision;
    state = (await req('/api/records/delete', { id: first, baseRevision: revisionBefore, confirmed: true })).data;
    assert.equal(state.records.length, 3);
    assert(state.records.some(r => r.company === '虎牙直播' && r.rank === '第2志愿'));
    assert(!state.records.some(r => r.id === first));
    assert(readdirSync(dataDir).filter(n => /^revision-\d+\.json$/.test(n)).length >= 5);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
