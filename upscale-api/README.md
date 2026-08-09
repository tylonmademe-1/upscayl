# Upscale API — forked & tuned from Upscayl

A local AI image upscaling API + single-page mobile UI, powered by the exact engine the
Upscayl app uses (`upscayl-bin.exe`, ncnn Vulkan). Runs on your PC and is usable from
**PC browser and phone on the same Wi-Fi** — no cloud.

## What's inside

- **Engine**: `upscayl-bin.exe` (Upscayl ncnn Vulkan), with a **CPU fallback**
  (`python/cpu_upscale.py`, torch + spandrel) used automatically if Vulkan is unavailable
- **Changed upscaling logic** (`lib/pipeline.js`):
  - Smart auto model — content is inspected (stats-based) and the model is chosen:
    photo → `upscayl-standard-4x`, anime → `realesr-animevideov3-x4`,
    flat/vector → `upscayl-lite-4x`, plus manual presets (auto/photo/anime/fast/hifi)
  - Smart denoise — auto pre-blur when noise is detected, or manual 0–100
  - Sharpening polish — masked smart-sharpen + optional saturation after upscale
  - Face enhance pass (GFPGANv1.4, multi-face, feathered blend) before upscaling
  - Auto pre-downscale of huge images (OOM safety on iGPUs)
  - Batch queue, cancel, side-by-side before/after, PNG/JPEG/WebP output
- **API**: `POST /api/upload` → job → SSE live progress → result download
- **UI**: dark, monochrome, professional, phone-first, batch upload, PIN gate

## Quick start (Windows)

```powershell
npm install
npm start          # or double-click start.bat
```

Open the URL printed in the console (or scan the QR code) from your phone.
PIN is printed at startup (set `UPSCAYL_REQUIRE_PIN=1` to enforce it).

First run needs Python deps:

```powershell
pip install torch spandrel opencv-python-headless pillow numpy
```

### Files you need (see `.gitignore` — large weights are not committed)

| Path | Source |
|---|---|
| `models/*.param/bin` | Upscayl app package (`resources/models`): upscayl-standard-4x, upscayl-lite-4x, high-fidelity-4x, remacri-4x, ultramix-balanced-4x, ultrasharp-4x, digital-art-4x + `realesr-animevideov3-x4` from the upscayl repo `models/` |
| `bin/upscayl-bin-20251207-174704-windows/upscayl-bin.exe` | upscayl/upscayl-ncnn release |
| `python/models/GFPGANv1.4.pth` | TencentARC/GFPGAN release v1.3.0 (face enhance) |
| `python/models/RealESRGAN_x4plus.pth`, `RealESRGAN_x4plus_anime_6B.pth` | xinntao/Real-ESRGAN releases (CPU fallback) |

## API

| Endpoint | Description |
|---|---|
| `POST /api/upload` | multipart `image` + optional `scale` (2/3/4), `model` (auto/photo/anime/fast/hifi), `denoise` (auto or 0–1), `sharpen` (0–1), `saturation`, `face`, `format` (png/jpg/webp), `quality` (60–100), `sideBySide` → `{id}` |
| `GET /api/jobs/:id` | status + progress |
| `GET /api/jobs/:id/stream` | SSE live progress |
| `GET /api/jobs/:id/result` | upscaled image (download) |
| `GET /api/jobs/:id/side` | before/after JPEG |
| `POST /api/jobs/:id/cancel` | cancel a queued job |
| `GET /api/jobs` | recent jobs |
| `GET /api/models`, `GET /api/health` | metadata |

Example:

```bash
curl -F "image=@photo.jpg" -F "scale=4" -F "model=auto" -F "face=true" http://<PC-IP>:3000/api/upload
curl http://<PC-IP>:3000/api/jobs/<id>
curl -o result.png http://<PC-IP>:3000/api/jobs/<id>/result
```

## Env vars

`PORT` (default 3000), `HOST` (default 0.0.0.0), `UPSCAYL_REQUIRE_PIN=1` (enforce PIN),
`UPSCAYL_PIN` (fixed PIN), `PYTHON` (python executable).

## Files

```
upscale-api/
  server.js            express API + queue + SSE + static UI
  lib/config.js        paths, PIN, presets
  lib/jobs.js          job queue
  lib/engine.js        upscayl-bin runner + python runner + model scan
  lib/pipeline.js      smart pipeline (auto model, denoise, sharpen, face, formats)
  python/cpu_upscale.py   CPU fallback engine (spandrel)
  python/face_enhance.py  GFPGAN face enhance
  public/index.html    monochrome mobile-first UI
  start.bat           run server
  firewall-on.bat     allow TCP 3000 (run as admin)
```