const path = require("path");
const crypto = require("crypto");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const MODELS_DIR = path.join(ROOT, "models");
const TMP_DIR = path.join(ROOT, "tmp");
const RESULTS_DIR = path.join(TMP_DIR, "results");
const JOBS_DIR = path.join(TMP_DIR, "jobs");
const BIN_PATH = path.join(
  ROOT,
  "bin",
  "upscayl-bin-20251207-174704-windows",
  "upscayl-bin.exe"
);
const PYTHON = process.env.PYTHON || "python";
const MAX_INPUT_PIXELS = 16777216;
const JOB_TTL_MS = 30 * 60 * 1000;

const MODEL_PRESETS = {
  auto: { label: "Auto (smart)", files: null },
  photo: { label: "Photo (RealESRGAN 4x+)", files: "RealESRGAN_x4plus" },
  anime: { label: "Anime (AnimeVideo 4x)", files: "realesr-animevideov3-x4" },
  fast: { label: "Fast (General 4x)", files: "RealESRGAN_General_x4_v3" },
  hifi: { label: "High Fidelity (HFA2k)", files: "4xHFA2k" },
};

const FALLBACK_MODELS = [
  "RealESRGAN_x4plus",
  "RealESRGAN_x4plus_anime_6B",
  "realesr-animevideov3-x4",
  "RealESRGAN_General_x4_v3",
  "RealESRGAN_General_WDN_x4_v3",
  "4xHFA2k",
];

function lanIPs() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function jobId() {
  return crypto.randomBytes(4).toString("hex");
}

module.exports = {
  ROOT,
  PORT,
  HOST,
  MODELS_DIR,
  TMP_DIR,
  RESULTS_DIR,
  JOBS_DIR,
  BIN_PATH,
  PYTHON,
  MAX_INPUT_PIXELS,
  JOB_TTL_MS,
  MODEL_PRESETS,
  FALLBACK_MODELS,
  lanIPs,
  jobId,
};
