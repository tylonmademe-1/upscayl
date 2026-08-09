const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { BIN_PATH, MODELS_DIR, PYTHON } = require("./config");

function scanModels() {
  const found = new Set();
  try {
    for (const f of fs.readdirSync(MODELS_DIR)) {
      if (f.endsWith(".param")) {
        const name = f.slice(0, -6);
        if (fs.existsSync(path.join(MODELS_DIR, name + ".bin"))) found.add(name);
      }
    }
  } catch {}
  return [...found].sort();
}

function parseProgress(line, last) {
  const m = line.match(/(\d+(?:\.\d+)?)%/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : last;
}

function runUpscayl({ input, output, model, scale, tile, threads, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-i",
      input,
      "-o",
      output,
      "-n",
      model,
      "-s",
      String(scale),
      "-m",
      MODELS_DIR,
      "-g",
      "0",
      "-f",
      "png",
      "-t",
      String(tile),
    ];
    if (threads) args.push("-j", threads);
    const proc = spawn(BIN_PATH, args, { windowsHide: true });
    let stderr = "";
    let last = 0;
    proc.stdout.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        const p = parseProgress(line, last);
        if (p !== null) {
          last = p;
          if (onProgress) onProgress(p);
        }
      }
    });
    proc.stderr.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      const p = parseProgress(text, last);
      if (p !== null) {
        last = p;
        if (onProgress) onProgress(p);
      }
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(output)) resolve();
      else reject(stderr.trim() || `upscayl-bin exited with code ${code}`);
    });
  });
}

function runPython(script, args, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [script, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let last = 0;
    proc.stdout.on("data", (d) => {
      const text = d.toString();
      for (const line of text.split("\n")) {
        const m = line.match(/^PROGRESS:(\d+(?:\.\d+)?)/);
        if (m) {
          last = parseFloat(m[1]);
          if (onProgress) onProgress(last);
        }
      }
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(stderr.trim().slice(-800) || `python exited with code ${code}`);
    });
  });
}

module.exports = { scanModels, runUpscayl, runPython };
