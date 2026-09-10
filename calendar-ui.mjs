import { EVENT_KINDS, EVENT_STATUSES, normalizeEvent, scheduledEvents } from './calendar.mjs';

export function setupCalendar({ getState, save, notify }) {
  const $ = id => document.getElementById(id);
  const form = $('eventForm');
  let calendar, suggestedTitle = '';
  const today = () => new Date().toLocaleDateString('en-CA');
  const colors = { 笔试: '#b07d2b', 面试: '#3f6fb5', 其他安排: '#4c8a6a' };
  for (const [id, values] of [['eventKind', EVENT_KINDS], ['eventStatus', EVENT_STATUSES], ['eventKindFilter', EVENT_KINDS], ['eventStatusFilter', EVENT_STATUSES]]) {
    for (const value of values) $(id).add(new Option(value, value));
  }
  $('calendarTimezone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const events = () => { const state = getState(); return scheduledEvents(state.records, state.events); };

  function openEvent(id = '', defaults = {}) {
    form.reset(); suggestedTitle = ''; $('eventError').textContent = '';
    const state = getState();
    $('eventRecord').replaceChildren(new Option('独立日程', ''));
    for (const record of state.records) $('eventRecord').add(new Option(`${record.company} · ${record.position}`, record.id));
    const existing = id ? events().find(event => event.id === id) : null;
    if (id && !existing) { notify('日程已变化，请刷新后重试'); return; }
    const value = existing || { date: today(), kind: '面试', status: '待进行', ...defaults };
    for (const name of ['id', 'recordId', 'title', 'kind', 'date', 'startTime', 'endTime', 'location', 'notes', 'status', 'legacyKey']) form.elements.namedItem(name).value = value[name] || '';
    if (existing?.legacy) form.elements.id.value = '';
    $('eventAllDay').checked = !!value.allDay;
    setTimeState();
    $('eventTitle').textContent = existing ? '编辑日程' : '新增日程';
    $('eventSave').textContent = existing ? '确认保存更改' : '保存日程';
    $('eventHistorySection').hidden = !existing?.history?.length;
    $('eventHistory').replaceChildren();
    for (const item of (existing?.history || []).slice().reverse()) {
      const li = document.createElement('li');
      li.textContent = `${new Date(item.at).toLocaleString('zh-CN')} · ${item.date} ${item.allDay ? '全天 / 待定' : item.startTime} · ${item.status}`;
      $('eventHistory').append(li);
    }
    $('eventDialog').showModal();
  }

  function setTimeState() {
    $('eventStart').disabled = $('eventEnd').disabled = $('eventAllDay').checked;
    $('eventStart').required = !$('eventAllDay').checked;
  }
  $('eventAllDay').onchange = setTimeState;
  $('eventRecord').onchange = $('eventKind').onchange = () => {
    const record = getState().records.find(record => record.id === $('eventRecord').value);
    if (record && (!form.elements.title.value.trim() || form.elements.title.value === suggestedTitle)) {
      suggestedTitle = `${record.company} ${$('eventKind').value}`;
      form.elements.title.value = suggestedTitle;
    }
  };
  form.onsubmit = async event => {
    event.preventDefault(); $('eventError').textContent = '';
    try {
      const value = Object.fromEntries(new FormData(form)); value.allDay = $('eventAllDay').checked;
      if (value.allDay) { value.startTime = ''; value.endTime = ''; }
      const clean = normalizeEvent(value);
      $('eventSave').disabled = true;
      await save(clean);
      $('eventDialog').close(); notify('日程已保存');
      if (calendar) calendar.gotoDate(clean.date);
      render();
    } catch (error) { $('eventError').textContent = error.message; } finally { $('eventSave').disabled = false; }
  };

  // Scroll the time grid so the day's first appointment is visible, not a blank
  // stretch of early hours. Runs after the view has actually rendered its rows.
  function scrollToFirstEvent() {
    if (!calendar) return;
    const times = events().filter(e => !e.allDay && e.startTime).map(e => e.startTime).sort();
    const target = (times[0] || '08:00');
    const [h, m] = target.split(':').map(Number);
    const hour = Math.max(7, Math.min(23, h));
    const apply = () => { try { calendar.scrollToTime({ hour, minute: h === hour ? (m || 0) : 0 }); } catch { /* older build */ } };
    requestAnimationFrame(() => { apply(); setTimeout(apply, 80); setTimeout(apply, 240); });
  }

  // Month view grows with content; week view keeps a fixed height and scrolls
  // inside FullCalendar so later hours are reachable.
  function sizeCalendar() {
    if (!calendar) return;
    const week = /timeGrid/.test(calendar.view?.type || '');
    calendar.setOption('height', week ? 640 : 'auto');
    if (week) scrollToFirstEvent();
  }

  function render() {
    if ($('calendarView').hidden) return;
    if (!window.FullCalendar) { $('calendarError').textContent = '日历资源未加载，请刷新页面。'; return; }
    $('calendarError').textContent = '';
    if (!calendar) {
      const wanted = (new URLSearchParams(location.search).get('cal') === 'week') ? 'timeGridWeek' : 'dayGridMonth';
      calendar = new window.FullCalendar.Calendar($('calendar'), {
        initialView: wanted, locale: 'zh-cn', firstDay: 1, timeZone: 'local',
        headerToolbar: false, height: 640, fixedWeekCount: true, dayMaxEvents: 3,
        editable: false, eventStartEditable: false, eventDurationEditable: false,
        nowIndicator: true, allDayText: '全天', slotMinTime: '07:00:00', slotMaxTime: '23:30:00', scrollTime: '08:00:00', slotDuration: '00:30:00',
        eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
        slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
        datesSet: info => {
          $('calendarTitle').textContent = info.view.title;
          if (info.view.type.startsWith('timeGrid')) scrollToFirstEvent();
        },
        viewDidMount: info => { if (info.view.type.startsWith('timeGrid')) scrollToFirstEvent(); },
        dateClick: info => openEvent('', { date: info.dateStr.slice(0, 10), startTime: info.allDay ? '' : info.dateStr.slice(11, 16) }),
        eventClick: info => { info.jsEvent.preventDefault(); openEvent(info.event.id); },
        eventDidMount: info => {
          const value = info.event.extendedProps;
          info.el.title = `${info.event.title} · ${value.kind} · ${value.status}${value.location ? ` · ${value.location}` : ''}`;
        }
      });
      calendar.render();
    }
    const selected = events().filter(event => (!$('eventKindFilter').value || event.kind === $('eventKindFilter').value) && (!$('eventStatusFilter').value || event.status === $('eventStatusFilter').value));
    calendar.batchRendering(() => {
      calendar.removeAllEventSources();
      calendar.addEventSource(selected.map(event => {
        const record = getState().records.find(item => item.id === event.recordId);
        const who = record ? record.company : '';
        return {
          id: event.id, title: event.title, allDay: event.allDay,
          start: event.allDay ? event.date : `${event.date}T${event.startTime}:00`,
          end: !event.allDay && event.endTime ? `${event.date}T${event.endTime}:00` : undefined,
          backgroundColor: colors[event.kind], borderColor: colors[event.kind], textColor: '#ffffff',
          classNames: [event.status === '已取消' ? 'calendar-cancelled' : event.status === '已完成' ? 'calendar-completed' : 'calendar-pending'],
          extendedProps: { kind: event.kind, status: event.status, location: event.location, who }
        };
      }));
    });
    calendar.updateSize();
    sizeCalendar();
  }
  $('calendarPrev').onclick = () => calendar?.prev();
  $('calendarNext').onclick = () => calendar?.next();
  $('calendarToday').onclick = () => calendar?.today();
  $('eventKindFilter').onchange = $('eventStatusFilter').onchange = render;
  document.querySelectorAll('[data-calendar-mode]').forEach(button => button.onclick = () => {
    if (!calendar) return;
    const mode = button.dataset.calendarMode;
    if (calendar.view.type !== mode) calendar.changeView(mode);
    document.querySelectorAll('[data-calendar-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    sizeCalendar();
  });
  return { render, openEvent };
}
