import sys
import os
import math

import numpy as np
from PIL import Image

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
X4PLUS_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
X4PLUS_PATH = os.path.join(MODEL_DIR, "RealESRGAN_x4plus.pth")
X4PLUS_ANIME_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth"
X4PLUS_ANIME_PATH = os.path.join(MODEL_DIR, "RealESRGAN_x4plus_anime_6B.pth")


def log_progress(p):
    print(f"PROGRESS:{p:.1f}", flush=True)


def load_model(path):
    import spandrel
    if not os.path.exists(path):
        raise FileNotFoundError(f"weights missing: {path}")
    return spandrel.ModelDescriptor.from_file(path).load_model()


def infer(model, pil_img, scale, tile_size, on_progress):
    import torch
    model.eval()
    arr = np.array(pil_img.convert("RGB")).astype(np.float32) / 255.0
    h, w, c = arr.shape
    tile = max(32, min(tile_size, 512))
    pad = tile // 4
    out_h, out_w = h * scale, w * scale
    result = np.zeros((out_h, out_w, 3), dtype=np.float32)
    weight = np.zeros((out_h, out_w, 1), dtype=np.float32)

    xs = list(range(0, w, tile - pad * 2))
    ys = list(range(0, h, tile - pad * 2))
    if xs[-1] + tile > w:
        xs[-1] = max(0, w - tile)
    if ys[-1] + tile > h:
        ys[-1] = max(0, h - tile)
    total = len(xs) * len(ys)
    done = 0
    for y0 in ys:
        for x0 in xs:
            x1 = min(w, x0 + tile)
            y1 = min(h, y0 + tile)
            crop = arr[y0:y1, x0:x1]
            inp = torch.from_numpy(crop).permute(2, 0, 1).unsqueeze(0)
            with torch.no_grad():
                out = model(inp)
            if isinstance(out, (tuple, list)):
                out = out[0]
            out = out.squeeze(0).permute(1, 2, 0).clamp(0, 1).numpy()

            ox0, oy0 = x0 * scale, y0 * scale
            ox1, oy1 = min(out_w, (x1) * scale), min(out_h, (y1) * scale)
            sx0 = (x0 - x0)
            patch = out[: oy1 - oy0, : ox1 - ox0]
            ph, pw = patch.shape[:2]
            if (ox1 - ox0) < pw:
                patch = patch[:, : ox1 - ox0]
            if (oy1 - oy0) < ph:
                patch = patch[: oy1 - oy0, :]
            result[oy0:oy1, ox0:ox1] += patch
            weight[oy0:oy1, ox0:ox1] += 1.0
            done += 1
            on_progress((done / total) * 100)
    result = result / np.maximum(weight, 1e-6)
    return Image.fromarray((result * 255).astype(np.uint8))


def main():
    if len(sys.argv) < 5:
        print("usage: cpu_upscale.py <input> <output> <model:photo|anime> <scale>")
        sys.exit(1)
    src, dst, model_key, scale_s = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    scale = max(2, min(4, int(scale_s)))
    path = X4PLUS_ANIME_PATH if model_key == "anime" else X4PLUS_PATH
    model = load_model(path)
    img = Image.open(src).convert("RGB")
    out = infer(model, img, scale, 128, log_progress)
    out.save(dst)
    log_progress(100)


if __name__ == "__main__":
    main()
