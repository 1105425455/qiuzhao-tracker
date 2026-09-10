const $ = id => document.getElementById(id);
chrome.storage.local.get(['endpoint', 'token']).then(config => { if (config.endpoint) $('endpoint').value = config.endpoint; if (config.token) $('token').value = config.token; });
$('run').onclick = async () => {
  try {
    const url = new URL($('endpoint').value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('本地服务仅支持 http://127.0.0.1:端口');
    const token = $('token').value.trim(); if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('请填写台账连接设置中的配对码');
    await chrome.storage.local.set({ endpoint: url.origin, token });
    const result = await chrome.runtime.sendMessage({ type: 'RUN' }); $('message').textContent = result.message;
  } catch (error) { $('message').textContent = error.message; }
};
$('status').onclick = async () => { const result = await chrome.runtime.sendMessage({ type: 'STATUS' }); $('message').textContent = result.message; };
