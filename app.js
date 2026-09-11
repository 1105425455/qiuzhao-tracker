import { STAGES, SCREENINGS, DIRECTIONS, RANKS, FIELDS, normalize } from './model.mjs';
import { scheduledEvents } from './calendar.mjs';
import { setupCalendar } from './calendar-ui.mjs';
import { browserBridge } from './bridge.mjs';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = new Date().toLocaleDateString('en-CA');
const UI_VERSION = '2026-09-10.16';
let state = { records: [], events: [], revision: 0 }, view = 'all', csv = '', batch = null, toastTimer, polling = null, pageJob = null, pagePolling = null, pageRendered = '', diagnosticPolling = null, batchRunning = false;
const icons = () => window.lucide?.createIcons();
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
async function api(path, body) {
  const response = await fetch(path, { signal: AbortSignal.timeout(path.includes('/ai/') ? 50000 : 15000), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Request': '1' }, body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error((result.error || '本地服务暂时不可用') + (result.requestId ? ` [${result.requestId}]` : '')); return result;
}
function options(id, values) { $(id).insertAdjacentHTML('beforeend', values.map(v => `<option>${esc(v)}</option>`).join('')); }
const calendarUI = setupCalendar({ getState: () => state, notify: toast, save: async event => { state = await api('/api/events', { event, baseRevision: state.revision, confirmed: !!event.id }); render(); } });
for (const [id, values] of [['directionFilter', DIRECTIONS], ['stageFilter', STAGES], ['screenFilter', SCREENINGS], ['formDirection', DIRECTIONS], ['formStage', STAGES], ['formScreening', SCREENINGS], ['formRank', RANKS]]) options(id, values);
$('formRank').insertAdjacentHTML('afterbegin', '<option value="">未标注</option>');
$('seasonYear').textContent = new Date().getFullYear();
$('sortDir').dataset.dir = 'desc';
$('today').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
const STAGE_ORDER = { '待投递': 0, '已投递': 1, '笔试': 2, '面试中': 3, '一面': 4, '二面': 5, '终面': 6, 'Offer': 7, '已结束': 8, '已撤回': 9 };
const SCREEN_ORDER = { '未投递': 0, '待反馈': 1, '通过': 2, '未通过': 3 };
// Group headings shown above the list, in a fixed, easy-to-scan order.
const STAGE_GROUPS = ['面试中', '一面', '二面', '终面', 'Offer', '笔试', '已投递', '待投递', '已结束', '已撤回'];
const sortDir = () => ($('sortDir').dataset.dir === 'asc' ? 1 : -1);
function sortRecords(records) {
  const field = $('sortOrder').value;
  const dir = sortDir();
  const rank = r => rankValue(r.rank);
  const byRank = (a, b) => rank(a) - rank(b) || a.company.localeCompare(b.company, 'zh-CN');
  const comparators = {
    updated: (a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''),
    applied: (a, b) => (a.applyTime || '').localeCompare(b.applyTime || ''),
    company: (a, b) => a.company.localeCompare(b.company, 'zh-CN'),
    stage: (a, b) => (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9),
    // Empty check time sorts first when ascending ("never checked" on top).
    checked: (a, b) => (a.lastCheckedAt || '').localeCompare(b.lastCheckedAt || '')
  };
  const base = comparators[field] || comparators.stage;
  return [...records].sort((a, b) => dir * base(a, b) || byRank(a, b));
}
function filtered() {
  const query = $('search').value.toLowerCase().trim();
  const matched = state.records.filter(r => (!query || [r.company, r.position, r.resumeVersion].join(' ').toLowerCase().includes(query)) && (!$('directionFilter').value || r.direction === $('directionFilter').value) && (!$('stageFilter').value || r.stage === $('stageFilter').value) && (!$('screenFilter').value || r.screening === $('screenFilter').value) && (view !== 'interview' || ['笔试', '面试中', '一面', '二面', '终面'].includes(r.stage)));
  return sortRecords(matched);
}
function badge(value, stage = false) { const type = value === '通过' ? 'pass' : value === '未通过' ? 'fail' : value === '待反馈' ? 'pending' : value === 'Offer' ? 'offer' : stage && !['待投递', '已结束', '已撤回'].includes(value) ? 'stage' : ''; return `<span class="badge ${type}">${esc(value)}</span>`; }
// Keep only the meaningful status phrase from raw page text, dropping repeated
// job titles, counts and dates so the cell stays short.
function rawStatusLine(raw) {
  if (!raw) return '';
  const cleaned = String(raw).replace(/[“”"'「」『』]/g, '').replace(/^\s*[（(]\d+[)）]\s*/, '');
  const parts = cleaned.split(/[；;\n、·|]+/).map(s => s.trim()).filter(Boolean);
  const labelled = parts.map(s => s.match(/(?:当前状态|最新状态|当前进度|进度|状态|阶段)\s*[：:]\s*(.+)$/)).find(Boolean);
  if (labelled) return labelled[1].trim().slice(0, 24);
  const inline = cleaned.match(/(?:当前状态|最新状态|当前进度|进度|状态|阶段)\s*[：:]\s*([^\s，。;；、]+)/);
  if (inline) return inline[1].trim().slice(0, 24);
  const keyword = parts.find(s => /^[\u4e00-\u9fa5A-Za-z0-9-]{1,20}$/.test(s) && /(筛选|初筛|笔试|测评|面试|一面|二面|终面|录用|Offer|流程结束|已结束|待处理|未处理|已完成|待反馈|待面试|待笔试)/.test(s));
  return keyword ? keyword.slice(0, 24) : '';
}
// Pull just the qualifier after a step word, e.g. "笔试-未处理" -> "未处理".
function stageQualifier(raw, stage) {
  if (!raw || !stage || !raw.includes(stage)) return '';
  return raw.slice(raw.indexOf(stage) + stage.length).replace(/^[-–—·\s:：]+/, '').replace(/[（(].*$/, '').trim().slice(0, 12);
}
// A clean status: one badge plus at most one short line. Never repeats itself.
function statusCell(r) {
  const raw = rawStatusLine(r.rawStatus);
  if (r.stage === '待投递') return { badge: badge('待投递', true), note: '' };
  if (r.screening === '未通过') return { badge: badge('简历未通过'), note: '' };
  if (r.screening === '通过' && r.stage === 'Offer') return { badge: badge('Offer', true), note: '' };
  if (r.screening === '通过' && r.stage === '已投递') return { badge: badge('简历通过'), note: '' };
  if (r.screening === '通过') return { badge: badge(r.stage, true), note: '简历通过' };
  if (r.stage === '已投递') {
    const note = /初筛|筛选/.test(raw) ? '' : '简历筛选中';
    return { badge: badge(raw || '简历筛选中'), note };
  }
  const qualifier = stageQualifier(raw, r.stage);
  return { badge: badge(r.stage, true), note: qualifier && qualifier !== r.stage ? qualifier : '' };
}
function rankLabel(rank) { return rank ? `<span class="rank-tag">${esc(rank)}</span>` : ''; }
function rankValue(rank) { const m = /^第(\d+)志愿$/.exec(rank || ''); return rank === '人才计划' ? 0 : m ? Number(m[1]) : 99; }
function companyGroups(records) {
  const map = new Map();
  for (const r of records) { if (!map.has(r.company)) map.set(r.company, []); map.get(r.company).push(r); }
  // Order preferences inside each company: rank number, then date.
  for (const items of map.values()) items.sort((a, b) => rankValue(a.rank) - rankValue(b.rank) || (a.applyTime || '').localeCompare(b.applyTime || ''));
  const groups = [...map.entries()];
  groups.sort(([, a], [, b]) => a[0].company.localeCompare(b[0].company, 'zh-CN'));
  return groups;
}
// Split the filtered list into stage sections (面试中 / 一面 / 笔试 ...) in a fixed
// order, so interview and test items are easy to spot without opening filters.
function stageSections(records) {
  const byStage = new Map();
  for (const r of records) { if (!byStage.has(r.stage)) byStage.set(r.stage, []); byStage.get(r.stage).push(r); }
  const ordered = [...STAGE_GROUPS, ...[...byStage.keys()].filter(s => !STAGE_GROUPS.includes(s))];
  return ordered.filter(stage => byStage.has(stage)).map(stage => [stage, byStage.get(stage)]);
}
function recordCard(company, items) {
  return `
    <article class="company-card">
      <header class="company-card-head">
        <span class="company-initial">${esc(company.slice(0, 1))}</span>
        <h3>${esc(company)}</h3>
        <span class="company-count">${items.length} 个志愿</span>
        ${items[0].url ? `<a class="company-link" href="${esc(items[0].url)}" target="_blank" rel="noopener noreferrer"><i data-lucide="arrow-up-right"></i>官网进度</a>` : ''}
      </header>
      <ul class="pref-list">
        ${items.map(r => { const st = statusCell(r); return `
        <li class="pref-row">
          <div class="pref-main">
            ${r.rank ? `<span class="rank-tag${/^第[1-9]志愿$/.test(r.rank) ? '' : ' alt'}">${esc(r.rank)}</span>` : '<span class="rank-tag empty">—</span>'}
            <div class="pref-title">
              <span class="pref-position">${esc(r.position)}</span>
              ${r.location ? `<span class="pref-where">${esc(r.location)}</span>` : ''}
            </div>
          </div>
          <div class="pref-status">
            ${st.badge}${st.note ? `<span class="pref-note">${esc(st.note)}</span>` : ''}
          </div>
          <div class="pref-date">${r.applyTime ? `<span class="date-value">${esc(r.applyTime)}</span>` : '<span class="muted">—</span>'}</div>
          <div class="pref-checked" title="最近核对时间">${r.lastCheckedAt ? esc(new Date(r.lastCheckedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })) : '<span class="muted">未核对</span>'}</div>
          <div class="row-actions">
            <button class="icon-button" data-check="${esc(r.id)}" title="核对该志愿" aria-label="核对 ${esc(company)} ${esc(r.position)}"><i data-lucide="refresh-cw"></i></button><button class="icon-button" data-edit="${esc(r.id)}" title="更新该志愿" aria-label="更新 ${esc(company)} ${esc(r.position)}"><i data-lucide="pencil"></i></button>
            <button class="icon-button danger" data-delete="${esc(r.id)}" title="删除该志愿" aria-label="删除 ${esc(company)} ${esc(r.position)}"><i data-lucide="trash-2"></i></button>
          </div>
        </li>`; }).join('')}
      </ul>
    </article>`;
}
function render() {
  const records = filtered();
  $('navCount').textContent = state.records.length; $('filteredCount').textContent = records.length; $('tableCount').textContent = `${records.length} 条记录 · ${state.records.length ? new Set(records.map(r => r.company)).size : 0} 家公司`;   $('saveState').textContent = `本地已保存 · 版本 ${state.revision} · 界面 ${UI_VERSION}`;
  $('recordRows').innerHTML = stageSections(records).map(([stage, items]) => `
    <section class="stage-section">
      <h3 class="stage-title">${esc(stage)}<span class="stage-count">${items.length}</span></h3>
      ${companyGroups(items).map(([company, group]) => recordCard(company, group)).join('')}
    </section>`).join('');
  $('emptyState').hidden = records.length > 0; $('emptyTitle').textContent = state.records.length ? '没有匹配的记录' : '还没有投递记录'; $('emptyAdd').hidden = state.records.length > 0;
  const due = scheduledEvents(state.records, state.events).filter(event => event.status === '待进行');
  $('scheduleCount').textContent = `${due.length} 项安排`;
  $('scheduleList').innerHTML = due.length ? due.map(event => {
    const record = state.records.find(record => record.id === event.recordId);
    return `<div class="schedule-row ${event.date < today ? 'overdue' : ''}"><span class="schedule-date">${esc(event.date)}<br>${event.allDay ? '全天 / 待定' : esc(event.startTime + (event.endTime ? ` - ${event.endTime}` : ''))}</span><div><h3>${esc(event.title)}</h3><p>${record ? `${esc(record.company)} · ${esc(record.position)}` : '独立日程'}${event.location ? ` · ${esc(event.location)}` : ''}</p></div>${badge(event.kind)}<button class="icon-button" data-event="${esc(event.id)}" title="编辑日程" aria-label="编辑 ${esc(event.title)}"><i data-lucide="pencil"></i></button></div>`;
  }).join('') : '<div class="empty-state"><h3>暂无后续安排</h3></div>';
  calendarUI.render();
  icons();
}
function setView(next) {
  view = next;
  const scheduling = view === 'interview' || view === 'schedule';
  $('recordsView').hidden = scheduling; $('recordFilters').hidden = scheduling;
  $('scheduleView').hidden = view !== 'schedule'; $('calendarView').hidden = view !== 'interview'; $('syncOpen').hidden = scheduling;
  $('pageOpen').hidden = scheduling; $('newRecord').classList.toggle('primary', scheduling);
  $('newRecord').innerHTML = `<i data-lucide="plus"></i>${scheduling ? '新增日程' : '手动记录'}`;
  $('viewTitle').textContent = { all: '全部记录', interview: '笔试与面试', schedule: '后续安排' }[view] || '全部记录';
  $('viewSubtitle').textContent = scheduling ? '笔试、面试与下一次约定。' : '投递在继续，记录也在继续。';
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  render();
}
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { setView(button.dataset.view); history.replaceState(null, '', button.dataset.view === 'all' ? location.pathname : `#${button.dataset.view}`); });
for (const id of ['search', 'directionFilter', 'stageFilter', 'screenFilter', 'sortOrder']) $(id).addEventListener('input', render);
$('sortDir').onclick = () => {
  const next = $('sortDir').dataset.dir === 'asc' ? 'desc' : 'asc';
  $('sortDir').dataset.dir = next;
  $('sortDirLabel').textContent = next === 'asc' ? '升序' : '降序';
  render();
};
$('resetFilters').onclick = () => { for (const id of ['search', 'directionFilter', 'stageFilter', 'screenFilter']) $(id).value = ''; render(); };
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => $(b.dataset.close).close());
document.addEventListener('click', event => { const button = event.target.closest('[data-edit]'); if (button) openRecord(button.dataset.edit); const check = event.target.closest('[data-check]'); if (check) checkOne(check.dataset.check); const appointment = event.target.closest('[data-event]'); if (appointment) calendarUI.openEvent(appointment.dataset.event); const remove = event.target.closest('[data-delete]'); if (remove) deleteRecord(remove.dataset.delete); });
async function checkOne(id) {
  try {
    const connection = await browserBridge('PING'); if (connection.busy) throw new Error('浏览器已有任务执行中，请稍后再试');
    const result = await api('/api/refresh/start', { baseRevision: state.revision, ids: [id] }); batch = result.batch; await browserBridge('RUN'); toast('已在后台核对该志愿');
    const watch = setInterval(async () => {
      try {
        const { batch: latest } = await api('/api/refresh'); batch = latest;
        const running = (latest?.tasks || []).some(t => ['queued', 'needs-image', 'ai-running'].includes(t.status));
        if (!running) { clearInterval(watch); state = await api('/api/state'); render(); const task = latest?.tasks?.[0]; toast(task?.status === 'failed' ? `核对未完成：${task.message}` : '核对已完成，时间已更新'); }
      } catch { clearInterval(watch); }
    }, 2500);
  } catch (error) { toast(error.message); }
}
async function deleteRecord(id) {
  const record = state.records.find(r => r.id === id);
  if (!record) return;
  if (!confirm(`确认删除「${record.company} · ${record.position}」这条记录？\n\n会写入新的历史版本快照，仍可从 data/tracker/revision-*.json 找回。不会删除该公司的其他志愿。`)) return;
  try { state = await api('/api/records/delete', { id, baseRevision: state.revision, confirmed: true }); render(); toast('记录已删除，快照仍保留'); } catch (error) { toast(error.message); }
}
function openRecord(id = '') {
  const form = $('recordForm'); form.reset(); $('recordError').textContent = '';
  const record = state.records.find(r => r.id === id);
  if (record) for (const field of FIELDS) if (form.elements.namedItem(field)) form.elements.namedItem(field).value = record[field] || '';
  $('recordTitle').textContent = record ? '更新投递步骤' : '新增记录'; $('recordSave').textContent = record ? '确认保存更改' : '保存记录';
  $('historySection').hidden = !record?.history?.length;
  $('historyList').innerHTML = (record?.history || []).slice().reverse().map(h => `<li><strong>${esc(h.stage)}</strong> · 简历${esc(h.screening)}<br>${esc(new Date(h.at).toLocaleString('zh-CN'))} · ${esc(h.note)}</li>`).join(''); $('recordDialog').showModal();
}
$('newRecord').onclick = () => ['interview', 'schedule'].includes(view) ? calendarUI.openEvent() : openRecord();
$('emptyAdd').onclick = () => openRecord();
$('formStage').onchange = () => { const fields = $('recordForm').elements; if ($('formStage').value === '待投递') { fields.screening.value = '未投递'; fields.applyTime.value = ''; } else if (fields.screening.value === '未投递') fields.screening.value = '待反馈'; };
$('formScreening').onchange = () => { if ($('formScreening').value === '未通过') $('formStage').value = '已结束'; };
$('recordForm').onsubmit = async event => {
  event.preventDefault(); const formRecord = Object.fromEntries(new FormData(event.target)); const before = state.records.find(r => r.id === formRecord.id); const record = { ...before, ...formRecord }; $('recordError').textContent = '';
  try { normalize(record); $('recordSave').disabled = true; state = await api('/api/records', { record, confirmed: Boolean(record.id), baseRevision: state.revision }); $('recordDialog').close(); render(); toast('步骤已保存'); } catch (error) { $('recordError').textContent = error.message; } finally { $('recordSave').disabled = false; }
};
$('importOpen').onclick = () => { $('csvFile').value = ''; csv = ''; $('importPreview').replaceChildren(); $('importSummary').textContent = '尚未选择文件'; $('importError').textContent = ''; $('importConfirm').disabled = true; $('importDialog').showModal(); };
$('csvFile').onchange = async () => {
  $('importConfirm').disabled = true; $('importError').textContent = ''; $('importPreview').replaceChildren();
  try { const file = $('csvFile').files[0]; if (!file) return; if (file.size > 2_000_000) throw new Error('文件不能超过 2 MB'); csv = await file.text(); const preview = await api('/api/import-preview', { csv }); $('importSummary').textContent = `${file.name} · 可新增 ${preview.records.length} 条 · 重复 ${preview.skipped} 条 · 错误 ${preview.errors.length} 条`; $('importPreview').innerHTML = `<div class="table-wrap"><table><thead><tr><th>公司</th><th>岗位</th><th>步骤</th></tr></thead><tbody>${preview.records.slice(0, 10).map(r => `<tr><td>${esc(r.company)}</td><td>${esc(r.position)}</td><td>${esc(r.stage)}</td></tr>`).join('')}</tbody></table></div>`; $('importError').textContent = preview.errors.slice(0, 20).join('\n'); $('importConfirm').disabled = Boolean(preview.errors.length || !preview.records.length); } catch (error) { $('importError').textContent = error.message; }
};
$('importConfirm').onclick = async () => { $('importConfirm').disabled = true; try { state = await api('/api/import', { csv, baseRevision: state.revision, confirmed: true }); $('importDialog').close(); render(); toast('已新增记录，原台账未覆盖'); } catch (error) { $('importError').textContent = error.message; } finally { $('importConfirm').disabled = false; } };
function renderBatch() {
  const tasks = batch?.tasks || [], pending = tasks.filter(t => ['queued', 'needs-image', 'ai-running'].includes(t.status)).length, changed = tasks.filter(t => t.status === 'changed').length, failed = tasks.filter(t => t.status === 'failed').length, good = tasks.filter(t => ['changed', 'unchanged'].includes(t.status)).length;
  $('batchSummary').textContent = batch ? `共 ${tasks.length} 条 · 等待 ${pending} · 有变化 ${changed} · 未成功 ${failed}${batch.applied ? ' · 已确认更新' : ''}` : '尚未发起核对';
  $('batchHint').textContent = pending ? '浏览器正在执行，规则不确定时自动 AI 兜底。需要登录或无法识别的记录保留原步骤。' : '';
  $('batchRows').innerHTML = tasks.map(t => `<tr><td><strong>${esc(t.company)}</strong><span class="cell-secondary">${esc(t.position)}</span></td><td>${esc(t.before.stage)}<span class="cell-secondary">简历${esc(t.before.screening)}</span></td><td>${t.candidate ? `${badge(t.candidate.stage, true)}<span class="cell-secondary">简历${esc(t.candidate.screening)} · ${esc(t.method)}</span><span class="cell-secondary">${esc(t.evidence)}</span>` : '--'}</td><td><span class="badge ${t.status === 'failed' ? 'fail' : t.status === 'changed' ? 'pass' : ['queued', 'needs-image', 'ai-running'].includes(t.status) ? 'pending' : ''}">${{ queued: '等待采集', 'needs-image': '等待截图', 'ai-running': 'AI 核对中', changed: '有变化', unchanged: '无变化', failed: '保留原记录' }[t.status]}</span><span class="cell-secondary">${esc(t.message)}</span></td></tr>`).join('');
  $('batchApply').disabled = !good || !!pending || !!batch?.applied; $('batchCancel').disabled = !pending; $('batchStart').disabled = pending > 0;
}
async function refreshBatch() { try { ({ batch } = await api('/api/refresh')); renderBatch(); const pending = (batch?.tasks || []).some(t => ['queued', 'needs-image', 'ai-running'].includes(t.status)); if (batch && pending !== batchRunning) { batchRunning = pending; if (!pending) { state = await api('/api/state'); render(); } } } catch (error) { $('syncError').textContent = error.message; } }
$('syncOpen').onclick = () => { $('syncError').textContent = ''; $('batchAIState').textContent = state.aiEnabled ? `${state.aiModel} · 规则不确定时自动使用 800px 整页截图` : '自动 AI 兜底尚未启用，请先在连接设置中完成浏览器自检'; $('syncDialog').showModal(); refreshBatch(); clearInterval(polling); polling = setInterval(() => { if (!document.hidden) refreshBatch(); }, 3000); };
$('syncDialog').addEventListener('close', () => { clearInterval(polling); polling = null; });
$('batchRefresh').onclick = refreshBatch;
$('batchStart').onclick = async () => {
  $('syncError').textContent = ''; $('batchStart').disabled = true; $('batchHint').textContent = '正在连接浏览器…'; let started = false;
  try { const connection = await browserBridge('PING'); if (connection.busy) throw new Error('已有浏览器任务执行中，请稍后再试'); ({ batch } = await api('/api/refresh/start', { baseRevision: state.revision })); started = true; await browserBridge('RUN'); renderBatch(); toast('浏览器已开始核对全部记录'); }
  catch (error) { if (started) await api('/api/refresh/cancel', { batchId: batch.id }).catch(() => {}); $('syncError').textContent = error.message; $('batchHint').textContent = '没有完成更新，原记录未改动'; $('batchStart').disabled = false; toast(error.message); }
};
$('batchCancel').onclick = async () => { try { ({ batch } = await api('/api/refresh/cancel', { batchId: batch.id })); renderBatch(); } catch (error) { $('syncError').textContent = error.message; } };
$('batchApply').onclick = async () => { $('batchApply').disabled = true; try { state = await api('/api/refresh/apply', { batchId: batch.id, confirmed: true }); await refreshBatch(); render(); toast('全部有效结果已更新；失败记录未改动'); } catch (error) { $('syncError').textContent = error.message; renderBatch(); } };
async function diagnostics() {
  try {
    const result = await api('/api/diagnostics');
    $('diagnosticsOutput').textContent = [`服务版本：${result.version}；浏览器：${result.bridge.connected ? '已连接' : '未连接'}`, result.selfTest ? `自检：${result.selfTest.message}` : '', ...result.events.slice(-25).map(item => `${item.at} ${item.method || item.event || ''} ${item.route || ''} ${item.status || ''} ${item.requestId || ''} ${item.durationMs === undefined ? '' : item.durationMs + 'ms'}`)].filter(Boolean).join('\n');
    if (result.selfTest?.status === 'passed') { state = await api('/api/state'); $('aiState').textContent = '规则失败自动 AI 兜底'; $('pairNotice').textContent = result.selfTest.message; clearInterval(diagnosticPolling); }
    if (result.selfTest?.status === 'failed') { $('pairNotice').textContent = result.selfTest.message; clearInterval(diagnosticPolling); }
  } catch (error) { $('diagnosticsOutput').textContent = error.message; }
}
let aiSettings = null;
function fillModels() {
  const catalog = state.models || [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }];
  $('modelPresets').innerHTML = '快捷选择：' + catalog.map(item => `<button type="button" class="preset-chip" data-model="${esc(item.id)}">${esc(item.label)}</button>`).join('');
}
async function loadSettings() {
  $('pairNotice').textContent = '';
  try {
    aiSettings = await api('/api/ai/settings');
    $('aiBaseUrl').value = aiSettings.baseUrl || '';
    $('aiModelInput').value = aiSettings.model || '';
    $('aiFormat').value = aiSettings.apiFormat || 'auto';
    $('aiApiKey').value = '';
    $('aiApiKey').placeholder = aiSettings.hasKey ? '已配置，留空则保持' : '粘贴你的 API Key';
    $('aiState').textContent = `${aiSettings.model} · ${aiSettings.hasKey ? '已配置密钥' : '未配置密钥'} · ${aiSettings.enabled ? '已启用' : '未启用'}`;
    fillModels();
  } catch (error) { $('pairNotice').textContent = error.message; }
}
$('modelPresets').addEventListener('click', event => { const chip = event.target.closest('[data-model]'); if (chip) $('aiModelInput').value = chip.dataset.model; });
$('aiSaveSettings').onclick = async () => {
  $('aiSaveSettings').disabled = true; $('pairNotice').textContent = '';
  try {
    const body = { baseUrl: $('aiBaseUrl').value.trim(), model: $('aiModelInput').value.trim(), apiFormat: $('aiFormat').value, apiKey: $('aiApiKey').value.trim(), confirmed: true };
    aiSettings = await api('/api/ai/settings', body);
    $('aiApiKey').value = ''; $('aiApiKey').placeholder = aiSettings.hasKey ? '已配置，留空则保持' : '粘贴你的 API Key';
    $('aiState').textContent = `${aiSettings.model} · ${aiSettings.hasKey ? '已配置密钥' : '未配置密钥'} · ${aiSettings.enabled ? '已启用' : '未启用'}`;
    state = await api('/api/state'); toast('AI 设置已保存'); diagnostics();
  } catch (error) { $('pairNotice').textContent = error.message; } finally { $('aiSaveSettings').disabled = false; }
};
$('aiTest').onclick = async () => {
  $('aiTest').disabled = true; $('pairNotice').textContent = '正在测试连接…';
  try { const result = await api('/api/ai/test', { confirmed: true }); $('pairNotice').textContent = `连接正常：${result.text}`; }
  catch (error) { $('pairNotice').textContent = error.message; } finally { $('aiTest').disabled = false; }
};
$('settingsOpen').onclick = () => { $('settingsDialog').showModal(); $('aiConsentOnce').checked = state.aiEnabled; loadSettings(); diagnostics(); };
$('diagnosticsRefresh').onclick = diagnostics;
$('connectBrowser').onclick = async () => { $('connectBrowser').disabled = true; $('pairNotice').textContent = '正在连接浏览器…'; try { const info = await api('/api/pairing'); await browserBridge('PAIR', { token: info.token }); $('pairNotice').textContent = '浏览器已连接，之后可在台账中直接点击执行'; await diagnostics(); } catch (error) { $('pairNotice').textContent = error.message; } finally { $('connectBrowser').disabled = false; } };
$('runSelfTest').onclick = async () => {
  $('runSelfTest').disabled = true;
  try { if (!$('aiConsentOnce').checked) throw new Error('请先确认整页截图外发授权'); const connection = await browserBridge('PING'); if (connection.busy) throw new Error('浏览器正在执行任务，请稍后自检'); await api('/api/bridge/self-test/start', { confirmed: true }); await browserBridge('RUN'); $('pairNotice').textContent = '正在检查列表识别、登录保护、截图和 AI 接口…'; clearInterval(diagnosticPolling); diagnosticPolling = setInterval(diagnostics, 2500); }
  catch (error) { $('pairNotice').textContent = error.message; } finally { $('runSelfTest').disabled = false; }
};
$('settingsDialog').addEventListener('close', () => clearInterval(diagnosticPolling));

async function refreshPageJob() {
  try {
    ({ job: pageJob } = await api('/api/pages'));
    if (!pageJob) return;
    $('pageProgress').textContent = pageJob.message;
    $('pageWarnings').textContent = [...(pageJob.warnings || []), ...(pageJob.more ? ['页面还有分页或更多内容，本次不代表全部历史投递。'] : []), ...(pageJob.skipped ? [`跳过 ${pageJob.skipped} 个不适合发送的区域。`] : [])].join('\n');
    const terminal = ['ready', 'failed', 'imported'].includes(pageJob.status);
    if (terminal) { clearInterval(pagePolling); $('pageStart').disabled = false; }
    $('pageApply').disabled = pageJob.status !== 'ready' || !pageJob.rows.some(row => row.action !== 'conflict');
    const key = `${pageJob.id}:${pageJob.status}`;
    if (terminal && pageRendered !== key) {
      pageRendered = key;
      $('pageRows').innerHTML = pageJob.rows.map(row => `<tr data-index="${row.index}"><td><input type="checkbox" data-save ${row.action === 'conflict' ? 'disabled' : 'checked'} aria-label="保存此岗位"></td><td><input data-field="company" value="${esc(row.record.company)}" aria-label="公司"></td><td><input data-field="position" value="${esc(row.record.position)}" aria-label="岗位"><span class="cell-secondary">${esc(row.record.rawStatus)}</span></td><td><input type="date" data-field="applyTime" value="${esc(row.record.applyTime)}" aria-label="投递日期"></td><td><select data-field="stage" aria-label="步骤">${STAGES.filter(s => s !== '待投递').map(s => `<option ${s === row.record.stage ? 'selected' : ''}>${s}</option>`).join('')}</select></td><td><select data-field="screening" aria-label="简历结果">${SCREENINGS.filter(s => s !== '未投递').map(s => `<option ${s === row.record.screening ? 'selected' : ''}>${s}</option>`).join('')}</select></td><td>${{ add: '新增', update: '更新已有', conflict: '身份待核对，不覆盖' }[row.action]}</td></tr>`).join('');
    }
  } catch (error) { $('pageError').textContent = error.message; }
}
$('pageOpen').onclick = async () => {
  $('pageError').textContent = ''; $('pageWarnings').textContent = ''; $('pageProgress').textContent = '尚未开始';
  $('pageRows').replaceChildren(); pageRendered = ''; pageJob = null;
  $('pageDialog').showModal();
  // Clear any finished job on the server so old results never reappear.
  try { const result = await api('/api/pages/reset', { baseRevision: state.revision }); pageJob = result.job; if (pageJob) refreshPageJob(); } catch { /* keep dialog usable */ }
};
$('pageStart').onclick = async () => {
  $('pageStart').disabled = true; $('pageError').textContent = ''; $('pageProgress').textContent = '正在连接浏览器…'; let started = false;
  try { if (!$('pageUrl').value.trim()) throw new Error('请填写已经登录的投递列表 URL'); const connection = await browserBridge('PING'); if (connection.busy) throw new Error('浏览器已有任务执行中，请稍后再试'); ({ job: pageJob } = await api('/api/pages/start', { url: $('pageUrl').value.trim(), company: $('pageCompany').value.trim(), baseRevision: state.revision })); started = true; $('pageRows').replaceChildren(); $('pageWarnings').textContent = ''; pageRendered = ''; await browserBridge('RUN'); $('pageProgress').textContent = '浏览器已开始读取，规则不确定时自动使用整页截图'; clearInterval(pagePolling); pagePolling = setInterval(refreshPageJob, 2000); }
  catch (error) { if (started) await api('/api/pages/cancel', { id: pageJob.id }).catch(() => {}); $('pageError').textContent = error.message; $('pageProgress').textContent = '尚未完成解析，台账未改动'; $('pageStart').disabled = false; }
};
$('pageStop').onclick = async () => { if (pageJob) { await api('/api/pages/cancel', { id: pageJob.id }); await refreshPageJob(); } };
$('pageDialog').addEventListener('close', () => clearInterval(pagePolling));
$('pageApply').onclick = async () => {
  $('pageApply').disabled = true; $('pageError').textContent = '';
  try { const rows = [...$('pageRows').querySelectorAll('tr')].filter(row => row.querySelector('[data-save]').checked && !row.querySelector('[data-save]').disabled).map(row => ({ index: Number(row.dataset.index), ...Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.value])) })); state = await api('/api/pages/apply', { id: pageJob.id, rows, confirmed: true }); render(); $('pageRows').replaceChildren(); pageRendered = ''; pageJob = null; $('pageProgress').textContent = '本次解析已完成，结果已保存'; toast('已保存识别出的投递记录'); } catch (error) { $('pageError').textContent = error.message; $('pageApply').disabled = false; }
};
try { const health = await api('/api/health'); if (health.version !== 4) throw new Error('当前是旧版服务，请使用统一入口 http://127.0.0.1:4319'); state = await api('/api/state'); const initial = (location.hash || '').slice(1); setView(['interview', 'schedule'].includes(initial) ? initial : 'all'); } catch (error) { $('loadError').hidden = false; $('loadError').textContent = `无法载入台账：${error.message}`; $('saveState').textContent = '本地服务不可用或版本不匹配'; for (const id of ['newRecord', 'syncOpen', 'importOpen', 'pageOpen']) $(id).disabled = true; }
icons();
