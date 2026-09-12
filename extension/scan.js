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
  const loginPath = /([?&#]|^|\/)(login|signin|sign-in|signon|sso|passport)([=/?#]|$)/i.test(location.pathname + location.hash);
  const loginWords = /请先登录|登录后查看|扫码登录|账号登录|手机号登录|立即登录|登录\/注册/.test(pageText);
  if (loginField || loginPath || (loginWords && pageText.trim().length < 600)) return { error: '需要先在官网登录', url };
  if (/验证码|身份证/.test(pageText)) return { error: '页面要求填写验证码或证件信息，不采集', url };

  const compact = value => String(value || '').toLowerCase().replace(/[\s（）()【】\[\]·・,，、。.:：;；\-—_/\\]/g, '');
  const want = compact(position);
  // Keep the page text but strip the applicant's own contact details before it can
  // leave the browser. A profile header with a phone number must not block capture.
  const redact = value => String(value || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '（邮箱已隐藏）')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '（手机号已隐藏）')
    .replace(/\b\d{17}[\dXx]\b/g, '（证件号已隐藏）');
  const safeText = value => !/验证码|密码|access_token|authorization/i.test(value);
  const cleanBlock = element => {
    if (element.querySelector('input,textarea,[contenteditable="true"],iframe')) return null;
    const actions = new Set([...element.querySelectorAll('button,[role="button"]')].map(e => e.innerText.trim()));
    return element.innerText.split(/\r?\n/).filter(line => !actions.has(line.trim())).join('\n').trim();
  };

  // No position: return the whole page. The ledger groups records by URL and asks
  // the model to match each record against the same page text in one visit.
  const candidates = want ? [...document.querySelectorAll('article,li,[role="listitem"],[class*="card"],[class*="Card"],[class*="application"],[class*="Application"],[class*="record"],[class*="position"]')]
    .filter(e => e.getClientRects().length && e.innerText && compact(e.innerText).includes(want) && e.innerText.length < 5000) : [];
  const leaves = candidates.filter(e => !candidates.some(other => other !== e && e.contains(other)));

  if (leaves.length === 1) {
    const text = cleanBlock(leaves[0]);
    if (text && safeText(text)) return { text: redact(text), url, scope: 'card' };
  }

  // Could not isolate one card: hand back the whole visible text, scoped later.
  if (!safeText(pageText)) return { error: '页面是登录或验证页，不采集', url };
  if (pageText.trim().length < 20) return { error: '页面没有可读取的文字内容', url };
  return { text: redact(pageText).slice(0, 12000), url, scope: 'page', matchedCards: leaves.length };
}
