import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BetaError } from "./core.mjs";

const MAX_SIGNATURE_HTML_BYTES = 160_000;
const MAX_INLINE_ASSETS = 12;
const MAX_INLINE_ASSET_BYTES = 1_500_000;
const CID = /^[A-Za-z0-9._-]{1,120}$/;
const MIME = /^image\/(?:png|jpeg|gif|webp)$/;

function rejectUnsafeHtml(html) {
  if (/<\/?(?:script|iframe|object|embed)\b/i.test(html) || /\bon\w+\s*=/i.test(html) || /javascript\s*:/i.test(html)) {
    throw new BetaError("INVALID_SIGNATURE_PROFILE", "The signature contains unsupported active content.");
  }
}

function normalizeAsset(asset) {
  if (!asset || typeof asset !== "object" || !CID.test(asset.cid || "") || !MIME.test(asset.mime_type || "")) {
    throw new BetaError("INVALID_SIGNATURE_PROFILE", "Each inline signature image needs a safe CID and image type.");
  }
  if (typeof asset.data_base64 !== "string" || !asset.data_base64.trim()) {
    throw new BetaError("INVALID_SIGNATURE_PROFILE", "Each inline signature image needs image data.");
  }
  const bytes = Buffer.byteLength(asset.data_base64, "base64");
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_INLINE_ASSET_BYTES) {
    throw new BetaError("INVALID_SIGNATURE_PROFILE", "An inline signature image is too large.");
  }
  return { cid: asset.cid, mime_type: asset.mime_type, data_base64: asset.data_base64 };
}

export function normalizeSignatureProfile(input, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BetaError("INVALID_SIGNATURE_PROFILE", "A rich Gmail signature profile is required.");
  }
  if (typeof input.html !== "string" || !input.html.trim() || Buffer.byteLength(input.html, "utf8") > MAX_SIGNATURE_HTML_BYTES) {
    throw new BetaError("INVALID_SIGNATURE_PROFILE", "The signature HTML is missing or too large.");
  }
  rejectUnsafeHtml(input.html);
  const inlineAssets = Array.isArray(input.inline_assets) ? input.inline_assets.map(normalizeAsset) : [];
  if (inlineAssets.length > MAX_INLINE_ASSETS || new Set(inlineAssets.map((asset) => asset.cid)).size !== inlineAssets.length) {
    throw new BetaError("INVALID_SIGNATURE_PROFILE", "The signature has too many or duplicate inline images.");
  }
  const html = input.html.trim();
  const digest = crypto.createHash("sha256").update(JSON.stringify({ html, inlineAssets })).digest("hex");
  return {
    schema_version: "1.0",
    profile_ref: `signature_${digest.slice(0, 20)}`,
    sha256: digest,
    html,
    inline_assets: inlineAssets,
    captured_at: now.toISOString(),
    test_draft_verified: false,
    verified_at: null,
  };
}

function privateWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function signatureProfileStatus(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      state: "not_configured",
      next_action: {
        code: "CAPTURE_GMAIL_SIGNATURE",
        title: "Set up your Gmail signature",
        instruction: "Use one sent email with your current signature. The Copilot will save only the signature block privately, then create one recipient-free test draft for you to check.",
      },
    };
  }
  const profile = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const normalized = normalizeSignatureProfile(profile, new Date(profile.captured_at));
  const verified = profile.test_draft_verified === true;
  return {
    state: verified ? "ready" : "test_required",
    profile_ref: normalized.profile_ref,
    sha256: normalized.sha256,
    captured_at: normalized.captured_at,
    verified_at: verified ? profile.verified_at : null,
    inline_asset_count: normalized.inline_assets.length,
    next_action: verified ? null : {
      code: "VERIFY_GMAIL_SIGNATURE_TEST",
      title: "Verify your signature test draft",
      instruction: "Check the recipient-free Gmail draft visually. Confirm only if the image and links display correctly.",
    },
  };
}

export function saveSignatureProfile(filePath, input, now = new Date()) {
  const profile = normalizeSignatureProfile(input, now);
  privateWrite(filePath, profile);
  return signatureProfileStatus(filePath);
}

export function signatureTestDraft(filePath) {
  const status = signatureProfileStatus(filePath);
  if (status.state === "not_configured") {
    throw new BetaError("SIGNATURE_PROFILE_REQUIRED", "Set up the Gmail signature before creating its test draft.");
  }
  const profile = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return {
    title: "Signature test — do not send",
    to: [],
    subject: "Signature test — do not send",
    html: `<div>${profile.html}</div>`,
    inline_assets: profile.inline_assets,
    send_state: "not_sent",
  };
}

export function confirmSignatureTest(filePath, now = new Date()) {
  const status = signatureProfileStatus(filePath);
  if (status.state === "not_configured") {
    throw new BetaError("SIGNATURE_PROFILE_REQUIRED", "Set up the Gmail signature before confirming it.");
  }
  const profile = JSON.parse(fs.readFileSync(filePath, "utf8"));
  privateWrite(filePath, { ...profile, test_draft_verified: true, verified_at: now.toISOString() });
  return signatureProfileStatus(filePath);
}

export function readSignatureForApprovedDraft(filePath) {
  const status = signatureProfileStatus(filePath);
  if (status.state !== "ready") {
    throw new BetaError("SIGNATURE_PROFILE_NOT_READY", "The Gmail signature must be captured and verified before a draft can use it.");
  }
  const profile = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return { html: profile.html, inline_assets: profile.inline_assets, profile_ref: profile.profile_ref, sha256: profile.sha256 };
}

export function removeSignatureProfile(filePath) {
  if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  return signatureProfileStatus(filePath);
}
