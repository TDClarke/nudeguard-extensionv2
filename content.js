// NudeGuard – Content Script v2.1 (ONNX classifier with Image, GIF & Video Support)
// Classification is handled in background.js using ORT + open_nsfw.onnx
// This script handles: discovery, hold/shimmer, frame extraction, periodic sampling, blur/overlay

(function () {
  'use strict';

  const LOG  = (...a) => console.log('[NudeGuard]', ...a);
  const WARN = (...a) => console.warn('[NudeGuard]', ...a);

  let settings = { enabled: true, blurIntensity: 20, sensitivity: 0.7 };
  let sessionStats = { blurred: 0, scanned: 0, skipped: 0 };
  const processedElements = new WeakSet();
  const mediaSamplers = new WeakMap(); // Holds sampling timers for videos and GIFs
  const QUEUE_DELAY = 100;
  let queue = [];
  let processing = false;

  // ── Boot ──────────────────────────────────────────────────────────────────────
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
    if (chrome.runtime.lastError) { WARN('Settings error:', chrome.runtime.lastError.message); return; }
    if (resp) settings = { ...settings, ...resp };
    LOG(`Booted v2.1 (Images, GIFs & Videos). enabled=${settings.enabled} sensitivity=${settings.sensitivity} blur=${settings.blurIntensity}px`);
    if (settings.enabled) init();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled !== undefined) {
      settings.enabled = changes.enabled.newValue;
      if (!settings.enabled) removeAllBlurs(); else scanAllMedia();
    }
    if (changes.blurIntensity) settings.blurIntensity = changes.blurIntensity.newValue;
    if (changes.sensitivity)   settings.sensitivity   = changes.sensitivity.newValue;
    updateExistingBlurs();
  });

  // ── Init ──────────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    const media = document.querySelectorAll('img, video');
    LOG(`Page loaded. Found ${media.length} media elements (images/GIFs/videos).`);
    media.forEach(enqueue);
    observeDOM();
  }

  function scanAllMedia() { document.querySelectorAll('img, video').forEach(enqueue); }

  function observeDOM() {
    const mo = new MutationObserver((mutations) => {
      if (!settings.enabled) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'IMG' || node.tagName === 'VIDEO') enqueue(node);
          if (node.querySelectorAll) node.querySelectorAll('img, video').forEach(enqueue);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ── Styles ────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('nudeguard-styles')) return;
    const s = document.createElement('style');
    s.id = 'nudeguard-styles';
    s.textContent = `
      @keyframes ng-shimmer {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      .nudeguard-shimmer {
        position: absolute; inset: 0; border-radius: 4px;
        background: linear-gradient(90deg, #1c1c2e 25%, #2e2e50 50%, #1c1c2e 75%);
        background-size: 200% 100%;
        animation: ng-shimmer 1.4s linear infinite;
        z-index: 1; pointer-events: none;
      }
      .nudeguard-scanning-icon {
        position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        font-size: 1.2em; z-index: 2; pointer-events: none;
        animation: ng-pulse 1.2s ease-in-out infinite;
      }
      @keyframes ng-pulse {
        0%, 100% { opacity: 0.5; transform: translate(-50%,-50%) scale(0.9); }
        50%       { opacity: 1;   transform: translate(-50%,-50%) scale(1.1); }
      }
    `;
    document.head.appendChild(s);
  }

  // ── Dimensions & Hold / Release ───────────────────────────────────────────────
  function getMediaDimensions(el) {
    if (el.tagName === 'IMG') {
      return { width: el.naturalWidth || el.offsetWidth, height: el.naturalHeight || el.offsetHeight };
    } else if (el.tagName === 'VIDEO') {
      return { width: el.videoWidth || el.offsetWidth, height: el.videoHeight || el.offsetHeight };
    }
    return { width: 0, height: 0 };
  }

  function holdElement(el) {
    const src = el.src || el.currentSrc || el.poster;
    if (!src || el.getAttribute('data-nudeguard')) return;
    const dim = getMediaDimensions(el);
    if (dim.width > 0 && dim.width < 100 && dim.height > 0 && dim.height < 100) return;
    if (el.parentElement && el.parentElement.classList.contains('nudeguard-wrap')) return;

    el.setAttribute('data-nudeguard', 'pending');
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.35s ease';

    const wrap = document.createElement('div');
    wrap.className = 'nudeguard-wrap';
    Object.assign(wrap.style, {
      position: 'relative', display: 'inline-block', lineHeight: '0', maxWidth: '100%',
      width:  el.offsetWidth  ? el.offsetWidth  + 'px' : 'auto',
      height: el.offsetHeight ? el.offsetHeight + 'px' : 'auto',
    });

    const shimmer = document.createElement('div');
    shimmer.className = 'nudeguard-shimmer';
    const icon = document.createElement('div');
    icon.className = 'nudeguard-scanning-icon';
    icon.textContent = '🛡️';

    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(shimmer);
    wrap.appendChild(icon);
    wrap.appendChild(el);
  }

  function releaseElement(el) {
    const wrap = el.parentElement;
    if (wrap && wrap.classList.contains('nudeguard-wrap')) {
      wrap.querySelector('.nudeguard-shimmer')?.remove();
      wrap.querySelector('.nudeguard-scanning-icon')?.remove();
    }
    el.style.opacity = '1';
    if (el.getAttribute('data-nudeguard') !== 'blurred') {
      el.removeAttribute('data-nudeguard');
    }
  }

  // ── Queue ─────────────────────────────────────────────────────────────────────
  function enqueue(el) {
    if (processedElements.has(el)) return;
    processedElements.add(el);

    if (el.tagName === 'IMG') {
      if (!el.complete || !el.naturalWidth) {
        el.addEventListener('load', () => { holdElement(el); pushToQueue(el); }, { once: true });
      } else {
        holdElement(el);
        pushToQueue(el);
      }
    } else if (el.tagName === 'VIDEO') {
      if (el.readyState < 2) { // HAVE_CURRENT_DATA
        el.addEventListener('loadeddata', () => { holdElement(el); pushToQueue(el); }, { once: true });
        el.addEventListener('play', () => { holdElement(el); pushToQueue(el); }, { once: true });
      } else {
        holdElement(el);
        pushToQueue(el);
      }
      setupVideoListeners(el);
    }
  }

  function pushToQueue(el) {
    queue.push(el);
    if (!processing) processNext();
  }

  function processNext() {
    if (!queue.length) {
      processing = false;
      LOG(`Queue cycle done. Scanned: ${sessionStats.scanned} Blurred: ${sessionStats.blurred} Skipped: ${sessionStats.skipped}`);
      return;
    }
    processing = true;
    const el = queue.shift();
    analyzeMedia(el).finally(() => setTimeout(processNext, QUEUE_DELAY));
  }

  // ── Analysis ──────────────────────────────────────────────────────────────────
  // Note: .gif is no longer skipped!
  const SKIP_EXTS = /\.(ico|svg|cur|bmp)(\?|#|$)/i;

  function isGif(el) {
    const src = el.src || el.currentSrc || '';
    return /\.gif(\?|#|$)/i.test(src);
  }

  async function analyzeMedia(el) {
    const src = el.src || el.currentSrc || el.poster || '';
    if (!src || src.startsWith('chrome-extension://')) { releaseElement(el); return; }
    if (SKIP_EXTS.test(src)) { LOG(`Skip (type): ${shortUrl(src)}`); releaseElement(el); return; }

    const dim = getMediaDimensions(el);
    if (dim.width > 0 && dim.width < 100 && dim.height > 0 && dim.height < 100) {
      releaseElement(el); return;
    }

    // Attempt direct canvas frame extraction
    let dataUrl = tryCanvasDataUrl(el);

    // Image fallback: CORS fetch & Background Service Worker fetch
    if (!dataUrl && el.tagName === 'IMG') {
      try {
        const resp = await fetch(src, { mode: 'cors', credentials: 'omit' });
        if (resp.ok) {
          const blob = await resp.blob();
          dataUrl = await blobToDataUrl(blob);
        }
      } catch (_) {}

      if (!dataUrl) {
        try {
          dataUrl = await fetchViaBackground(src);
        } catch (err) {
          WARN(`Fetch failed: ${shortUrl(src)} — ${err.message}`);
          sessionStats.skipped++;
          releaseElement(el);
          return;
        }
      }
    }

    // Video fallback: Try poster or background fetch
    if (!dataUrl && el.tagName === 'VIDEO') {
      if (el.poster) {
        try { dataUrl = await fetchViaBackground(el.poster); } catch (_) {}
      }
      if (!dataUrl) {
        try { dataUrl = await fetchViaBackground(src); } catch (err) {
          WARN(`Video frame fetch failed: ${shortUrl(src)} — ${err.message}`);
          sessionStats.skipped++;
          releaseElement(el);
          return;
        }
      }
    }

    if (!dataUrl) { releaseElement(el); return; }

    // Run ONNX inference via background service worker
    LOG(`Classifying (${el.tagName.toLowerCase()}): ${shortUrl(src)}`);
    let scores;
    try {
      const resp = await sendMessage({ type: 'CLASSIFY_IMAGE', dataUrl });
      if (resp.error) throw new Error(resp.error);
      scores = resp.scores;
    } catch (err) {
      WARN(`Classification failed: ${err.message}`);
      sessionStats.skipped++;
      releaseElement(el);
      return;
    }

    sessionStats.scanned++;
    const { sfw, nsfw } = scores;
    LOG(`NSFW=${(nsfw * 100).toFixed(1)}% SFW=${(sfw * 100).toFixed(1)}% [${el.tagName}]: ${shortUrl(src)}`);

    if (nsfw >= settings.sensitivity) {
      applyBlur(el);
      sessionStats.blurred++;
      syncStats();
      stopSampling(el); // Stop further periodic sampling once blurred
    } else {
      releaseElement(el);
      // For animated GIFs, schedule periodic frame checks
      if (isGif(el) && !mediaSamplers.has(el)) {
        startGifSampling(el);
      }
    }
  }

  // ── Periodic Frame Sampling for Videos & Animated GIFs ──────────────────────
  function setupVideoListeners(video) {
    video.addEventListener('play', () => startVideoSampling(video));
    video.addEventListener('pause', () => stopSampling(video));
    video.addEventListener('ended', () => stopSampling(video));
    video.addEventListener('seeked', () => {
      if (!video.paused && video.getAttribute('data-nudeguard') !== 'blurred') {
        analyzeMedia(video);
      }
    });
  }

  function startVideoSampling(video) {
    if (stopSampling(video)) return;
    if (video.getAttribute('data-nudeguard') === 'blurred') return;

    // Sample video frame every 1.5 seconds during playback
    const timer = setInterval(() => {
      if (video.paused || video.ended || video.getAttribute('data-nudeguard') === 'blurred') {
        stopSampling(video);
        return;
      }
      analyzeMedia(video);
    }, 1500);

    mediaSamplers.set(video, timer);
  }

  function startGifSampling(gifImg) {
    let checkCount = 0;
    const MAX_GIF_CHECKS = 8; // Sample up to 8 frame intervals across loops

    const timer = setInterval(() => {
      checkCount++;
      if (checkCount > MAX_GIF_CHECKS || gifImg.getAttribute('data-nudeguard') === 'blurred') {
        stopSampling(gifImg);
        return;
      }
      analyzeMedia(gifImg);
    }, 1500);

    mediaSamplers.set(gifImg, timer);
  }

  function stopSampling(el) {
    if (mediaSamplers.has(el)) {
      clearInterval(mediaSamplers.get(el));
      mediaSamplers.delete(el);
      return true;
    }
    return false;
  }

  // ── Fetch Helpers ─────────────────────────────────────────────────────────────
  function tryCanvasDataUrl(el) {
    try {
      let w = 0, h = 0;
      if (el.tagName === 'IMG') {
        w = el.naturalWidth; h = el.naturalHeight;
      } else if (el.tagName === 'VIDEO') {
        if (el.readyState < 2) return null; // HAVE_CURRENT_DATA required
        w = el.videoWidth; h = el.videoHeight;
      }

      if (!w || !h) return null;

      const MAX = 512;
      const scale = Math.min(1, MAX / Math.max(w, h));
      const sw = Math.max(1, Math.floor(w * scale));
      const sh = Math.max(1, Math.floor(h * scale));

      const canvas = document.createElement('canvas');
      canvas.width = sw; canvas.height = sh;
      canvas.getContext('2d').drawImage(el, 0, 0, sw, sh);

      return canvas.toDataURL('image/jpeg', 0.85);
    } catch (_) {
      return null;
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  function fetchViaBackground(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (resp?.dataUrl) return resolve(resp.dataUrl);
        reject(new Error(resp?.error || 'no dataUrl'));
      });
    });
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    });
  }

  // ── Blur / Overlay ────────────────────────────────────────────────────────────
  function blurValue() { return `blur(${settings.blurIntensity}px)`; }

  function applyBlur(el) {
    const wrap = el.parentElement;
    if (wrap && wrap.classList.contains('nudeguard-wrap')) {
      wrap.querySelector('.nudeguard-shimmer')?.remove();
      wrap.querySelector('.nudeguard-scanning-icon')?.remove();
    }
    el.setAttribute('data-nudeguard', 'blurred');
    el.style.opacity = '1';
    el.style.filter = blurValue();
    el.style.transition = 'opacity 0.3s ease, filter 0.4s ease';
    addRevealOverlay(el);
  }

  function addRevealOverlay(el) {
    const wrap = el.parentElement;
    if (!wrap || !wrap.classList.contains('nudeguard-wrap')) return;
    if (wrap.querySelector('.nudeguard-badge')) return;

    const badge = document.createElement('div');
    badge.className = 'nudeguard-badge';
    badge.innerHTML = `
      <span style="font-size:1.4em">🛡️</span>
      <span style="font-size:11px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.8);font-family:system-ui,sans-serif">Protected by NudeGuard</span>
    `;
    Object.assign(badge.style, {
      position:'absolute', inset:'0', display:'flex', flexDirection:'column',
      alignItems:'center', justifyContent:'center', gap:'5px',
      zIndex:'2147483647', pointerEvents:'none'
    });
    wrap.appendChild(badge);
  }

  function removeAllBlurs() {
    document.querySelectorAll('[data-nudeguard]').forEach((el) => {
      stopSampling(el);
      el.style.filter = '';
      el.style.opacity = '1';
      el.removeAttribute('data-nudeguard');
      const wrap = el.parentElement;
      if (wrap?.classList.contains('nudeguard-wrap')) {
        wrap.querySelector('.nudeguard-shimmer')?.remove();
        wrap.querySelector('.nudeguard-scanning-icon')?.remove();
        wrap.querySelector('.nudeguard-badge')?.remove();
      }
    });
  }

  function updateExistingBlurs() {
    document.querySelectorAll('[data-nudeguard="blurred"]').forEach((el) => {
      el.style.filter = blurValue();
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function shortUrl(u) { try { return new URL(u).pathname.slice(-50); } catch(_) { return String(u).slice(-50); } }

  let syncTimer;
  function syncStats() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'UPDATE_STATS', blurred: sessionStats.blurred, scanned: sessionStats.scanned });
      sessionStats.blurred = 0; sessionStats.scanned = 0;
    }, 2000);
  }

})();