// NudeGuard – Background Service Worker v2.1 (ONNX / Yahoo Open-NSFW)
// Loads ONNX model and executes image/GIF/video frame classification

importScripts(chrome.runtime.getURL('lib/ort.min.js'));

ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/');
ort.env.wasm.numThreads = 1;

let session = null;
let sessionLoading = null;

async function getSession() {
  if (session) return session;
  if (sessionLoading) return sessionLoading;

  sessionLoading = (async () => {
    const modelUrl = chrome.runtime.getURL('models/open_nsfw.onnx');
    console.log('[NudeGuard] Loading ONNX model from', modelUrl);
    const t0 = Date.now();
    session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    console.log(`[NudeGuard] Model loaded in ${Date.now() - t0}ms`);
    return session;
  })();

  return sessionLoading;
}

getSession().catch((e) => console.error('[NudeGuard] Model load failed:', e));

async function preprocessDataUrl(dataUrl) {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  const canvas256 = new OffscreenCanvas(256, 256);
  canvas256.getContext('2d').drawImage(bitmap, 0, 0, 256, 256);
  bitmap.close();

  const CROP = 224;
  const OFFSET = (256 - CROP) / 2; // = 16
  const imgData = canvas256.getContext('2d').getImageData(OFFSET, OFFSET, CROP, CROP);
  const rgba = imgData.data;

  const MEAN_BGR = [104, 117, 123];
  const N = CROP * CROP;
  const float32 = new Float32Array(N * 3);

  for (let i = 0; i < N; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    float32[i * 3 + 0] = b - MEAN_BGR[0];
    float32[i * 3 + 1] = g - MEAN_BGR[1];
    float32[i * 3 + 2] = r - MEAN_BGR[2];
  }

  return new ort.Tensor('float32', float32, [1, CROP, CROP, 3]);
}

async function classify(dataUrl) {
  const sess = await getSession();
  const tensor = await preprocessDataUrl(dataUrl);
  const inputName = sess.inputNames[0];
  const results = await sess.run({ [inputName]: tensor });
  const outputName = sess.outputNames[0];
  const probs = results[outputName].data;
  return { sfw: probs[0], nsfw: probs[1] };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({
    enabled: true,
    blurIntensity: 20,
    sensitivity: 0.7,
    stats: { blurred: 0, scanned: 0 }
  });
  console.log('[NudeGuard] Extension installed (v2.1 ONNX).');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CLASSIFY_IMAGE') {
    classify(message.dataUrl)
      .then((scores) => sendResponse({ scores }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'FETCH_IMAGE') {
    fetch(message.url, { credentials: 'omit' })
      .then(async (resp) => {
        if (!resp.ok) { sendResponse({ error: `HTTP ${resp.status}` }); return; }
        const contentType = resp.headers.get('content-type') || 'image/jpeg';
        const buffer = await resp.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        sendResponse({ dataUrl: `data:${contentType};base64,${btoa(binary)}` });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'UPDATE_STATS') {
    chrome.storage.sync.get(['stats'], (result) => {
      const stats = result.stats || { blurred: 0, scanned: 0 };
      stats.blurred += message.blurred || 0;
      stats.scanned += message.scanned || 0;
      chrome.storage.sync.set({ stats });
      sendResponse({ success: true, stats });
    });
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    chrome.storage.sync.get(['enabled', 'blurIntensity', 'sensitivity', 'stats'], sendResponse);
    return true;
  }

  if (message.type === 'RESET_STATS') {
    chrome.storage.sync.set({ stats: { blurred: 0, scanned: 0 } }, () =>
      sendResponse({ success: true }));
    return true;
  }
});