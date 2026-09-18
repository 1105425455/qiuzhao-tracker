// NOTE: scanApplications is injected into the page via chrome.scripting.executeScript.
// Injected functions are serialized, so they must NOT reference imports.
export async function scanApplications() {
  const url = location.href;
  const pageText = document.body?.innerText || '';
  if (/([?&#]|^)(login|signin|sign-in|signon|sso|passport)([=/?#]|$)/i.test(location.pathname + location.hash) || [...document.querySelectorAll('input[type="password"]')].some(e => e.getClientRects().length) || /请先登录|登录后查看|扫码登录/.test(pageText)) return { url, error: '需要先在官网登录，再打开我的投递页面' };
  const resumeForm = [...document.querySelectorAll('form')].some(f => {
    const text = f.innerText || '';
    return /教育经历|工作经历|项目经历|实习经历|简历/.test(text) && f.querySelector('input,textarea');
  });
  if (/验证码|身份证/.test(pageText) || resumeForm) return { url, error: '登录或简历编辑页面不发送给 AI' };
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
  const clipOf = element => { const r = element.getBoundingClientRect(); return { x: Math.max(0, r.left - 24), y: Math.max(0, r.top + scrollY - 24), width: r.width + 48, height: r.height + 48 }; };
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
    cards.push({ text, position: position.slice(0, 200), uid: /^[\w.:-]{1,200}$/.test(uid) ? uid : '', clip: clipOf(element) });
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
       cards.push({ text, position: heading.slice(0, 200), uid: '', group: true, clip: clipOf(element) });
    }
  }
  // Visible region that names the list, then the whole page as a last resort.
  if (!cards.length) {
    const regions = [...document.querySelectorAll('main,[role="main"],[class*="list"],[class*="List"],[class*="container"]')]
      .filter(e => e.getClientRects().length && listTitle.test(e.innerText || '') && e.innerText.length <= 3500 && safe(e.innerText) && !e.querySelector('input,textarea,[contenteditable="true"],iframe'));
    regions.sort((a, b) => a.innerText.length - b.innerText.length);
    if (regions[0]) cards.push({ text: regions[0].innerText.trim(), uid: '', group: true, clip: clipOf(regions[0]) });
  }
  // A URL that looks like a record route is a hint, not proof of readable content.
  // A 29-character navigation bar matched /position/application and was pushed as a
  // real card, which satisfied the reader's "usable content" check and returned after
  // two seconds with nothing but the site chrome. Require either the list title or
  // enough text for the URL hint to stand alone.
  const textLen = pageText.trim().length;
  if (!cards.length && safe(pageText) && (listTitle.test(pageText) ? textLen > 20 : (urlHint && textLen > 60))) cards.push({ text: pageText.slice(0, 12000), uid: '', group: true });
  // Still nothing, but the page has real content: hand the whole page to the model
  // instead of declaring "no records". A pasted 应聘记录 URL means there is a record;
  // failing to match selectors or a text-light SPA must not stop recognition.
  // The bar is 60 characters on purpose: a page shorter than that is site chrome
  // (nav, footer, a masked phone number), and treating it as a finished read made
  // the reader return in two seconds and the model report "no records".
  const meaningful = safe(pageText) && textLen >= 60;
  if (!cards.length && meaningful) cards.push({ text: pageText.slice(0, 12000), uid: '', group: true, needsImage: true });
  // Even a near-empty shell is not a hard stop: let the server use a screenshot.
  // Mark it blank so the reader keeps waiting for the SPA to render instead of
  // treating an unloaded page as "read successfully, zero records".
  if (!cards.length) cards.push({ text: pageText.slice(0, 12000), uid: '', group: true, needsImage: true, blank: true });

  // A single-application progress page (one 投递岗位 + 当前状态) must yield one
  // record, not one per step label shown in its progress bar.
  const positionMarkers = (pageText.match(/投递岗位|投递职位|应聘岗位|申请岗位|当前状态/g) || []).length;
  const applicationPath = /\/position\/application(?:\/|$)/i.test(location.pathname);
  const singlePage = cards.length === 1 && cards[0].group === true && (positionMarkers > 0 || applicationPath) && !rankRe.test(pageText);
  if (singlePage) cards[0].single = true;
  // Only a real pagination control counts. A "更多/查看更多" button and a candidate
  // count difference are far too noisy and produced false "there is more history"
  // warnings on single-application pages.
  const more = [...document.querySelectorAll('button,a,[role="button"]')].some(e => e.getClientRects().length && /^(下一页|Next)$/i.test(e.innerText?.trim()) && !e.disabled && e.getAttribute('aria-disabled') !== 'true');
  return { url, title: document.title.slice(0, 200), cards, clip: cards.length === 1 ? cards[0].clip : null, pageText: pageText.slice(0, 12000), skipped, more, singlePage, debug: { textLen: pageText.length, cards: cards.length, found: found.length } };
}
