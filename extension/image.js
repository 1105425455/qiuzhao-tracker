export function fitImage(width, height, limit = 800) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('截图尺寸无效');
  const scale = Math.min(1, limit / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export async function resizeScreenshot(base64) {
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  try {
    const size = fitImage(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const data = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
    return `data:image/png;base64,${btoa(binary)}`;
  } finally { bitmap.close(); }
}
