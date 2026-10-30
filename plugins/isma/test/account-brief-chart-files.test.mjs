import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { TemporaryAccountBriefChartFiles, cleanupTemporaryChartDirectory, purgeExpiredChartFiles } from "../mcp/account-brief-chart-files.mjs";
import { accountBriefChartResult } from "../mcp/account-brief-chart-delivery.mjs";
import { buildAccountPerformanceCharts } from "../mcp/account-performance-charts.mjs";

const fixture = () => {
  const display = buildAccountPerformanceCharts({ sections: { support_operations: { facts: { metric_table: [
    { metric: "Invented first reply", unit: "hours", trend: [{ period: "2026-06", value: 0 }, { period: "2026-08", value: 2.5 }] },
  ] } } } });
  return accountBriefChartResult(display, display.charts[0].id);
};
const scope = (expiresAt) => ({ authorized: true, ownerRef: "invented-owner", evidenceRef: "invented-brief", accountRefDigest: "a".repeat(64), expiresAt });
function temporary(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "invented-chart-files-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return path.join(parent, "csm-copilot-chart-delivery");
}

test("no image file without authorization or valid current account evidence", async (t) => {
  const rootDir = temporary(t);
  const files = new TemporaryAccountBriefChartFiles({ rootDir, now: () => 100, scheduleCleanup: async () => {} });
  await assert.rejects(files.create(fixture(), { ...scope(1000), authorized: false }), { code: "ACCOUNT_BRIEF_CHART_FILE_AUTHORIZATION_REQUIRED" });
  await assert.rejects(files.create(fixture(), { ...scope(1000), accountRefDigest: "missing" }), { code: "ACCOUNT_BRIEF_CHART_STORAGE_UNSAFE" });
  await assert.rejects(files.create(fixture(), scope(100)), { code: "ACCOUNT_BRIEF_CHART_EXPIRED" });
  assert.equal(fs.existsSync(rootDir), false);
});

test("only exact native PNG, private modes, opaque filenames and earlier evidence expiry", async (t) => {
  const rootDir = temporary(t);
  let now = 100;
  const files = new TemporaryAccountBriefChartFiles({ rootDir, now: () => now, scheduleCleanup: async () => {} });
  const result = fixture();
  const delivery = await files.create(result, scope(1000));
  assert.equal(delivery.expires_at, new Date(1000).toISOString());
  assert.equal(fs.readFileSync(delivery.file_path).toString("base64"), result.content[1].data);
  assert.equal(fs.statSync(delivery.file_path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(delivery.file_path)).mode & 0o777, 0o700);
  assert.match(delivery.markdown, /^!\[Invented first reply/);
  assert.doesNotMatch(delivery.file_path, /invented-owner|invented-brief|first.reply/);
  const recordText = fs.readFileSync(path.join(path.dirname(delivery.file_path), "retention.json"), "utf8");
  assert.doesNotMatch(recordText, /invented-owner|invented-brief|accountRef|2\.5|hours/);
  now = 200;
  assert.equal((await files.create(result, scope(1000))).file_path, delivery.file_path, "Repeated cached delivery neither duplicates the image nor extends its expiry");
  fs.writeFileSync(delivery.file_path, "Invented changed file", { mode: 0o600 });
  await assert.rejects(files.create(result, scope(1000)), { code: "ACCOUNT_BRIEF_CHART_FILE_CHANGED" });
  fs.writeFileSync(delivery.file_path, Buffer.from(result.content[1].data, "base64"), { mode: 0o600 });
  await assert.rejects(files.create(result, { ...scope(1000), accountRefDigest: "b".repeat(64) }), { code: "ACCOUNT_BRIEF_CHART_ACCOUNT_MISMATCH" });
  assert.equal(cleanupTemporaryChartDirectory(path.dirname(delivery.file_path), 999).expired, false);
  assert.equal(purgeExpiredChartFiles(rootDir, 1000).removed_files, 1);
  assert.equal(fs.existsSync(delivery.file_path), false);
});

test("unsafe storage, symlinks, unknown files and failed cleanup scheduling are not bypassed", async (t) => {
  const rootDir = temporary(t);
  const unsafe = new TemporaryAccountBriefChartFiles({ rootDir: path.join(path.dirname(rootDir), "unapproved-root"), now: () => 100 });
  await assert.rejects(unsafe.create(fixture(), scope(1000)), { code: "ACCOUNT_BRIEF_CHART_STORAGE_UNSAFE" });
  assert.equal(fs.existsSync(path.join(path.dirname(rootDir), "unapproved-root")), false);
  const files = new TemporaryAccountBriefChartFiles({ rootDir, now: () => 100, scheduleCleanup: async () => {} });
  const delivery = await files.create(fixture(), scope(1000));
  const directory = path.dirname(delivery.file_path);
  fs.writeFileSync(path.join(directory, "unrelated.txt"), "Invented unrelated file", { mode: 0o600 });
  assert.throws(() => cleanupTemporaryChartDirectory(directory, 1000), { code: "ACCOUNT_BRIEF_CHART_CLEANUP_FAILED" });
  assert.equal(fs.existsSync(delivery.file_path), true, "Unknown files are never removed recursively");
  fs.unlinkSync(path.join(directory, "unrelated.txt"));
  const target = path.join(path.dirname(rootDir), "invented-other.txt");
  fs.writeFileSync(target, "Invented other data", { mode: 0o600 });
  fs.unlinkSync(delivery.file_path);
  fs.symlinkSync(target, delivery.file_path);
  assert.throws(() => cleanupTemporaryChartDirectory(directory, 1000), { code: "ACCOUNT_BRIEF_CHART_STORAGE_UNSAFE" });
  assert.equal(fs.readFileSync(target, "utf8"), "Invented other data");
  const otherRoot = temporary(t);
  const failed = new TemporaryAccountBriefChartFiles({ rootDir: otherRoot, now: () => 100, scheduleCleanup: async () => { throw Error("Invented spawn failure"); } });
  await assert.rejects(failed.create(fixture(), scope(1000)), { code: "ACCOUNT_BRIEF_CHART_CLEANUP_FAILED" });
  assert.deepEqual(fs.readdirSync(otherRoot), []);
});

test("a restarted file manager cannot recover account evidence or extend expired image retention", async (t) => {
  const rootDir = temporary(t);
  const files = new TemporaryAccountBriefChartFiles({ rootDir, now: () => 100, scheduleCleanup: async () => {} });
  const delivery = await files.create(fixture(), scope(1000));
  const restarted = new TemporaryAccountBriefChartFiles({ rootDir, now: () => 1000, scheduleCleanup: async () => {} });
  assert.equal(restarted.runs.size, 0);
  assert.equal(purgeExpiredChartFiles(rootDir, 1000).removed_files, 1);
  await assert.rejects(restarted.create(fixture(), scope(1000)), { code: "ACCOUNT_BRIEF_CHART_EXPIRED" });
  assert.equal(fs.existsSync(delivery.file_path), false);
});

test("independent expiry cleanup deletes the invented image after its creator process exits", async (t) => {
  const rootDir = temporary(t);
  const moduleUrl = new URL("../mcp/account-brief-chart-files.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { TemporaryAccountBriefChartFiles } from ${JSON.stringify(moduleUrl)};
    const result = JSON.parse(process.argv[2]);
    const files = new TemporaryAccountBriefChartFiles({ rootDir: process.argv[1], ttlMs: 700 });
    const delivery = await files.create(result, { authorized: true, ownerRef: "invented-owner", evidenceRef: "invented-brief", accountRefDigest: "a".repeat(64), expiresAt: Date.now() + 700 });
    process.stdout.write(JSON.stringify(delivery));
  `, rootDir, JSON.stringify(fixture())], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, errors);
  const delivery = JSON.parse(output);
  assert.equal(fs.existsSync(delivery.file_path), true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(fs.existsSync(delivery.file_path), false, "The detached janitor must outlive the parent and remove the exact image");
  assert.deepEqual(fs.readdirSync(rootDir), []);
});
