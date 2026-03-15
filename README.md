# 🛡️ NudeGuardv2

**AI-powered safe browsing extension for Chrome.**
Automatically detects and blurs explicit images using Yahoo's Open-NSFW model — entirely on-device, no data ever leaves your browser.

---

## Requirements

- Google Chrome (or any Chromium-based browser)
- `curl` and `tar` (for the setup script)

---

## Installation

### Step 1 — Download dependencies

Run the setup script once from inside the extension folder:

```bash
bash setup.sh
```

This downloads two things into the extension directory:

| What | Where |
|---|---|---|
| ONNX Runtime Web v1.17.3 + WASM | `lib/` |
| Yahoo open_nsfw.onnx model | `models/` |

### Step 2 — Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `nudeguard-extension/` folder
5. Pin the 🛡️ icon from the toolbar puzzle-piece menu

---

## Usage

The extension runs automatically on every page. When an image loads:

1. A **shimmer placeholder** replaces it while scanning
2. If the image is clean → it **fades in** normally
3. If the image is explicit → it stays **blurred** with a 🛡️ badge

Use the **popup** (click the toolbar icon) to adjust settings or toggle the shield on/off.

---

## Sensitivity Setting

The sensitivity slider controls the NSFW score threshold. The model outputs a score from 0 to 1 for every image.

| Sensitivity | Behaviour | Best for |
|---|---|---|
| **0.85+** | Catches only the most explicit content. Minimal false positives. | Low-interruption browsing |
| **0.70** ✦ | Catches most explicit content with few false positives. | **Recommended default** |
| **0.60** | Catches borderline content too (swimwear, suggestive poses). | Parental controls |
| **0.50** | Yahoo's original decision boundary. Most aggressive. | Strict filtering |

**Start at 0.70.** The model was benchmarked at 0.50, but in practice that produces false positives on skin-tone clothing, medical imagery, and swimwear. 0.70 is the community-established sweet spot.

---

## How It Works

```
Image appears on page
        │
        ▼
content.js — hold image, show shimmer
        │
        ├─ 1. Same-origin: draw to canvas → toDataURL()
        ├─ 2. CORS fetch() → blob → dataURL
        └─ 3. Background SW fetch (bypasses CORS entirely)
                        │
                        ▼
               dataURL ready
                        │
                        ▼
background.js — ONNX inference
  ┌─ Preprocess ────────────────────────────────┐
  │  decode → 256×256 → centre-crop 224×224     │
  │  swap RGB→BGR → subtract mean [104,117,123] │
  │  shape: [1, 224, 224, 3] float32 HWC        │
  └─────────────────────────────────────────────┘
        │
        ▼
  open_nsfw.onnx (ResNet-50)
        │
        ▼
  [sfw_prob, nsfw_prob]
        │
        ├─ nsfw >= sensitivity → blur + badge
        └─ nsfw <  sensitivity → fade in
```

### Why three fetch attempts?

Browser content scripts are subject to CORS — they can't read pixel data from cross-origin images (which is most images on the web). The three-stage fallback handles this:

- **Attempt 1** works on same-origin images (your own site, local files)
- **Attempt 2** works on CDNs that send `Access-Control-Allow-Origin` headers
- **Attempt 3** routes through the background service worker, which runs in a privileged extension context not bound by CORS — so it can fetch any URL covered by `host_permissions: <all_urls>`

---

## Model Details

Yahoo's Open-NSFW model was originally published as a Caffe model in 2016 and has become the standard baseline for browser-side NSFW detection. This extension uses an ONNX conversion from the `opennsfw-standalone` package.

| Property | Value |
|---|---|
| Architecture | ResNet-50 (Yahoo internal variant) |
| Training data | ~1 million images, Yahoo internal dataset |
| Input shape | `[1, 224, 224, 3]` — batch × height × width × channels |
| Channel order | BGR (not RGB) |
| Mean subtraction | `[104.0, 117.0, 123.0]` (B, G, R) |
| Output shape | `[1, 2]` — `[sfw_probability, nsfw_probability]` |
| Output activation | Softmax (sfw + nsfw always sum to 1.0) |
| Runtime | ONNX Runtime Web via WASM (single-threaded) |

---

## File Structure

```
nudeguard-extension/
├── manifest.json          Chrome extension manifest (MV3)
├── background.js          Service worker: ONNX inference engine + CORS-free fetching
├── content.js             Page script: image discovery, shimmer, blur overlay
├── popup.html             Extension popup UI
├── popup.js               Popup logic (settings, stats)
├── setup.sh               One-time dependency download script
├── lib/
│   ├── ort.min.js         ONNX Runtime Web (UMD bundle)
│   ├── ort-wasm.wasm
│   ├── ort-wasm-simd.wasm
│   ├── ort-wasm-threaded.wasm
│   └── ort-wasm-simd-threaded.wasm
├── models/
│   └── open_nsfw.onnx     Yahoo Open-NSFW model (~13MB)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Privacy

- All inference runs locally in your browser via WebAssembly
- No images, scores, or metadata are sent anywhere
- No analytics, no telemetry, no remote calls of any kind
- Stats (images scanned/blurred) are stored locally in `chrome.storage.sync`

---

## Troubleshooting

**Extension loads but nothing is blurred**
Open DevTools (F12) on any page and look for `[NudeGuard]` log lines. If you see `Queue empty. Scanned: 0`, the model may still be loading — wait a few seconds and reload the page. The ONNX session takes 1–3 seconds to initialise on first use.

**`importScripts` error / model not found**
Make sure you ran `bash setup.sh` and that `lib/ort.min.js` and `models/open_nsfw.onnx` exist before loading the extension.

**High false positive rate**
Increase the sensitivity slider (try 0.80). Images with large areas of skin-tone colour (sunsets, wood textures, certain artwork) can score higher than expected.

**High false negative rate**
Decrease the sensitivity slider (try 0.60). Some content is genuinely borderline and the model may score it just under your threshold.
