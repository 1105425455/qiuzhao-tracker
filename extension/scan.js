// NOTE: scanPage is injected into the page via chrome.scripting.executeScript.
// Injected functions are serialized, so they must NOT reference imports.
export async function scanPage(position) {
  const url = location.href;
  const pageText = document.body?.innerText || '';
  const loginField = [...document.querySelectorAll('input[type="password"]')].some(e => e.getClientRects().length);
  if (loginField || /([?&#]|^)(login|signin|sign-in|signon|sso|passport)([=/?#]|$)/i.test(location.pathname + location.hash) || /请先登录|登录后查看|扫码登录/.test(document.body?.innerText || '')) return { error: '需要先在官网登录', url };
  if (/验证码|身份证|简历编辑|编辑简历/.test(pageText)) return { error: '页面可能包含登录或简历编辑信息，不发送截图', url };
  const candidates = [...document.querySelectorAll('article,li,[role="listitem"],[class*="card"],[class*="Card"],[class*="application"],[class*="Application"]')].filter(e => e.getClientRects().length && e.innerText?.includes(position) && e.innerText.length < 5000);
  const leaves = candidates.filter(e => !candidates.some(other => other !== e && e.contains(other)));
  if (leaves.length !== 1) return { error: leaves.length ? '同名岗位有多条记录，需人工定位' : '未定位到对应的单条投递卡片', url, fallbackAllowed: !leaves.length && /我的投递|我的申请|投递记录|申请记录|应聘记录/.test(pageText) };
  const element = leaves[0];
  if (element.querySelector('input,textarea,[contenteditable="true"],iframe')) return { error: '卡片包含输入或嵌入内容，不采集', url };
  const actions = new Set([...element.querySelectorAll('button,[role="button"]')].map(e => e.innerText.trim()));
  const text = element.innerText.split(/\r?\n/).filter(line => !actions.has(line.trim())).join('\n').trim();
  if (/验证码|密码|身份证|access_token|authorization|1[3-9]\d{9}/i.test(text)) return { error: '卡片可能包含敏感资料，不截图或发送', url };
  return { text, url };
}
