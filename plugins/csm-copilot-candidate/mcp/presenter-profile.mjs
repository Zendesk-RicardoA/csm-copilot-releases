import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BetaError } from "./core.mjs";

const ALLOWED_KEYS = new Set([
  "schema_version",
  "profile_ref",
  "display_name",
  "job_title",
  "master_deck_personalized",
  "photo_personalized",
  "confirmed_from_private_master",
  "updated_at",
]);

export const PERSONAL_MASTER_NAME = "CSM Copilot - Personal Master";
const DECK_CONFIRMED_DISPLAY_NAME = "Private master deck";
const DECK_CONFIRMED_JOB_TITLE = "Presenter details preserved in the deck";

function requiredText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new BetaError("INVALID_PRESENTER_PROFILE", `${field} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength || /https?:\/\/|@/.test(normalized)) {
    throw new BetaError("INVALID_PRESENTER_PROFILE", `${field} is not valid.`);
  }
  return normalized;
}

export function normalizePresenterProfile(input, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BetaError("INVALID_PRESENTER_PROFILE", "A presenter profile is required.");
  }
  const unknown = Object.keys(input).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length) {
    throw new BetaError("INVALID_PRESENTER_PROFILE", "Unsupported presenter profile fields were supplied.", { unknown });
  }
  if (input.master_deck_personalized !== true || input.photo_personalized !== true) {
    throw new BetaError(
      "MASTER_DECK_NOT_PERSONALIZED",
      "Confirm that the private master-deck copy contains this CSM's name, title, and photo.",
    );
  }
  if (input.confirmed_from_private_master === true) {
    const profileRef = typeof input.profile_ref === "string" && /^presenter_[a-f0-9]{20}$/.test(input.profile_ref)
      ? input.profile_ref
      : `presenter_${crypto.randomBytes(10).toString("hex")}`;
    return {
      schema_version: "1.1",
      profile_ref: profileRef,
      display_name: DECK_CONFIRMED_DISPLAY_NAME,
      job_title: DECK_CONFIRMED_JOB_TITLE,
      master_deck_personalized: true,
      photo_personalized: true,
      confirmed_from_private_master: true,
      updated_at: now.toISOString(),
    };
  }
  const displayName = requiredText(input.display_name, "display_name", 80);
  const jobTitle = requiredText(input.job_title, "job_title", 100);
  const profileRef = `presenter_${crypto
    .createHash("sha256")
    .update(`${displayName}\n${jobTitle}`)
    .digest("hex")
    .slice(0, 20)}`;
  return {
    schema_version: "1.0",
    profile_ref: profileRef,
    display_name: displayName,
    job_title: jobTitle,
    master_deck_personalized: true,
    photo_personalized: true,
    updated_at: now.toISOString(),
  };
}

export function writePresenterProfile(filePath, input, now = new Date()) {
  const profile = normalizePresenterProfile(input, now);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return profile;
}

export function confirmPersonalMaster(filePath, now = new Date()) {
  return writePresenterProfile(filePath, {
    profile_ref: `presenter_${crypto.randomBytes(10).toString("hex")}`,
    master_deck_personalized: true,
    photo_personalized: true,
    confirmed_from_private_master: true,
  }, now);
}

export function readPresenterProfile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      status: "action_required",
      next_action: {
        code: "CONFIRM_PRIVATE_MASTER_DECK",
        title: "Confirm your personal master deck",
        instruction: `If you already have a private deck named "${PERSONAL_MASTER_NAME}" and it contains your name, title, and photo, confirm that once. The Copilot will save the local setup record without asking for your name or title. Create and personalize the deck only if it does not exist.`,
      },
    };
  }
  const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const profile = normalizePresenterProfile(stored, new Date(stored.updated_at));
  return { status: "ready", profile };
}

export function applyPresenterProfileStatus(credentialState, profileStatus) {
  return {
    ...credentialState,
    presenter_profile: {
      state: profileStatus?.status === "ready" ? "ready" : "not_configured",
    },
  };
}

export function presenterProfileForRenderer(profile) {
  const normalized = normalizePresenterProfile(profile, new Date(profile.updated_at));
  return {
    schemaVersion: "1.0",
    profileRef: normalized.profile_ref,
    displayName: normalized.display_name,
    jobTitle: normalized.job_title,
    personalizedMasterConfirmed: true,
    photoPersonalizedConfirmed: true,
    presenterDetailsSource: normalized.confirmed_from_private_master === true ? "private_master" : "local_profile",
  };
}
