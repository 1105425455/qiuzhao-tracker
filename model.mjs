export const STAGES = ['待投递', '已投递', '笔试', '面试中', '一面', '二面', '终面', 'Offer', '已结束', '已撤回'];
export const SCREENINGS = ['未投递', '待反馈', '通过', '未通过'];
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
  out.stage ||= '待投递';
  out.screening ||= out.stage === '待投递' ? '未投递' : '待反馈';
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
  if (out.stage !== '待投递' && out.screening === '未投递') throw new Error('已投递记录须填写筛选状态；不知道投递日期可以留空');
  if (out.stage === '待投递' && (out.screening !== '未投递' || out.applyTime)) throw new Error('待投递记录不能填写已投递日期或筛选结果');
  if (out.screening === '未通过' && out.stage !== '已结束') throw new Error('简历未通过的记录，请将阶段设为已结束');
  return out;
}

// Only explicit screening labels produce a candidate. Other stages never imply rejection.
export function screeningCandidate(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim());
  const map = new Map([
    ['简历筛选通过', '通过'], ['简历初筛通过', '通过'], ['简历通过', '通过'],
    ['简历筛选未通过', '未通过'], ['简历未通过', '未通过'], ['简历初筛未通过', '未通过'],
    ['简历筛选中', '待反馈'], ['简历评估中', '待反馈'], ['简历待筛选', '待反馈']
  ]);
  const evidence = lines.filter(line => map.has(line));
  const values = [...new Set(evidence.map(line => map.get(line)))];
  return { screening: values.length === 1 ? values[0] : null, evidence: evidence.join('\n'), ambiguous: values.length > 1 };
}

export function progressCandidate(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const current = lines.filter(s => /^(当前状态|最新状态|当前进度|进度)[：:]/.test(s)).map(s => s.replace(/^[^：:]+[：:]\s*/, ''));
  const scope = current.length ? current : lines;
  const screening = screeningCandidate(scope.join('\n'));
  const stageMap = new Map([
    ['投递成功', '已投递'], ['已投递', '已投递'], ['简历筛选中', '已投递'],
    ['待笔试', '笔试'], ['笔试中', '笔试'], ['笔试邀请', '笔试'], ['测评中', '笔试'], ['测评已完成', '笔试'], ['笔试-未处理', '笔试'],
    ['面试中', '面试中'], ['面试邀请', '面试中'],
    ['一面中', '一面'], ['待一面', '一面'], ['一面邀请', '一面'],
    ['二面中', '二面'], ['待二面', '二面'], ['二面邀请', '二面'],
    ['终面中', '终面'], ['终面邀请', '终面'], ['待终面', '终面'],
    ['Offer', 'Offer'], ['OFFER', 'Offer'], ['已录用', 'Offer'], ['录用通知', 'Offer'],
    ['流程结束', '已结束'], ['已结束', '已结束'], ['已撤回', '已撤回']
  ]);
  const stages = [];
  for (const s of scope) {
    if (stageMap.has(s)) {
      const stage = stageMap.get(s); if (!stages.includes(stage)) stages.push(stage);
    } else if (/笔试|测评/.test(s)) {
      if (!stages.includes('笔试')) stages.push('笔试');
    } else if (/(^|[^一])面中|面试/.test(s)) {
      if (!stages.includes('面试中')) stages.push('面试中');
    }
  }
  const ambiguous = screening.ambiguous || stages.length > 1 || (screening.screening === '未通过' && stages.some(s => s !== '已结束'));
  const candidate = {};
  if (!ambiguous) {
    if (screening.screening) candidate.screening = screening.screening;
    if (stages.length === 1) candidate.stage = stages[0];
    if (screening.screening === '未通过') candidate.stage = '已结束';
  }
  const evidence = scope.filter(s => stageMap.has(s) || /笔试|测评|面|投递|简历|录用|Offer|流程|进度/i.test(s) || screening.evidence.split('\n').includes(s)).join('\n');
  return { candidate, ambiguous, evidence };
}
