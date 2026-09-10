export const EVENT_KINDS = ['笔试', '面试', '其他安排'];
export const EVENT_STATUSES = ['待进行', '已完成', '已取消'];

export function normalizeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('日程格式不正确');
  const event = {};
  for (const field of ['id', 'recordId', 'title', 'kind', 'date', 'startTime', 'endTime', 'location', 'notes', 'status', 'legacyKey']) {
    const value = input[field] ?? '';
    if (typeof value !== 'string' || value.length > (field === 'notes' ? 5000 : 1500)) throw new Error('日程字段格式不正确或内容过长');
    event[field] = field === 'notes' ? value : value.trim();
  }
  if (!event.title || event.title.length > 200) throw new Error('请填写日程标题，最多 200 字');
  for (const field of ['id', 'recordId']) if (event[field] && !/^[a-zA-Z0-9_-]{1,100}$/.test(event[field])) throw new Error('日程或关联记录 ID 无效');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date) || !Number.isFinite(Date.parse(event.date)) || new Date(event.date).toISOString().slice(0, 10) !== event.date) throw new Error('请选择有效的日程日期');
  if (input.allDay !== undefined && typeof input.allDay !== 'boolean') throw new Error('全天选项格式不正确');
  event.allDay = input.allDay === true;
  event.kind ||= '面试'; event.status ||= '待进行';
  if (!EVENT_KINDS.includes(event.kind) || !EVENT_STATUSES.includes(event.status)) throw new Error('日程类型或状态无效');
  if (event.allDay && (event.startTime || event.endTime)) throw new Error('全天日程不能同时填写时间');
  if (!event.allDay) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(event.startTime)) throw new Error('请选择开始时间，或勾选全天');
    if (event.endTime && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(event.endTime) || event.endTime <= event.startTime)) throw new Error('结束时间须晚于同一天的开始时间');
  }
  return event;
}

export function legacyEventKey(record) {
  return JSON.stringify([record.id, record.nextDate, record.nextAction]);
}

export function scheduledEvents(records, events = []) {
  const converted = new Set(events.map(event => event.legacyKey).filter(Boolean));
  const old = records.filter(record => record.nextDate && !converted.has(legacyEventKey(record))).map(record => ({
    id: `legacy-${record.id}`, recordId: record.id, title: record.nextAction || `${record.company}后续安排`,
    date: record.nextDate, startTime: '', endTime: '', allDay: true,
    kind: record.stage === '笔试' ? '笔试' : /面/.test(record.stage) ? '面试' : '其他安排',
    status: '待进行', location: '', notes: '', legacy: true, legacyKey: legacyEventKey(record)
  }));
  return [...events, ...old].sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || '') || a.title.localeCompare(b.title, 'zh-CN'));
}
