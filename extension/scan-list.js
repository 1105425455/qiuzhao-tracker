// NOTE: scanApplications is injected into the page via chrome.scripting.executeScript.
// Injected functions are serialized, so they must NOT reference imports.
export async function scanApplications() {
  const url = location.href;
  const pageText = document.body?.innerText || '';
  if (/([?&#]|^)(login|signin|sign-in|signon|sso|passport)([=/?#]|$)/i.test(location.pathname + location.hash) || [...document.querySelectorAll('input[type="password"]')].some(e => e.getClientRects().length) || /请先登录|登录后查看|扫码登录/.test(pageText)) return { url, error: '需要先在官网登录，再打开我的投递页面' };
  if (/验证码|身份证|简历编辑|编辑简历/.test(pageText)) return { url, error: '登录或简历编辑页面不发送给 AI' };
  // "第 1 志愿" may render with spaces, full-width digits or no space at all.
  const rankRe = /第\s*[1-9一二三四五六七八九０-９0-9]\s*志愿/;
  const listTitle = /我的投递|我的申请|投递记录|申请记录|应聘记录|已完成的投递|进行中的投递|应聘进度|投递进度|申请进度|投递岗位|申请状态|应聘状态|当前状态|投递简历|内推投递|修改志愿顺序|意向城市/i;
  const urlHint = /\/(application|apply|applications|deliver|delivery|myapplications?|candidate|positions?\/application)/i.test(location.pathname + location.hash) || rankRe.test(pageText);
  const selectors = 'article,li,[role="listitem"],[class*="card"],[class*="Card"],[class*="application"],[class*="Application"],[class*="apply-item"],[class*="job-item"],[class*="jobItem"],[class*="delivery"],[class*="record"],[class*="position"],[class*="volunteer"]';
  const status = /投递|应聘|申请|简历|笔试|面试|测评|录用|Offer|流程|进度|志愿/i;
  const safe = text => !/验证码|密码|身份证|access_token|authorization|1[3-9]\d{9}/i.test(text);
  const cells = element => {
    const rect = element.getBoundingClientRect();
    return element.getClientRects().length && rect.width >= 40 && rect.height >= 30 && rect.width <= 1600 && rect.height <= 1400 && !element.querySelector('input,textarea,[contenteditable="true"],iframe');
  };
  const found = [...document.querySelectorAll(selectors)].filter(e => e.getClientRects().length && e.innerText?.length > 8 && e.innerText.length <= 3500 && status.test(e.innerText));
  const leaves = found.filter(e => !found.some(other => other !== e && e.contains(other)));
  const cards = [];
  let skipped = 0;
  for (const element of leaves.slice(0, 40)) {
    const text = element.innerText.trim();
    if (!cells(element) || !safe(text)) { skipped++; continue; }
    const uid = element.getAttribute('data-application-id') || element.getAttribute('data-apply-id') || '';
    const h = element.querySelector('h1,h2,h3,h4,h5,[class*="job-name"],[class*="jobName"],[class*="position-name"],[class*="title"]');
    const position = (h?.innerText || text.split(/\n/)[0] || '').trim();
    cards.push({ text, position: position.slice(0, 200), uid: /^[\w.:-]{1,200}$/.test(uid) ? uid : '' });
    if (cards.length === 20) break;
  }
  // Row blocks marked only by 志愿 (with or without spaces).
  if (!cards.length) {
    const ranked = [...document.querySelectorAll('div,section,li,article')].filter(e => {
      const t = e.innerText || '';
      return e.getClientRects().length && rankRe.test(t) && t.length <= 1500 && safe(t) && !e.querySelector('input,textarea,[contenteditable="true"],iframe');
    });
    const minimal = ranked.filter(e => !ranked.some(other => other !== e && e.contains(other)));
    for (const element of minimal.slice(0, 10)) {
      const text = element.innerText.trim();
      if (!safe(text)) continue;
      const heading = element.querySelector('h1,h2,h3,h4,h5')?.innerText.trim() || text.split(/\n/)[0] || '';
      cards.push({ text, position: heading.slice(0, 200), uid: '', group: true });
    }
  }
  // Visible region that names the list, then the whole page as a last resort.
  if (!cards.length) {
    const regions = [...document.querySelectorAll('main,[role="main"],[class*="list"],[class*="List"],[class*="container"]')]
      .filter(e => e.getClientRects().length && listTitle.test(e.innerText || '') && e.innerText.length <= 3500 && safe(e.innerText) && !e.querySelector('input,textarea,[contenteditable="true"],iframe'));
    regions.sort((a, b) => a.innerText.length - b.innerText.length);
    if (regions[0]) cards.push({ text: regions[0].innerText.trim(), uid: '', group: true });
  }
  if (!cards.length && safe(pageText) && (listTitle.test(pageText) || urlHint) && pageText.trim().length > 20) cards.push({ text: pageText.slice(0, 3500), uid: '', group: true });
  if (!cards.length) return { url, error: '没有在这页找到投递记录。请确认已进入“我的投递/应聘记录”，页面上应能看到岗位或“第 1 志愿”。', debug: { textLen: pageText.length, titleMatched: listTitle.test(pageText), urlHint, found: found.length, leaves: leaves.length } };
  // A single-application progress page (one 投递岗位 + 当前状态) must yield one
  // record, not one per step label shown in its progress bar.
  const positionMarkers = (pageText.match(/投递岗位|投递职位|应聘岗位|申请岗位|当前状态/g) || []).length;
  const singlePage = cards.length === 1 && cards[0].group === true && positionMarkers > 0 && !rankRe.test(pageText);
  if (singlePage) cards[0].single = true;
  const more = leaves.length > cards.length + skipped || [...document.querySelectorAll('button,a,[role="button"]')].some(e => e.getClientRects().length && /^(下一页|Next|更多)$/.test(e.innerText?.trim()) && !e.disabled && e.getAttribute('aria-disabled') !== 'true');
  return { url, title: document.title.slice(0, 200), cards, pageText: pageText.slice(0, 3500), skipped, more, singlePage, debug: { textLen: pageText.length, cards: cards.length, found: found.length } };
}
