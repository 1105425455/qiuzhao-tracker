export function browserBridge(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => { window.removeEventListener('message', receive); reject(new Error('浏览器采集扩展未连接，任务尚未执行。请在“连接与 AI 兜底”中安装并连接扩展。')); }, 4500);
    function receive(event) {
      if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'autumn-tracker-extension' || event.data.id !== id) return;
      clearTimeout(timeout); window.removeEventListener('message', receive);
      if (!event.data.result?.ok) reject(new Error(event.data.result?.message || '浏览器连接失败'));
      else resolve(event.data.result);
    }
    window.addEventListener('message', receive);
    window.postMessage({ source: 'autumn-tracker-ui', id, type, ...payload }, location.origin);
  });
}
