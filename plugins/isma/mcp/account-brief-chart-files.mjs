import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BetaError } from "./core.mjs";
import { accountBriefChartInlineImage } from "./account-brief-chart-delivery.mjs";

export const TEMPORARY_CHART_TTL_MS = 15 * 60_000;
const ROOT_NAME = "csm-copilot-chart-delivery";
const RUN_NAME = /^run-[a-f0-9-]{36}$/;
const IMAGE_NAME = /^chart-[a-f0-9-]{36}\.png$/;
const RECORD = "retention.json";
const modulePath = fileURLToPath(import.meta.url);
const storageError = () => new BetaError("ACCOUNT_BRIEF_CHART_STORAGE_UNSAFE", "Temporary chart storage is not private or safe. Keep the verified tables; do not use another location.");
const cleanupError = () => new BetaError("ACCOUNT_BRIEF_CHART_CLEANUP_FAILED", "Temporary chart cleanup could not be verified. Do not create more chart files until cleanup is repaired.");

function privateNode(file, directory) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o077)) throw storageError();
  return stat;
}

function safeRoot(root, create = false) {
  if (!path.isAbsolute(root) || path.basename(root) !== ROOT_NAME) throw storageError();
  const parent = fs.realpathSync(path.dirname(root));
  for (let folder = parent; ; folder = path.dirname(folder)) {
    if (fs.existsSync(path.join(folder, ".git"))) throw storageError();
    if (folder === path.dirname(folder)) break;
  }
  if (create && !fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
  if (fs.existsSync(root)) privateNode(root, true);
  return path.join(parent, ROOT_NAME);
}

function retention(directory) {
  const root = safeRoot(path.dirname(directory));
  if (path.dirname(directory) !== root || !RUN_NAME.test(path.basename(directory))) throw storageError();
  privateNode(directory, true);
  privateNode(path.join(directory, RECORD), false);
  const value = JSON.parse(fs.readFileSync(path.join(directory, RECORD), "utf8"));
  if (value.schema !== "temporary-account-brief-charts-v1" || !Number.isFinite(value.created_at_ms)
      || !Number.isFinite(value.expires_at_ms) || value.expires_at_ms <= value.created_at_ms
      || value.expires_at_ms - value.created_at_ms > TEMPORARY_CHART_TTL_MS
      || !Array.isArray(value.files) || value.files.length > 128
      || new Set(value.files).size !== value.files.length || value.files.some((name) => !IMAGE_NAME.test(name))) throw storageError();
  return value;
}

/** Only exact recorded regular files. Never recurse, follow a link or remove unknown files. */
export function cleanupTemporaryChartDirectory(directory, nowMs = Date.now()) {
  if (!fs.existsSync(directory)) return { removed_files: 0, expired: true };
  try {
    const record = retention(directory);
    if (record.expires_at_ms > nowMs) return { removed_files: 0, expired: false };
    const allowed = new Set([RECORD, ...record.files]);
    if (fs.readdirSync(directory).some((name) => !allowed.has(name))) throw cleanupError();
    for (const name of record.files) if (fs.existsSync(path.join(directory, name))) privateNode(path.join(directory, name), false);
    let removed = 0;
    for (const name of record.files) {
      const file = path.join(directory, name);
      if (fs.existsSync(file)) { fs.unlinkSync(file); removed++; }
    }
    fs.unlinkSync(path.join(directory, RECORD));
    fs.rmdirSync(directory);
    return { removed_files: removed, expired: true };
  } catch (error) {
    if (error instanceof BetaError) throw error;
    throw cleanupError();
  }
}

export function purgeExpiredChartFiles(rootDir, nowMs = Date.now()) {
  const root = safeRoot(rootDir);
  if (!fs.existsSync(root)) return { removed_files: 0 };
  let removed = 0;
  for (const name of fs.readdirSync(root)) {
    if (RUN_NAME.test(name)) removed += cleanupTemporaryChartDirectory(path.join(root, name), nowMs).removed_files;
  }
  return { removed_files: removed };
}

async function startCleanupWorker(directory) {
  const child = spawn(process.execPath, [modulePath, "--cleanup-temporary-charts", directory], {
    detached: true, stdio: "ignore", env: {},
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(cleanupError()));
  });
  child.unref();
}

/** Authorized PNG-only delivery. Owner/account/evidence bindings remain in memory. */
export class TemporaryAccountBriefChartFiles {
  constructor({ rootDir = path.join(os.tmpdir(), ROOT_NAME), now = () => Date.now(),
    ttlMs = TEMPORARY_CHART_TTL_MS, scheduleCleanup = startCleanupWorker } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > TEMPORARY_CHART_TTL_MS) throw storageError();
    this.rootDir = rootDir;
    this.now = now;
    this.ttlMs = ttlMs;
    this.scheduleCleanup = scheduleCleanup;
    this.runs = new Map();
  }

  async create(result, { authorized, ownerRef, accountRefDigest, evidenceRef, expiresAt } = {}) {
    try { return await this.createImage(result, { authorized, ownerRef, accountRefDigest, evidenceRef, expiresAt }); }
    catch (error) {
      if (error instanceof BetaError) throw error;
      throw new BetaError("ACCOUNT_BRIEF_CHART_FILE_CREATE_FAILED", "The private temporary chart image could not be created. Keep the verified tables and report the display gap.");
    }
  }

  async createImage(result, { authorized, ownerRef, accountRefDigest, evidenceRef, expiresAt } = {}) {
    if (authorized !== true) throw new BetaError("ACCOUNT_BRIEF_CHART_FILE_AUTHORIZATION_REQUIRED", "Temporary local chart images require the CSM's authorization. No chart file was created.");
    if (!ownerRef || !evidenceRef || !/^[a-f0-9]{64}$/.test(accountRefDigest || "") || !Number.isFinite(expiresAt)) throw storageError();
    if (expiresAt <= this.now()) throw new BetaError("ACCOUNT_BRIEF_CHART_EXPIRED", "The temporary chart evidence has expired. Do not reuse an old image.");
    const inline = accountBriefChartInlineImage(result);
    const receipt = JSON.parse(result.content.find((item) => item.type === "text").text);
    if (typeof receipt.chart_id !== "string" || !receipt.chart_id || receipt.chart_id.length > 64) throw storageError();
    const bytes = Buffer.from(inline.image_url.split(",")[1], "base64");
    const root = safeRoot(this.rootDir, true);
    purgeExpiredChartFiles(root, this.now());
    const key = crypto.createHash("sha256").update(JSON.stringify([ownerRef, evidenceRef])).digest("hex");
    let run = this.runs.get(key);
    if (run && run.accountRefDigest !== accountRefDigest) throw new BetaError("ACCOUNT_BRIEF_CHART_ACCOUNT_MISMATCH", "The image request does not match the temporary account evidence.");
    if (run?.expiresAt <= this.now()) { this.runs.delete(key); run = null; }
    if (!run) {
      const created = this.now();
      const until = Math.min(created + this.ttlMs, expiresAt);
      const directory = fs.mkdtempSync(path.join(root, "pending-"));
      const finalDirectory = path.join(root, `run-${crypto.randomUUID()}`);
      fs.renameSync(directory, finalDirectory);
      fs.chmodSync(finalDirectory, 0o700);
      fs.writeFileSync(path.join(finalDirectory, RECORD), JSON.stringify({ schema: "temporary-account-brief-charts-v1",
        created_at_ms: created, expires_at_ms: until, files: [] }), { mode: 0o600, flag: "wx" });
      try { await this.scheduleCleanup(finalDirectory); }
      catch { cleanupTemporaryChartDirectory(finalDirectory, until); throw cleanupError(); }
      run = { directory: finalDirectory, accountRefDigest, expiresAt: until, charts: new Map() };
      this.runs.set(key, run);
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    let image = run.charts.get(receipt.chart_id);
    if (image && image.digest !== digest) throw new BetaError("ACCOUNT_BRIEF_CHART_CHANGED", "The cached image changed under the same evidence reference. Do not silently replace it.");
    if (!image) {
      if (run.charts.size >= 128) throw new BetaError("ACCOUNT_BRIEF_CHART_FILE_LIMIT", "The temporary chart-file limit was reached. No chart was silently omitted.");
      const fileName = `chart-${crypto.randomUUID()}.png`;
      const record = retention(run.directory);
      if (record.expires_at_ms <= this.now()) throw new BetaError("ACCOUNT_BRIEF_CHART_EXPIRED", "The temporary chart evidence has expired.");
      const updated = { ...record, files: [...record.files, fileName] };
      const staging = path.join(run.directory, "retention.pending");
      fs.writeFileSync(staging, JSON.stringify(updated), { mode: 0o600, flag: "wx" });
      fs.renameSync(staging, path.join(run.directory, RECORD));
      const filePath = path.join(run.directory, fileName);
      fs.writeFileSync(filePath, bytes, { mode: 0o600, flag: "wx" });
      image = { filePath, digest };
      run.charts.set(receipt.chart_id, image);
    }
    privateNode(image.filePath, false);
    if (crypto.createHash("sha256").update(fs.readFileSync(image.filePath)).digest("hex") !== digest) {
      throw new BetaError("ACCOUNT_BRIEF_CHART_FILE_CHANGED", "The temporary image no longer matches its source chart. Do not display it.");
    }
    const alt = `${receipt.title} — ${receipt.unit}`.replace(/[\[\]\\\r\n]/g, " ");
    const target = /[\s()]/.test(image.filePath) ? `<${image.filePath}>` : image.filePath;
    return { method: "markdown_local_image", file_path: image.filePath,
      markdown: `![${alt}](${target})`, expires_at: new Date(run.expiresAt).toISOString(),
      expires_in_seconds: Math.max(0, Math.floor((run.expiresAt - this.now()) / 1000)),
      cleanup: "independent_expiry_worker_and_restart_sweep", private_permissions: true,
      retention_notice: "Temporary local chart image; it expires with the brief or after 15 minutes, whichever comes first. The image may no longer load after cleanup.",
      delivery_state: "file_created_visibility_unverified" };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath && process.argv[2] === "--cleanup-temporary-charts") {
  try {
    const directory = process.argv[3];
    const record = retention(directory);
    while (fs.existsSync(directory) && record.expires_at_ms > Date.now()) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, record.expires_at_ms - Date.now())));
    }
    cleanupTemporaryChartDirectory(directory);
  } catch { process.exitCode = 1; }
}
