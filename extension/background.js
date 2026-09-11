import { scanPage } from './scan.js';
import { scanApplications } from './scan-list.js';
import { resizeScreenshot } from './image.js';
import { pageFingerprint } from './fingerprint.mjs';
let busy = false, message = '尚未执行核对', runStartedAt = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const STALE_MS = 10 * 60 * 1000;
function markRunning() { runStartedAt = Date.now(); busy = true; }
function markIdle() { busy = false; runStartedAt = 0; }
function isStale() { return busy && runStartedAt && Date.now() - runStartedAt > STALE_MS; }
function guard() { if (isStale()) { markIdle(); message = '上次任务超时，已自动复位；请重新执行'; } }
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
    let placed;
    try { placed = new URL(actual.url); } catch { throw new Error(`页面地址无效：${actual.url}`); }
    if (LOGIN_RE.test(`${placed.pathname}${placed.search}${placed.hash}`)) throw new Error(`页面要求登录：${placed.origin}${placed.pathname}，请在该浏览器完成登录后重试`);
    if (placed.origin !== target.origin) throw new Error(`页面跳到了其他站点：${placed.origin}${placed.pathname}`);
    return placed.href;
  }
  throw new Error(`页面打开失败：${lastError || '导航被浏览器拒绝'}`);
}
// Probe a cheap "page signal" (text length + a leading slice) so we can tell
// when a page has stopped changing, without depending on any job title text.
async function pageSignal(tabId, allFrames) {
  try {
    const results = await chrome.scripting.executeScript({
      target: allFrames ? { tabId, allFrames: true } : { tabId },
      func: () => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        return { len: text.length, head: text.slice(0, 200), url: location.href };
      }
    });
    const values = (results || []).map(r => r?.result).filter(Boolean);
    if (!values.length) return null;
    return values.sort((a, b) => b.len - a.len)[0];
  } catch { return null; }
}

const DEFINITIVE = /登录|敏感|多条|验证码/;

// Flexible reader: poll the scan function until either it returns usable data,
// or the page content has settled (same signal twice) — whichever comes first.
// "Settled" means the SPA finished rendering; we do NOT require a specific job
// title to appear. On timeout we fall back to whatever the last scan returned.
async function readWhenStable(tabId, scanFn, args = [], { allFrames = false, timeoutMs = 25000, settleMs = 900 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null, prevSignal = null, stableHits = 0;
  while (true) {
    const scanResults = await chrome.scripting.executeScript({
      target: allFrames ? { tabId, allFrames: true } : { tabId }, func: scanFn, args
    }).then(list => {
      const values = (list || []).map(r => r?.result).filter(v => v && typeof v === 'object');
      return values.find(v => Array.isArray(v.cards) && v.cards.length) || values.find(v => !v.error) || values[0];
    }).catch(error => ({ error: `无法在页面采集：${error.message}` }));
    last = scanResults;
    if (last && !last.error) return last;                     // usable data
    if (last?.error && DEFINITIVE.test(last.error)) return last; // login / sensitive / ambiguous

    const signal = await pageSignal(tabId, allFrames);
    if (signal && signal.len > 0) {
      const key = `${signal.len}:${signal.head}`;
      stableHits = (prevSignal === key) ? stableHits + 1 : 0;
      prevSignal = key;
      // Content has been identical for a full settle window: rendering finished.
      if (stableHits >= 1) return last;
      await wait(settleMs);
    } else {
      await wait(600);
    }
    if (Date.now() >= deadline) return last || { error: '页面在限定时间内没有稳定内容' };
  }
}

// Kept for the page-discovery flow that needs to know when a list is ready.
async function scan(tabId, func, args = [], { allFrames = false } = {}) {
  return readWhenStable(tabId, func, args, { allFrames });
}
async function screenshot(tabId) {
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3'); attached = true;
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    if (!size || size.width <= 0 || size.height <= 0 || size.width > 10000 || size.height > 100000) throw new Error('页面尺寸异常，未发送截断截图');
    const clip = { x: 0, y: 0, width: size.width, height: size.height, scale: Math.min(1, 800 / Math.max(size.width, size.height)) };
    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    return await resizeScreenshot(result.data);
  } finally { if (attached) await chrome.debugger.detach({ tabId }); }
}
// Take a whole-page screenshot, tolerating small SPA re-renders by retrying
// with a fresh baseline instead of aborting on the first mismatch.
async function stableShot(tabId, scanFn, args) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await scan(tabId, scanFn, args);
    if (before.error && /登录|敏感/.test(before.error)) throw new Error(before.error);
    const image = await screenshot(tabId);
    const after = await scan(tabId, scanFn, args);
    if (!after.error && await pageFingerprint(after) === await pageFingerprint(before)) return { image, url: after.url, stable: true };
  }
  const current = await scan(tabId, scanFn, args);
  if (current.error) throw new Error(current.error);
  const image = await screenshot(tabId);
  return { image, url: current.url, stable: false };
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
    message = '正在读取投递列表'; await visit(tabId, page.url);
    const data = await scan(tabId, scanApplications, [], { allFrames: true });
    lastDebug = data?.debug || null;
    message = '正在识别本页岗位';
    const result = await api('/api/pages/result', { id: page.id, ...data });
    if (result.needsImage) {
      message = '规则不确定，正在用 800px 整页截图复核';
      const shot = await stableShot(tabId, scanApplications, [], /投递|测评|进度/);
      await api('/api/pages/images', { id: page.id, url: data.url, image: shot.image });
    }
  } catch (error) {
    const reason = error && error.message ? error.message : '采集失败';
    await api('/api/pages/result', { id: page.id, error: reason, debug: lastDebug }).catch(() => {});
    await api('/api/pages/images', { id: page.id, error: reason }).catch(() => {});
  } finally {
    // Discovery only needs the page briefly; always close it so nothing lingers.
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} }
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
      let completed = 0;
      // Each task gets its own background tab, so concurrent workers never fight
      // over one tab (which caused "Navigation rejected" before).
      const worker = async () => {
        while (!cancelled()) {
          const task = tasks.shift();
          if (!task) return;
          let tab = null;
          message = `正在并发核对 ${completed + 1}/${total}：${task.company}`;
          try {
            tab = await chrome.tabs.create({ url: 'about:blank', active: false });
            await visit(tab.id, task.url);
            const data = await readWhenStable(tab.id, scanPage, [task.position]);
            const dataFp = await pageFingerprint(data);
            const reply = await api('/api/refresh/result', { batchId, id: task.id, ...data });
            if (reply.needsAI) {
              const before = await readWhenStable(tab.id, scanPage, [task.position]);
              if ((before.error && !before.fallbackAllowed) || before.url !== data.url || await pageFingerprint(before) !== dataFp) throw new Error('截图前页面变化，重新匹配');
              const image = await screenshot(tab.id);
              const after = await readWhenStable(tab.id, scanPage, [task.position]);
              if ((after.error && !after.fallbackAllowed) || after.url !== data.url || await pageFingerprint(after) !== dataFp) throw new Error('截图期间页面变化，改用当前页面');
              await api('/api/refresh/image', { batchId, id: task.id, url: data.url, image });
            }
          } catch (error) { await api('/api/refresh/result', { batchId, id: task.id, error: error.message }).catch(() => {}); }
          finally { if (tab) { try { await chrome.tabs.remove(tab.id); } catch {} } }
          completed++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, () => worker()));
    }
    message = '本轮执行完成，请在台账查看结果并确认。';
  } catch (error) { message = error.message; }
  finally {
    markIdle(); clearInterval(watchdog);
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} }
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
      if (['PING', 'PAIR', 'RUN'].includes(request.type)) await api('/api/bridge/hello', { version: '0.3.0' });
      if (request.type === 'RUN') {
        if (busy) throw new Error('浏览器采集正在执行，请等待本轮结束');
        message = '已开始执行'; void run();
      }
      reply({ ok: true, message, busy, version: '0.3.0' });
    } catch (error) { reply({ ok: false, message: error.message, busy }); }
  })();
  return true;
});
