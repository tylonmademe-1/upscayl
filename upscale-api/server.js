const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const qrcode = require("qrcode-terminal");

const config = require("./lib/config");
const jobsApi = require("./lib/jobs");
const { scanModels } = require("./lib/engine");
const { upscaleImage, buildSideBySide } = require("./lib/pipeline");

const app = express();
app.use(express.json());

fs.mkdirSync(config.JOBS_DIR, { recursive: true });
fs.mkdirSync(config.RESULTS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.JOBS_DIR),
    filename: (req, file, cb) =>
      cb(null, crypto.randomBytes(8).toString("hex") + path.extname(file.originalname || ".png")),
  }),
  limits: { fileSize: 60 * 1024 * 1024 },
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    engine: "upscayl-ncnn (Vulkan)",
    models: scanModels(),
  });
});

app.get("/api/models", (req, res) => {
  res.json({
    presets: Object.entries(config.MODEL_PRESETS).map(([id, p]) => ({ id, label: p.label })),
    files: scanModels(),
  });
});

app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "NO_FILE" });
  const opt = req.body || {};
  const options = {
    model: opt.model || "auto",
    scale: Math.min(4, Math.max(2, Number(opt.scale) || 4)),
    denoise: opt.denoise === undefined ? "auto" : opt.denoise,
    sharpen: opt.sharpen === undefined ? 1 : Number(opt.sharpen),
    saturation: opt.saturation === undefined ? 1 : Number(opt.saturation),
    face: opt.face === "1" || opt.face === "true" || opt.face === true,
    format: opt.format || "png",
    quality: Number(opt.quality) || 92,
    sideBySide: opt.sideBySide === "1" || opt.sideBySide === "true",
    fileName: req.file.originalname,
  };
  const job = jobsApi.create(req.file.path, req.file.originalname, options);
  res.json(jobsApi.sanitize(job));
  setTimeout(processNext);
});

app.get("/api/jobs", (req, res) => {
  res.json(jobsApi.list());
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobsApi.get(req.params.id);
  if (!job) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(jobsApi.sanitize(job));
});

app.get("/api/jobs/:id/stream", (req, res) => {
  const job = jobsApi.get(req.params.id);
  if (!job) return res.status(404).json({ error: "NOT_FOUND" });
  jobsApi.subscribe(job.id, res);
});

app.get("/api/jobs/:id/input", (req, res) => {
  const job = jobsApi.get(req.params.id);
  if (!job) return res.status(404).json({ error: "NOT_FOUND" });
  res.sendFile(job.inputPath);
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  res.json({ cancelled: jobsApi.cancel(req.params.id) });
});

app.get("/api/jobs/:id/result", (req, res) => {
  const job = jobsApi.get(req.params.id);
  if (!job) return res.status(404).json({ error: "NOT_FOUND" });
  if (job.status !== "done") {
    return res.status(409).json({ status: job.status });
  }
  res.download(job.resultPath, job.resultName);
});

app.get("/api/jobs/:id/side", async (req, res) => {
  const job = jobsApi.get(req.params.id);
  if (!job) return res.status(404).json({ error: "NOT_FOUND" });
  if (job.status !== "done") return res.status(409).json({ error: "NOT_READY" });
  const out = path.join(config.RESULTS_DIR, job.id + ".side.jpg");
  if (!fs.existsSync(out)) {
    try {
      await buildSideBySide(job.inputPath, job.resultPath, out);
    } catch {
      return res.status(500).json({ error: "SIDE_FAILED" });
    }
  }
  res.sendFile(out);
});

app.use(express.static(path.join(__dirname, "public")));

async function processNext() {
  const job = jobsApi.next();
  if (!job) return;
  const started = Date.now();
  const workPath = path.join(config.JOBS_DIR, job.id + ".work.png");
  const resultPath = path.join(config.RESULTS_DIR, job.id + ".out.png");
  const ext = job.options.format === "jpg" || job.options.format === "jpeg" ? "jpg" : job.options.format === "webp" ? "webp" : "png";
  job.resultName = (path.parse(job.originalName || "image").name || "image") + "_4x." + ext;
  try {
    await upscaleImage(
      job,
      job.inputPath,
      workPath,
      resultPath,
      (p) => {
        const elapsed = Date.now() - started;
        job.etaSec = p > 0 ? Math.round((elapsed / p) * (100 - p) / 1000) : null;
        jobsApi.progress(job.id, { progress: Math.min(100, Math.round(p)) });
      }
    );
    if (job.options.sideBySide) {
      try {
        await buildSideBySide(job.inputPath, resultPath, path.join(config.RESULTS_DIR, job.id + ".side.jpg"));
      } catch {}
    }
    job.resultPath = resultPath;
    job.durationMs = Date.now() - started;
    jobsApi.finish(job.id, { status: "done", progress: 100, stage: "done", etaSec: 0 });
  } catch (err) {
    try { fs.unlinkSync(workPath); } catch {}
    try { fs.unlinkSync(resultPath); } catch {}
    jobsApi.fail(job.id, err);
  }
  setTimeout(processNext, 50);
}

app.listen(config.PORT, config.HOST, () => {
  const models = scanModels();
  const ips = config.lanIPs();
  const url = `http://${ips[0] || "localhost"}:${config.PORT}`;
  console.log("");
  console.log("  UPSCAYL API  (forked + tuned)");
  console.log("  ──────────────────────────────");
  console.log("  Models loaded: " + models.length + "  " + (models.slice(0, 6).join(", ")));
  console.log("  API:  POST /api/upload   GET /api/jobs/:id   GET /api/jobs/:id/stream");
  console.log("        GET /api/jobs/:id/result   GET /api/models   GET /api/health");
  console.log("  UI:   " + url);
  if (ips.length) {
    console.log("");
    console.log("  Scan from phone (same Wi-Fi):");
    qrcode.generate(url, { small: true });
  }
  console.log("");
});
