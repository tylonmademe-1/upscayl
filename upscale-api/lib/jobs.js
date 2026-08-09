const { EventEmitter } = require("events");
const { jobId, JOB_TTL_MS, RESULTS_DIR, JOBS_DIR } = require("./config");

const jobs = new Map();
const queue = [];
const emitter = new EventEmitter();
let active = null;

function create(inputPath, originalName, options) {
  const job = {
    id: jobId(),
    inputPath,
    originalName,
    options,
    status: "queued",
    stage: "waiting",
    progress: 0,
    etaSec: null,
    queuePos: 0,
    createdAt: Date.now(),
    finishedAt: null,
    resultPath: null,
    resultName: null,
    outputFormat: null,
    error: null,
    engine: null,
    model: null,
    scale: null,
    durationMs: null,
    width: null,
    height: null,
    outWidth: null,
    outHeight: null,
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  updateQueuePositions();
  return job;
}

function get(id) {
  return jobs.get(id);
}

function list() {
  return [...jobs.values()]
    .filter((j) => Date.now() - j.createdAt < JOB_TTL_MS)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30)
    .map(sanitize);
}

function sanitize(job) {
  const { inputPath, resultPath, ...rest } = job;
  return rest;
}

function next() {
  if (active) return;
  while (queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || job.status === "cancelled") continue;
    active = job;
    job.status = "processing";
    updateQueuePositions();
    emitter.emit("change", job);
    return job;
  }
}

function finish(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { finishedAt: Date.now() });
  active = null;
  emitter.emit("change", job);
}

function fail(id, error) {
  finish(id, { status: "error", error: String(error).slice(0, 500) });
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === "queued") {
    job.status = "cancelled";
    job.finishedAt = Date.now();
    emitter.emit("change", job);
    return true;
  }
  return false;
}

function progress(id, patch) {
  const job = jobs.get(id);
  if (!job || job.status !== "processing") return;
  Object.assign(job, patch);
  emitter.emit("change", job);
}

function subscribe(id, res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const send = (job) => {
    if (job && job.id !== id) return;
    res.write(`data: ${JSON.stringify(sanitize(job || jobs.get(id)))}\n\n`);
  };
  emitter.on("change", send);
  send();
  const t = setInterval(() => res.write(": ping\n\n"), 15000);
  res.on("close", () => {
    clearInterval(t);
    emitter.off("change", send);
  });
}

function updateQueuePositions() {
  queue.forEach((id, i) => {
    const job = jobs.get(id);
    if (job && job.status === "queued") {
      job.queuePos = i + 1;
      emitter.emit("change", job);
    }
  });
}

function currentJob() {
  return active;
}

module.exports = {
  jobs,
  create,
  get,
  list,
  next,
  finish,
  fail,
  cancel,
  progress,
  subscribe,
  currentJob,
  sanitize,
};
