window.addEventListener('message', async event => {
  const message = event.data;
  if (event.source !== window || event.origin !== location.origin || message?.source !== 'autumn-tracker-ui' || !['PING', 'PAIR', 'RUN'].includes(message.type) || typeof message.id !== 'string') return;
  try {
    const result = await chrome.runtime.sendMessage({ type: message.type, endpoint: location.origin, token: message.type === 'PAIR' ? message.token : undefined });
    window.postMessage({ source: 'autumn-tracker-extension', id: message.id, result }, location.origin);
  } catch { window.postMessage({ source: 'autumn-tracker-extension', id: message.id, result: { ok: false, message: '浏览器扩展已断开，请刷新页面后重新连接' } }, location.origin); }
});
