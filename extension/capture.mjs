import { resizeScreenshot } from './image.js';

export async function captureViewports(tabId, browser = chrome, resize = resizeScreenshot, budgetMs = 20000) {
  const deadline = Date.now() + budgetMs;
  async function bounded(operation) {
    let timer;
    try {
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('截图操作超时')), Math.max(1, deadline - Date.now()));
      })]);
    } finally { clearTimeout(timer); }
  }
  let attached = false;
  const images = [], seen = new Set();
  try {
    await bounded(async () => {
      await browser.debugger.attach({ tabId }, '1.3');
      attached = true;
    });
    const metrics = await bounded(() => browser.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics'));
    const size = metrics.cssContentSize || metrics.contentSize;
    if (!size?.width || !size?.height || size.width <= 0 || size.height <= 0) throw new Error('页面尺寸无效');
    if (size.width > 10000 || size.height > 100000) throw new Error('页面尺寸过大');
    const viewportHeight = (metrics.cssVisualViewport || metrics.visualViewport || {}).clientHeight || 800;
    const maxSlices = 5;
    for (let i = 0; i < maxSlices && images.length < maxSlices; i++) {
      const y = i * viewportHeight;
      if (y >= size.height) break;
      const sliceHeight = Math.min(viewportHeight, size.height - y);
      const clip = { x: 0, y, width: size.width, height: sliceHeight, scale: Math.min(1, 800 / Math.max(size.width, sliceHeight)) };
      const shot = await bounded(() => browser.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true }));
      if (!shot?.data) throw new Error('浏览器未返回截图数据');
      const image = await bounded(() => resize(shot.data));
      if (!image) continue;
      if (seen.has(image)) break;
      seen.add(image); images.push(image);
    }
    if (!images.length) throw new Error('未生成有效截图');
    return images;
  } finally {
    if (attached) {
      try { await Promise.race([browser.debugger.detach({ tabId }), new Promise(r => setTimeout(r, 2000))]); }
      catch {}
    }
  }
}
