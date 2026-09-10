// Stable fingerprint ignores volatile bits like timestamps so harmless SPA
// re-renders do not abort a screenshot. Job count and titles still matter.
export async function stableFingerprint(url, texts) {
  const clean = text => String(text ?? '')
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\b\d{2}:\d{2}\b/g, '')
    .replace(/\d{13,}/g, '')
    .replace(/\s+/g, ' ').trim();
  const core = Array.isArray(texts) ? texts : [texts];
  const input = JSON.stringify([url, core.map(text => clean(text).slice(0, 120))]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function pageFingerprint(scanResult) {
  if (!scanResult) return '';
  const parts = Array.isArray(scanResult.cards) ? scanResult.cards.map(card => card.text) : [scanResult.text || scanResult.pageText || ''];
  return stableFingerprint(scanResult.url || '', parts);
}
