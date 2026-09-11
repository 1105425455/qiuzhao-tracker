export const STAGES = ['简历筛选中', '笔试', '面试', 'Offer', '已结束', '已撤回'];
export const SCREENINGS = ['待反馈', '通过', '未通过'];
export const DIRECTIONS = ['语音算法', '多模态算法', '图像算法', '大模型算法', '推荐搜索', '通用算法', '其他'];
// Ordered keyword classifier shared by rule parsing and AI extraction.
export function classifyDirection(text) {
  const s = String(text || '');
  if (/多模态|跨模态|图文|视频生成|文生视频|视觉语言|VLM|MLLM/i.test(s)) return '多模态算法';
  if (/语音|音频|声学|声音|TTS|ASR|唤醒|降噪|声纹/i.test(s)) return '语音算法';
  if (/图像|视觉|CV\b|感知|检测|分割|跟踪|人脸|人体|姿态|图像算法|计算机视觉/i.test(s)) return '图像算法';
  if (/大模型|LLM|语言模型|NLP|自然语言|文本|AIGC|智能体|Agent/i.test(s)) return '大模型算法';
  if (/推荐|广告|搜索|召回|排序/i.test(s)) return '推荐搜索';
  if (/算法|机器学习|深度学习|数据挖掘/i.test(s)) return '通用算法';
  return '其他';
}
export const RANKS = ['第1志愿', '第2志愿', '第3志愿', '第4志愿', '人才计划', '其他'];
export const FIELDS = ['id', 'company', 'rank', 'program', 'position', 'direction', 'location', 'applyTime', 'stage', 'screening', 'resumeVersion', 'source', 'url', 'nextAction', 'nextDate', 'notes', 'rawStatus', 'lastCheckedAt', 'sourceUid'];
export const CAPTURE_HOSTS = [''];

export function normalize(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('记录格式不正确');
  const out = {};
  for (const field of FIELDS) {
    const value = record[field] ?? '';
    if (typeof value !== 'string') throw new Error(`${field} 必须是文本`);
    if (value.length > (['notes', 'rawStatus'].includes(field) ? 5000 : 1500)) throw new Error(`${field} 内容过长`);
    out[field] = ['notes', 'rawStatus'].includes(field) ? value : value.trim();
  }
  if (!out.company || !out.position) throw new Error('请填写公司和岗位');
  out.direction ||= '其他';
  out.stage ||= '简历筛选中';
  out.screening ||= '待反馈';
  if (!DIRECTIONS.includes(out.direction) || !STAGES.includes(out.stage) || !SCREENINGS.includes(out.screening)) throw new Error('方向、阶段或筛选结果不在可选范围内');
  if (out.rank && !RANKS.includes(out.rank) && !/^第[1-9]志愿$/.test(out.rank)) throw new Error('志愿标签格式不正确');
  if (out.id && !/^[a-zA-Z0-9_-]{1,100}$/.test(out.id)) throw new Error('记录 ID 格式不正确');
  for (const field of ['applyTime', 'nextDate']) {
    const date = out[field];
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('日期须为有效的 YYYY-MM-DD');
  }
  if (out.url) {
    let url;
    try { url = new URL(out.url); } catch { throw new Error('请填写完整的官网网址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('网址仅支持不含凭证的 HTTP/HTTPS');
    if ([...url.searchParams.keys()].some(key => /token|password|secret|authorization/i.test(key))) throw new Error('网址不能包含登录凭证');
  }
  if (out.sourceUid && !/^[\w.:-]{1,200}$/.test(out.sourceUid)) throw new Error('官网申请编号格式不正确');
  if (out.screening === '未通过' && out.stage !== '已结束') throw new Error('简历未通过的记录，请将阶段设为已结束');
  return out;
}

// Screening outcome. We look INSIDE each status phrase (not for an exact line),
// so real-world wording like "简历初筛-筛选中" or "简历筛选 未通过" still maps.
export function screeningCandidate(text) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const hit = { reject: [], pass: [], pending: [] };
  for (const line of lines) {
    if (!/简历|初筛|筛选|评估/.test(line)) continue;
    // Skip instructional/conditional text such as "如果简历未通过，请继续投递".
    if (/如果|若|如未|一旦|请继续|可继续|将|会|若您|建议/.test(line)) continue;
    // Rejection before anything else; a line saying "未通过" is a rejection.
    if (/未通过|不通过|不合适|不匹配|淘汰|已拒绝|未入选/.test(line)) hit.reject.push(line);
    else if (/通过|合格/.test(line)) hit.pass.push(line);
    else if (/筛选中|评估中|待筛|初筛|筛选|评估|处理中|受理/.test(line)) hit.pending.push(line);
  }
  const evidence = [...hit.reject, ...hit.pass, ...hit.pending].join('\n');
  const groups = [hit.reject.length && '未通过', hit.pass.length && '通过', hit.pending.length && '待反馈'].filter(Boolean);
  return { screening: groups.length === 1 ? groups[0] : null, evidence, ambiguous: groups.length > 1 };
}

export function progressCandidate(text) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const current = lines.filter(s => /(当前状态|最新状态|当前进度|进度|状态)[：:]/.test(s)).map(s => s.replace(/^[^：:]*[：:]\s*/, ''));
  const scope = current.length ? current : lines;
  const screening = screeningCandidate(scope.join('\n'));
  // A step NAME alone (投递简历 / 简历筛选 / 面试 / Offer / 入职) is just a progress
  // bar label, not the current status. Only count a stage when it carries a real
  // state word, and never count a step explicitly marked 已完成/已通过.
  const stagePatterns = [
    ['已撤回', /已撤回|撤销申请|主动撤回/],
    ['已结束', /流程结束|已结束|职位关闭|岗位关闭|招聘结束|已终止|未通过|不合适/],
    ['Offer', /(已?收到|拿到|获得|接受)?\s*(offer|录用|拟录用|offer意向)/i],
    ['面试', /面试(中|邀|安排|进行|待|通知)|一面|二面|三面|终面|复试|初试|总监面|hr面|终试/],
    ['笔试', /笔试[\s\-—·:：]?(中|邀|安排|进行|待|通知|未处理|已完成|完成)?|测评[\s\-—·:：]?(中|邀|进行|已完成|完成)?|在线考试|机考/],
    ['简历筛选中', /已投递|简历投递|投递成功|申请成功|待筛选|筛选中|初筛|评估中|待处理|已申请/]
  ];
  const stages = [];
  for (const value of scope) {
    // Skip lines that describe an already-completed or not-yet-reached step, but a
    // completed 笔试/测评 is a real, current stage — keep those.
    if (/已完成|已通过|未开始|待开始/.test(value) && !/笔试|测评|offer|录用|通过|不通过|未通过/i.test(value)) continue;
    for (const [stage, re] of stagePatterns) {
      if (re.test(value) && !stages.includes(stage)) stages.push(stage);
    }
  }
  // Keep only the most advanced stage when several match a single status line.
  const order = ['已撤回', '已结束', 'Offer', '面试', '笔试', '简历筛选中'];
  const ranked = order.filter(s => stages.includes(s));
  const chosen = ranked.length ? [ranked[0]] : [];
  const ambiguous = screening.ambiguous || (screening.screening === '未通过' && chosen.some(s => s !== '已结束'));
  const candidate = {};
  if (!ambiguous) {
    if (screening.screening) candidate.screening = screening.screening;
    if (chosen.length === 1) candidate.stage = chosen[0];
    if (screening.screening === '未通过') candidate.stage = '已结束';
    // Rejection wording implies the application ended.
    if (!candidate.stage && /已拒绝|未入选/.test(scope.join('\n'))) candidate.stage = '已结束';
    // A screening result implies the application was at least submitted.
    if (!candidate.stage && candidate.screening && candidate.screening !== '未通过') candidate.stage = '简历筛选中';
  }
  const evidence = scope.filter(s => stagePatterns.some(([, re]) => re.test(s)) || /简历|进度|状态|投递/.test(s)).join('\n');
  return { candidate, ambiguous, evidence };
}

// Narrow a whole-page text to the lines that belong to one application, using its
// position (and company as a hint). Returns the surrounding window plus whether a
// distinctive position token was actually found, so callers can tell "no such job
// on this page" apart from "found it but the status is unclear".
function tokens(value) {
  return String(value || '').split(/[\s（）()【】\[\]·・,，、。.:：;；\-—_/\\/]+/).map(t => t.trim()).filter(t => t.length >= 2);
}
export function scopeToPosition(pageText, task) {
  const lines = String(pageText || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const posTokens = [...new Set(tokens(task.position))];
  const companyTokens = [...new Set(tokens(task.company))];
  const compact = value => value.replace(/\s+/g, '');
  const normCompact = compact(task.position);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = compact(lines[i]);
    if (!line) continue;
    const strong = (normCompact.length >= 4 && line.includes(normCompact)) || posTokens.some(t => t.length >= 3 && line.includes(t.replace(/\s+/g, '')));
    const companyHit = companyTokens.some(t => t.length >= 2 && line.includes(t));
    if (strong) hits.push({ i, score: 2 });
    else if (companyHit && posTokens.some(t => t.length >= 2 && line.includes(t))) hits.push({ i, score: 1 });
  }
  if (!hits.length) return { text: lines.join('\n').slice(0, 4000), found: false };
  const best = hits.sort((a, b) => b.score - a.score)[0].i;
  const start = Math.max(0, best - 3);
  let end = Math.min(lines.length, best + 6);
  // Stop at the next line that looks like another job heading, so a neighbouring
  // record's status does not leak into this one's context.
  for (let i = best + 1; i < end; i++) {
    const line = compact(lines[i]);
    if (/工程师|研究员|算法|开发|岗位|\(J\d+\)|（J\d+）|职位/.test(lines[i]) && !line.includes(normCompact)) { end = i; break; }
  }
  return { text: lines.slice(start, end).join('\n'), found: true, line: best };
}
