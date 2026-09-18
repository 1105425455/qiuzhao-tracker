import { scanPage } from './scan.js';
import { scanApplications } from './scan-list.js';
import { resizeScreenshot } from './image.js';
import { captureViewports } from './capture.mjs';
let busy = false, message = '尚未执行核对', runStartedAt = 0;
const VERSION = '0.4.28';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const STALE_MS = 10 * 60 * 1000;
function markRunning() { runStartedAt = Date.now(); busy = true; }
function markIdle() { busy = false; runStartedAt = 0; }
function isStale() { return busy && runStartedAt && Date.now() - runStartedAt > STALE_MS; }
function guard() { if (isStale()) { markIdle(); message = '上次任务超时，已自动复位；请重新执行'; } }
async function closeTab(tabId) {
  if (tabId == null) return;
  try {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await chrome.tabs.remove(tabId);
    for (let retry = 0; retry < 3; retry++) {
      await wait(300);
      try { await chrome.tabs.get(tabId); } catch { return; }
    }
  } catch {}
}
async function connection() {
  const { endpoint, token } = await chrome.storage.local.get(['endpoint', 'token']);
  const base = new URL(endpoint);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.origin !== endpoint || !/^[a-f0-9]{48}$/.test(token)) throw new Error('请在台账连接设置中连接浏览器');
  return { endpoint, api: async (path, body) => {
    const response = await fetch(`${endpoint}${path}`, { signal: AbortSignal.timeout(60000), headers: { 'Content-Type': 'application/json', 'X-Tracker-Request': '1', Authorization: `Bearer ${token}` }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '本地服务不可用'); return result;
  } };
}
const LOGIN_RE = /([?&#]|^|\/)(login|signin|sign-in|signon|sso|passport)([=/?#]|$)/i;
// Known SSO redirect domains that should automatically bounce back
const SSO_REDIRECT_HOSTS = ['tracert.alipay.com', 'login.alibaba-inc.com', 'account.aliyun.com'];
async function visit(tabId, url) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('仅支持 HTTP/HTTPS 招聘投递页，请检查网址');
  if ((await chrome.tabs.get(tabId)).active) throw new Error('采集标签页正在前台使用，停止本条以免打断操作');
  // Navigate with one retry: a rejected or aborted navigation is usually a
  // transient race between concurrent background tabs, not a login problem.
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await chrome.tabs.update(tabId, { url, active: false }); }
    catch (error) { lastError = error?.message || '导航被拒绝'; await wait(600); continue; }
    for (let n = 0; n < 15; n++) { await wait(500); if ((await chrome.tabs.get(tabId)).status === 'complete') break; }
    const actual = await chrome.tabs.get(tabId);
    if (!actual || typeof actual.url !== 'string' || !actual.url) { lastError = '页面地址在加载中丢失'; await wait(600); continue; }
    let placed;
    try { placed = new URL(actual.url); } catch { throw new Error(`页面地址无效：${actual.url}`); }
    console.log(`[visit] 页面加载完成: ${placed.href}`);
    console.log(`[visit] target.origin=${target.origin}, placed.origin=${placed.origin}, placed.hostname=${placed.hostname}`);
    if (LOGIN_RE.test(`${placed.pathname}${placed.search}${placed.hash}`)) throw new Error(`页面要求登录：${placed.origin}${placed.pathname}，请在该浏览器完成登录后重试`);
    // If we landed on a known SSO redirect page, wait for it to bounce back.
    // SSO redirects typically complete automatically via cookies without user
    // interaction; activating the tab could interrupt the user and cause races.
    console.log(`[visit] SSO 检查: placed.origin !== target.origin = ${placed.origin !== target.origin}, SSO_REDIRECT_HOSTS.includes = ${SSO_REDIRECT_HOSTS.includes(placed.hostname)}`);
    if (placed.origin !== target.origin && SSO_REDIRECT_HOSTS.includes(placed.hostname)) {
      console.log(`[visit] SSO 跳转检测到 ${placed.hostname}，等待自动跳回目标站点...`);
      for (let n = 0; n < 40; n++) {
        await wait(750);
        const current = await chrome.tabs.get(tabId);
        if (!current?.url) break;
        try {
          const now = new URL(current.url);
          console.log(`[visit] SSO 等待第 ${n+1} 次检查: ${now.origin}`);
          if (now.origin === target.origin) { placed = now; console.log(`[visit] SSO 跳转完成，已返回 ${target.origin}`); break; }
        } catch {}
      }
      if (placed.origin !== target.origin) {
        console.warn(`[visit] SSO 等待 30 秒后仍在 ${placed.origin}，可能需要手动登录`);
        throw new Error(`页面停留在 SSO 跳转页 ${placed.origin}，请在浏览器手动登录后重试`);
      }
    }
    if (placed.origin !== target.origin) throw new Error(`页面跳到了其他站点：${placed.origin}${placed.pathname}`);
    return placed.href;
  }
  throw new Error(`页面打开失败：${lastError || '导航被浏览器拒绝'}`);
}
// Probe a cheap "page signal" (text length + a leading slice) so we can tell
// when a page has stopped changing, without depending on any job title text.
// Also check if the main content area (application cards or status info) is ready.
async function pageSignal(tabId, allFrames) {
  try {
    const results = await chrome.scripting.executeScript({
      target: allFrames ? { tabId, allFrames: true } : { tabId },
      func: () => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        // Check if main content areas containing application/delivery keywords are visible and loaded
        const contentKeywords = /投递|应聘|申请|笔试|面试|offer|志愿|当前状态|投递岗位/i;
        const mainSelectors = 'main,[role="main"],[class*="content"],[class*="Content"],[class*="container"],[class*="list"],[class*="application"]';
        const contentAreas = [...document.querySelectorAll(mainSelectors)]
          .filter(e => e.getClientRects().length > 0 && contentKeywords.test(e.innerText || ''));
        const contentReady = contentAreas.length > 0 && contentAreas.some(e => {
          const areaText = (e.innerText || '').replace(/\s+/g, '');
          return areaText.length > 50; // Real content, not just skeleton
        });
        // Check if there are visible cards or status elements
        const hasCards = [...document.querySelectorAll('article,li,[class*="card"],[class*="Card"],[class*="item"],[class*="record"]')]
          .some(e => e.getClientRects().length > 0 && e.innerText && e.innerText.length > 20 && contentKeywords.test(e.innerText));
        return { len: text.length, head: text.slice(0, 200), url: location.href, contentReady: contentReady || hasCards };
      }
    });
    const values = (results || []).map(r => r?.result).filter(Boolean);
    if (!values.length) return null;
    return values.sort((a, b) => b.len - a.len)[0];
  } catch { return null; }
}

const DEFINITIVE = /登录|敏感|多条|验证码/;
// Loose "does this job appear in the text" probe used only to know when a lazy SPA
// has finished rendering. It is not a status rule; the model still decides stages.
const foldName = value => String(value || '').toLowerCase().replace(/[\s（）()【】\[\]·・,，、。.:：;；\-—_/\\]/g, '');
function nameIn(text, want) {
  if (!want) return true;
  const folded = foldName(text);
  if (folded.includes(want)) return true;
  // Chinese job titles are often long; accept when a distinctive slice is present.
  for (let i = 0; i + 6 <= want.length; i += 2) if (folded.includes(want.slice(i, i + 6))) return true;
  return false;
}

// Flexible reader: poll the scan function until either it returns usable data,
// or the page content has settled (same signal twice) — whichever comes first.
// "Settled" means the SPA finished rendering; we do NOT require a specific job
// title to appear. On timeout we fall back to whatever the last scan returned.
async function readWhenStable(tabId, scanFn, args = [], { allFrames = false, timeoutMs = 25000, settleMs = 900, expect = '', minChars = 120, floorChars = 0 } = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  // Some SPAs blank the content frame whenever the route swaps, so a poll that lands
  // in that gap looks like a valid "page with almost no text". When the caller sets a
  // floor and the deadline arrives without ever reaching it, wait one extra window
  // instead of shipping the shell to the model as a real empty result.
  // Six seconds is deliberate: it covers a normal route transition, while a page whose
  // list lives in a cross-origin frame (nothing will ever appear at this level) should
  // reach the screenshot fallback quickly.
  const floorDeadline = floorChars ? deadline + Math.min(6000, timeoutMs) : deadline;
  const want = String(expect || '').replace(/\s+/g, '');
  // A render-ready page needs real content. Below this size the frame is an unloaded
  // shell (or a login splash), so keep waiting instead of reporting "no records".
  const textOf = v => String((v && (v.text || v.pageText)) || (v && Array.isArray(v.cards) ? v.cards.map(c => (c && c.text) || '').join('\n') : '') || '');
  // A `blank` card is scan-list's last-resort placeholder for an unrendered shell.
  // It must not count as "read content", or we screenshot and ask the model about
  // a white page (which returns zero rows and looks like a real empty result).
  const realCards = v => (Array.isArray(v?.cards) ? v.cards.filter(c => c && c.blank !== true) : []);
  const floor = Math.max(minChars, floorChars);
  const usable = v => realCards(v).length || textOf(v).replace(/\s+/g, '').length >= floor;
  const expired = () => Date.now() >= (usable(last) ? deadline : floorDeadline);
  let last = null, prevSignal = null, stableHits = 0;
  while (true) {
    const scanResults = await chrome.scripting.executeScript({
      target: allFrames ? { tabId, allFrames: true } : { tabId }, func: scanFn, args
    }).then(list => {
      const values = (list || []).map(r => r?.result).filter(v => v && typeof v === 'object');
      // Multi-frame pages: the real content often lives in a nested frame while the
      // top frame stays an empty shell. Always take the RICHEST frame, not the first
      // one that merely has no error, or an empty shell wins and hides every record.
      const weight = v => (Array.isArray(v.cards) ? v.cards.length * 100000 : 0) + textOf(v).length;
      const ok = values.filter(v => !v.error);
      if (ok.length) return ok.sort((a, b) => weight(b) - weight(a))[0];
      // Every frame errored (e.g. only a sandboxed blank frame exists). Surface the
      // most specific error instead of a bare "not found".
      return values.find(v => v.error && !/无法在页面采集/.test(v.error)) || values[0];
    }).catch(error => ({ error: `无法在页面采集：${error.message}` }));
    // Keep the richest usable frame seen so far; never regress to an emptier one.
    if (last && textOf(scanResults).length < textOf(last).length && !scanResults.error) { /* keep last */ } else { last = scanResults; }
    if (last && !last.error) {
      const text = textOf(last);
      // Ready when the wanted job name shows up, or when the page has clearly painted
      // real content and we have no specific name to wait for.
      if (want ? nameIn(text, want) : usable(last)) return last;
    }
    if (last?.error && DEFINITIVE.test(last.error)) return last; // login / sensitive / ambiguous

    const signal = await pageSignal(tabId, allFrames);
    if (signal && signal.len > 0) {
      const key = `${signal.len}:${signal.head}`;
      stableHits = (prevSignal === key) ? stableHits + 1 : 0;
      prevSignal = key;
      // Settled and usable: done. Settled but still empty: wait the full timeout so a
      // slow SPA still gets a chance, then return whatever we have.
      // Also check if main content area is ready - if not, keep waiting even if page text is stable
      const contentReady = signal.contentReady !== false; // undefined treated as ready (backward compat)
      if (stableHits >= 2 && usable(last) && contentReady) return last;
      // If content area not ready yet, give it more time even if text is stable
      await wait(contentReady ? settleMs : 1200);
    } else {
      await wait(600);
    }
    if (expired()) return last || { error: '页面在限定时间内没有稳定内容' };
  }
}

// Kept for the page-discovery flow that needs to know when a list is ready.
async function scan(tabId, func, args = [], options = {}) {
  return readWhenStable(tabId, func, args, options);
}
async function screenshot(tabId, requestedClip = null, limit = 800) {
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3'); attached = true;
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    if (!size || size.width <= 0 || size.height <= 0 || size.width > 10000 || size.height > 100000) throw new Error('页面尺寸异常，未发送截断截图');
    const raw = requestedClip || { x: 0, y: 0, width: size.width, height: size.height };
    const x = Math.min(Math.max(0, raw.x), Math.max(0, size.width - 1));
    const y = Math.min(Math.max(0, raw.y), Math.max(0, size.height - 1));
    const width = Math.min(raw.width, size.width - x);
    const height = Math.min(raw.height, size.height - y);
    const clip = { x, y, width, height, scale: Math.min(1, limit / Math.max(width, height)) };
    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    return await resizeScreenshot(result.data);
  } finally { if (attached) await chrome.debugger.detach({ tabId }); }
}

// Screenshot the page after it has settled. SPA pages re-render constantly, so a
// before/after fingerprint would abort on harmless changes; the model judges the
// final image, and the source check happens on the server.
async function stableShot(tabId, scanFn, args) {
  const current = await scan(tabId, scanFn, args);
  if (current.error && /登录|敏感/.test(current.error)) throw new Error(current.error);
  const image = await screenshot(tabId);
  return { image, url: current.url, stable: true };
}
async function selfCheck(api, endpoint, tabId, test) {
  try {
    const load = async path => { await chrome.tabs.update(tabId, { url: endpoint + path, active: false }); for (let n = 0; n < 10; n++) { await wait(300); if ((await chrome.tabs.get(tabId)).status === 'complete') break; } };
    await load('/browser-check');
    const match = await scan(tabId, scanPage, ['浏览器自检岗位']);
    const duplicate = await scan(tabId, scanPage, ['重复校验岗位']);
    await load('/browser-check/login'); const login = await scan(tabId, scanPage, ['浏览器自检岗位']);
    await load('/browser-check'); const stable = await scan(tabId, scanPage, ['浏览器自检岗位']);
    const checks = { matched: !match.error && match.text.includes('二面中'), duplicateBlocked: !!duplicate.error && /多条/.test(duplicate.error), loginBlocked: !!login.error && /登录/.test(login.error), stable: !stable.error && stable.text === match.text && stable.url === endpoint + '/browser-check', detached: false };
    if (!checks.matched || !checks.duplicateBlocked || !checks.loginBlocked || !checks.stable) throw new Error('页面识别或来源保护自检失败');
    const image = await screenshot(tabId); checks.detached = true;
    await api('/api/bridge/self-test/result', { id: test.id, checks, image });
  } catch (error) { await api('/api/bridge/self-test/result', { id: test.id, error: error.message }).catch(() => {}); }
}
async function collectPage(api, page) {
  let lastDebug = null, tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    tabId = tab.id;
    message = '正在读取投递列表'; 
    const visitedUrl = await visit(tabId, page.url);
    // Give the SPA time to paint real rows: an empty shell is not "no records".
    // Some sites (bestechnic, sensetime) have very slow dynamic loading; give them extra time.
    const url = new URL(page.url);
    const slowHosts = ['bestechnic.zhiye.com', 'hr-jobs.sensetime.com'];
    const timeoutMs = slowHosts.includes(url.hostname) ? 35000 : 20000;
    // A 应聘记录 page always has more than a header. Requiring ~60 characters stops a
    // mid-route blank frame from being accepted as a completed read (which showed up
    // as "AI 未返回岗位候选（页面文字 28 字）" on a page that clearly listed records).
    const data = await scan(tabId, scanApplications, [], { allFrames: true, timeoutMs, floorChars: 60 });
    lastDebug = data?.debug || null;
    message = '正在识别本页岗位';
    // Use the URL that visit confirmed, not the one scan reads (which may have changed)
    console.log(`[collectPage] visitedUrl = ${visitedUrl}`);
    console.log(`[collectPage] data.url = ${data?.url}`);
    const payload = { id: page.id, ...data, url: visitedUrl };
    console.log(`[collectPage] payload.url = ${payload.url}`);
    const result = await api('/api/pages/result', payload);
    if (result.needsImage) {
      message = data?.clip ? '正在截取岗位区域复核' : '正在按页面区域截图复核';
      // Use one focused image when the DOM found a region. Otherwise use the
      // generic viewport slicer; never shrink an entire wide page into one image.
      // scanApplications may have run in an iframe. Its DOM coordinates are local
      // to that frame and cannot safely be used as top-level debugger coordinates.
      // Use top-level viewport slices for this page-level flow instead.
      const images = await captureViewports(tabId);
      if (!images.length) throw new Error('截图采集为空，未发送给 AI');
      await api('/api/pages/images', { id: page.id, url: visitedUrl, images });
    }
  } catch (error) {
    const reason = error && error.message ? error.message : '采集失败';
    await api('/api/pages/result', { id: page.id, error: reason, debug: lastDebug }).catch(() => {});
    await api('/api/pages/images', { id: page.id, error: reason }).catch(() => {});
  } finally {
    await closeTab(tabId);
  }
}
async function run() {
  markRunning();
  message = '已开始执行';
  let tabId = null;
  const watchdog = setInterval(guard, 30000);
  try {
    const { api, endpoint } = await connection();
    const { batchId, tasks, page, selfTest } = await api('/api/refresh/tasks');
    if (!tasks.length && !page && !selfTest) { message = '没有待执行任务'; return; }
    if (selfTest) { const tab = await chrome.tabs.create({ url: 'about:blank', active: false }); tabId = tab.id; await selfCheck(api, endpoint, tab.id, selfTest); }
    if (page) await collectPage(api, page);
    if (tasks.length) {
      const total = tasks.length;
      const cancelled = () => isStale();
      // Records that share a URL live on ONE page. Open that page once and match
      // every record on it, instead of opening the same page once per record.
      const groups = [];
      for (const task of tasks) {
        const group = groups.find(g => g.url === task.url);
        if (group) group.tasks.push(task); else groups.push({ url: task.url, tasks: [task] });
      }
      let completed = 0;
      const worker = async () => {
        while (!cancelled()) {
          const group = groups.shift();
          if (!group) return;
          let tab = null;
          try {
            tab = await chrome.tabs.create({ url: 'about:blank', active: false });
            await visit(tab.id, group.url);
            // Read the page once; the model matches each record against the same page.
            // A common shell problem: the SPA renders before the record list loads.
            // Wait until this page's first job name appears, then return the page text.
            const data = await readWhenStable(tab.id, scanPage, [], { expect: group.tasks[0]?.position || '' });
            const pending = [];
            for (const task of group.tasks) {
              message = `正在核对 ${completed + 1}/${total}：${task.company} ${task.position}`;
              const reply = await api('/api/refresh/result', { batchId, id: task.id, ...data }).catch(error => ({ error: error.message }));
              if (reply.error) { completed++; continue; }
              if (reply.needsAI) pending.push(task);
              else completed++;
            }
            if (pending.length) {
              if (data.error && !data.fallbackAllowed) {
                for (const task of pending) { await api('/api/refresh/result', { batchId, id: task.id, error: data.error }).catch(() => {}); completed++; }
                continue;
              }
              // One screenshot set per page, reused for every record on it.
              const images = await captureViewports(tab.id);
              for (const task of pending) { await api('/api/refresh/image', { batchId, id: task.id, url: data.url, images }).catch(() => {}); completed++; }
            }
          } catch (error) {
            for (const task of group.tasks) { await api('/api/refresh/result', { batchId, id: task.id, error: error.message }).catch(() => {}); }
            completed += group.tasks.length;
          } finally { await closeTab(tab?.id); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, groups.length) }, () => worker()));
    }
    message = '本轮执行完成，请在台账查看结果并确认。';
  } catch (error) { message = error.message; }
  finally {
    markIdle(); clearInterval(watchdog);
    await closeTab(tabId);
  }
}
chrome.runtime.onMessage.addListener((request, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  void (async () => {
    try {
      const fromPage = sender.url?.startsWith('http://127.0.0.1:');
      if (fromPage && new URL(sender.url).origin !== request.endpoint) throw new Error('台账来源不匹配');
      if (request.type === 'PAIR') {
        if (!fromPage || !/^[a-f0-9]{48}$/.test(request.token)) throw new Error('配对请求无效');
        await chrome.storage.local.set({ endpoint: request.endpoint, token: request.token });
      }
      const { endpoint, api } = await connection();
      if (fromPage && endpoint !== request.endpoint) throw new Error('此页面不是已配对台账，请重新连接');
      if (['PING', 'PAIR', 'RUN'].includes(request.type)) await api('/api/bridge/hello', { version: VERSION });
      if (request.type === 'RUN') {
        if (busy) throw new Error('浏览器采集正在执行，请等待本轮结束');
        message = '已开始执行'; void run();
      }
      reply({ ok: true, message, busy, version: VERSION });
    } catch (error) { reply({ ok: false, message: error.message, busy }); }
  })();
  return true;
});
