import sys
import os
import math
import shutil

import cv2
import numpy as np
from PIL import Image

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
GFPGAN_URL = "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth"
GFPGAN_PATH = os.path.join(MODEL_DIR, "GFPGANv1.4.pth")
HAAR_PATH = os.path.join(MODEL_DIR, "haarcascade_frontalface_default.xml")


def log_progress(p):
    print(f"PROGRESS:{p:.1f}", flush=True)


def load_model():
    import spandrel
    if not os.path.exists(GFPGAN_PATH):
        raise FileNotFoundError(f"GFPGAN weights missing: {GFPGAN_PATH}")
    arch = spandrel.ModelDescriptor.from_file(GFPGAN_PATH)
    return arch.load_model()


def load_haar():
    import cv2 as _cv2
    candidates = [
        HAAR_PATH,
        os.path.join(os.path.dirname(cv2.__file__), "data", "haarcascade_frontalface_default.xml"),
        os.path.join(os.path.dirname(cv2.__file__), "data", "haarcascade_frontalface_alt2.xml"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return _cv2.CascadeClassifier(c)
    return None


def run_torch(model, pil_crop):
    import torch
    model.eval()
    x = np.array(pil_crop.convert("RGB")).astype(np.float32) / 255.0
    x = torch.from_numpy(x).permute(2, 0, 1).unsqueeze(0)
    with torch.no_grad():
        y = model(x)
    if isinstance(y, (tuple, list)):
        y = y[0]
    y = y.squeeze(0).permute(1, 2, 0).clamp(0, 1).numpy()
    return Image.fromarray((y * 255).astype(np.uint8))


def feather_mask(size, pad):
    import numpy as _np
    m = _np.zeros((size[1], size[0]), dtype=_np.float32)
    p = int(pad)
    m[p:-p, p:-p] = 1.0
    m = cv2.GaussianBlur(m, (0, 0), max(2, p // 3))
    return np.clip(m, 0, 1)


def main():
    if len(sys.argv) < 3:
        print("usage: face_enhance.py <input> <output>")
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]
    if src == dst:
        sys.exit(0)
    try:
        model = load_model()
    except Exception as e:
        shutil.copyfile(src, dst)
        print(f"face model unavailable: {e}", file=sys.stderr)
        sys.exit(0)

    cascade = load_haar()
    img = Image.open(src).convert("RGB")
    arr = np.array(img)
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    faces = []
    if cascade is not None:
        for scale in (1.1, 1.05):
            det = cascade.detectMultiScale(gray, scaleFactor=scale, minNeighbors=4, minSize=(48, 48))
            for (x, y, w, h) in det:
                faces.append((x, y, w, h))
            if faces:
                break
    if not faces:
        shutil.copyfile(src, dst)
        print("no faces detected", file=sys.stderr)
        sys.exit(0)

    n = len(faces)
    out = img.copy()
    for i, (x, y, w, h) in enumerate(faces):
        log_progress((i / n) * 90)
        pad = int(0.35 * max(w, h))
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(arr.shape[1], x + w + pad), min(arr.shape[0], y + h + pad)
        crop = img.crop((x0, y0, x1, y1))
        crop = crop.resize((max(128, crop.width // 8 * 8), max(128, crop.height // 8 * 8)), Image.LANCZOS)
        restored = run_torch(model, crop)
        restored = restored.resize((x1 - x0, y1 - y0), Image.LANCZOS)
        mask = feather_mask((x1 - x0, y1 - y0), pad)
        region = out.crop((x0, y0, x1, y1)).convert("RGB")
        blended = Image.fromarray(
            (restored * mask[..., None] + region * (1 - mask[..., None])).astype(np.uint8)
        )
        out.paste(blended, (x0, y0))
        log_progress(((i + 1) / n) * 90)

    out.save(dst)
    log_progress(100)


if __name__ == "__main__":
    main()
