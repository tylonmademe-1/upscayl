const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { spawn } = require("child_process");
const { runUpscayl, runPython } = require("./engine");
const {
  MODELS_DIR,
  MAX_INPUT_PIXELS,
  PYTHON,
  MODEL_PRESETS,
} = require("./config");

const MODEL_FILES = {
  photo: "upscayl-standard-4x",
  anime: "realesr-animevideov3-x4",
  fast: "upscayl-lite-4x",
  hifi: "high-fidelity-4x",
};

function pickTile(width, height) {
  const pixels = width * height;
  if (pixels < 1_000_000) return 256;
  if (pixels < 4_000_000) return 192;
  return 128;
}

async function inspect(path) {
  const meta = await sharp(path).rotate().metadata();
  const stats = await sharp(path).rotate().stats();
  const c = stats.channels;
  const grayStd =
    (c[0].stdev + c[1].stdev + c[2].stdev) / 3;
  const sat =
    (Math.abs(c[0].mean - c[1].mean) +
      Math.abs(c[1].mean - c[2].mean) +
      Math.abs(c[2].mean - c[0].mean)) /
    3;
  return {
    width: meta.width,
    height: meta.height,
    grayStd,
    sat,
    entropy: (c[0].entropy + c[1].entropy + c[2].entropy) / 3,
  };
}

function classifyType(info, model) {
  if (model !== "auto") return model;
  if (info.grayStd < 12 || (info.sat < 0.06 && info.entropy > 6)) return "fast";
  if (info.sat < 0.12 && info.entropy < 6.5) return "anime";
  return "photo";
}

function resolveModel(preset) {
  if (MODEL_PRESETS[preset] && MODEL_PRESETS[preset].files) {
    return MODEL_PRESETS[preset].files;
  }
  return MODEL_FILES[preset] || MODEL_FILES.photo;
}

function modelFileExists(modelName) {
  return (
    fs.existsSync(path.join(MODELS_DIR, modelName + ".param")) &&
    fs.existsSync(path.join(MODELS_DIR, modelName + ".bin"))
  );
}

async function preProcess(inputPath, workPath, info, options, onStage) {
  onStage("preparing");
  let pipeline = sharp(inputPath).rotate().removeAlpha();
  let needs = false;
  const pixels = info.width * info.height;
  if (pixels > MAX_INPUT_PIXELS) {
    const ratio = Math.sqrt(MAX_INPUT_PIXELS / pixels);
    pipeline = pipeline.resize(Math.max(1, Math.round(info.width * ratio)));
    needs = true;
  }
  const denoise = options.denoise;
  if (denoise === "auto" || (typeof denoise === "number" && denoise > 0)) {
    let sigma = 0;
    if (typeof denoise === "number") sigma = Math.min(1.2, denoise * 1.2);
    else if (info.grayStd > 34) sigma = 0.35;
    if (sigma > 0) {
      pipeline = pipeline.blur(sigma);
      needs = true;
    }
  }
  if (needs) {
    await pipeline.toFile(workPath);
  } else {
    fs.copyFileSync(inputPath, workPath);
  }
}

async function enhanceFaces(workPath, onStage) {
  const script = path.join(__dirname, "..", "python", "face_enhance.py");
  if (!fs.existsSync(script)) return false;
  onStage("faces");
  try {
    const out = workPath + ".faces.png";
    await runPython(script, [workPath, out]);
    if (fs.existsSync(out)) {
      fs.renameSync(out, workPath);
      return true;
    }
  } catch {}
  return false;
}

async function postProcess(workPath, resultPath, info, options, outW, outH) {
  let pipeline = sharp(workPath);
  const scale = options.scale;
  let sigma = scale >= 4 ? 1.15 : scale >= 3 ? 0.9 : 0.7;
  const sharpen = options.sharpen;
  if (sharpen !== 0) {
    const amt = typeof sharpen === "number" ? sharpen : 1;
    pipeline = pipeline.sharpen({
      sigma,
      flat: 1,
      jagged: amt >= 1 ? 0.6 : 0.2,
    });
  }
  const sat = options.saturation;
  if (sat && sat !== 1) {
    pipeline = pipeline.modulate({ saturation: Math.max(0.5, Math.min(1.4, sat)) });
  }
  const fmt = options.format || "png";
  const quality = options.quality || 92;
  let encoded;
  if (fmt === "jpg" || fmt === "jpeg") {
    encoded = pipeline.jpeg({ quality, mozjpeg: true });
  } else if (fmt === "webp") {
    encoded = pipeline.webp({ quality });
  } else {
    encoded = pipeline.png({ compressionLevel: 6 });
  }
  const meta = await encoded.metadata().then((m) => ({
    width: m.width,
    height: m.height,
  }));
  await encoded.toFile(resultPath);
  return meta;
}

async function buildSideBySide(inputPath, resultPath, outPath) {
  const h = 480;
  const a = await sharp(inputPath)
    .rotate()
    .resize({ height: h, withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });
  const b = await sharp(resultPath)
    .resize({ height: h, withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });
  const aH = Math.min(h, a.info.height);
  const bH = Math.min(h, b.info.height);
  const height = Math.max(aH, bH);
  const left = sharp(a.data).resize({ height, width: Math.round(a.info.width * (height / aH)) });
  const right = sharp(b.data).resize({ height, width: Math.round(b.info.width * (height / bH)) });
  const metaL = await left.metadata();
  const metaR = await right.metadata();
  await sharp({
    create: {
      width: metaL.width + metaR.width,
      height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([
      { input: await left.toBuffer(), left: 0, top: 0 },
      { input: await right.toBuffer(), left: metaL.width, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toFile(outPath);
}

async function upscaleImage(job, inputPath, workPath, resultPath, onProgress) {
  const info = await inspect(inputPath);
  const options = job.options;
  const preset = options.model || "auto";
  const type = classifyType(info, preset);
  let model = resolveModel(type);
  if (!modelFileExists(model)) {
    for (const candidate of Object.values(MODEL_FILES)) {
      if (modelFileExists(candidate)) {
        model = candidate;
        break;
      }
    }
  }
  const scale = Math.min(4, Math.max(2, options.scale || 4));
  const tile = pickTile(info.width, info.height);
  job.engine = "upscayl-ncnn (Vulkan)";
  job.model = model;
  job.scale = scale;
  job.width = info.width;
  job.height = info.height;
  job.type = type;

  onProgress(0);
  await preProcess(inputPath, workPath, info, options, (s) => {
    job.stage = s;
  });
  onProgress(2);

  const facesApplied = options.face
    ? await enhanceFaces(workPath, (s) => {
        job.stage = s;
      })
    : false;
  if (facesApplied) {
    job.faceEnhanced = true;
  }
  onProgress(5);

  job.stage = "upscaling";
  const upOut = workPath + ".up.png";
  await runUpscayl({
    input: workPath,
    output: upOut,
    model,
    scale,
    tile,
    onProgress: (p) => {
      onProgress(5 + (p / 100) * 90);
    },
  });
  onProgress(95);

  job.stage = "polishing";
  const meta = await postProcess(upOut, resultPath, info, options);
  job.outWidth = meta.width;
  job.outHeight = meta.height;
  fs.unlinkSync(workPath);
  fs.unlinkSync(upOut);
  onProgress(100);
}

module.exports = { upscaleImage, buildSideBySide, inspect, classifyType };
