// NOTE: scanPage is injected into the page via chrome.scripting.executeScript.
// Injected functions are serialized, so they must NOT reference imports.
//
// Strategy: try to locate the single block that holds this application; if that
// fails, return the whole page TEXT instead of erroring. Text is native (not a
// downscaled screenshot), so the server can still find the record from it.
export async function scanPage(position) {
  const url = location.href;
  const pageText = document.body?.innerText || '';
  const loginField = [...document.querySelectorAll('input[type="password"]')].some(e => e.getClientRects().length);
  if (loginField || /([?&#]|^|\/)(login|signin|sign-in|signon|sso|passport)([=/?#]|$)/i.test(location.pathname + location.hash) || /请先登录|登录后查看|扫码登录/.test(pageText)) return { error: '需要先在官网登录', url };
  // Only treat this as a resume-EDIT page when it actually has an editable resume
  // form, not merely a "编辑简历" button/link on the application list.
  const resumeForm = [...document.querySelectorAll('form')].some(f => {
    const text = f.innerText || '';
    return /教育经历|工作经历|项目经历|实习经历|简历/.test(text) && f.querySelector('input,textarea');
  });
  if (/验证码|身份证/.test(pageText) || resumeForm) return { error: '页面可能包含登录或简历编辑信息，不采集', url };

  const compact = value => String(value || '').toLowerCase().replace(/[\s（）()【】\[\]·・,，、。.:：;；\-—_/\\]/g, '');
  const want = compact(position);
  const safeText = value => !/验证码|密码|access_token|authorization|1[3-9]\d{9}/i.test(value);
  const cleanBlock = element => {
    if (element.querySelector('input,textarea,[contenteditable="true"],iframe')) return null;
    const actions = new Set([...element.querySelectorAll('button,[role="button"]')].map(e => e.innerText.trim()));
    return element.innerText.split(/\r?\n/).filter(line => !actions.has(line.trim())).join('\n').trim();
  };

  const candidates = [...document.querySelectorAll('article,li,[role="listitem"],[class*="card"],[class*="Card"],[class*="application"],[class*="Application"],[class*="record"],[class*="position"]')]
    .filter(e => e.getClientRects().length && e.innerText && compact(e.innerText).includes(want) && e.innerText.length < 5000);
  const leaves = candidates.filter(e => !candidates.some(other => other !== e && e.contains(other)));

  if (leaves.length === 1) {
    const text = cleanBlock(leaves[0]);
    if (text && safeText(text)) return { text, url, scope: 'card' };
  }

  // Could not isolate one card: hand back the whole visible text, scoped later.
  if (!safeText(pageText)) return { error: '页面可能包含敏感资料，不采集', url };
  if (pageText.trim().length < 20) return { error: '页面没有可读取的文字内容', url };
  return { text: pageText.slice(0, 8000), url, scope: 'page', matchedCards: leaves.length };
}
