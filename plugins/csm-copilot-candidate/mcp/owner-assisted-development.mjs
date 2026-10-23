import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BetaError, readJson } from "./core.mjs";

const DIGEST = /^[a-f0-9]{64}$/;
const OPERATOR_REF = /^operator_[a-f0-9]{20}$/;
const AUTHORIZATION_ID = /^[0-9a-f-]{36}$/i;
const MAX_AUTHORIZATION_MINUTES = 120;
const SCOPE_KINDS = new Set(["gong_call", "account_portfolio"]);

function requireDigest(value, field) {
  if (!DIGEST.test(value || "")) {
    throw new BetaError("INVALID_OWNER_ASSISTED_SCOPE", `${field} must be a SHA-256 digest.`);
  }
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function readAuthorizationState(filePath) {
  if (!fs.existsSync(filePath)) return { schema_version: "1.0", authorizations: [] };
  const state = readJson(filePath);
  if (!Array.isArray(state.authorizations)) {
    throw new BetaError("OWNER_ASSISTED_STATE_INVALID", "The private owner-assisted authorization record is invalid.");
  }
  return state;
}

/**
 * This is deliberately not a beta-runtime mode. The shared ZIP cannot enable it:
 * its private controls file is owner-local and never copied by the release builder.
 */
export function validateOwnerAssistedDevelopment({ controls, operatorRef }) {
  if (controls?.mode !== "owner_assisted_development" || controls?.enabled !== true) {
    throw new BetaError("OWNER_ASSISTED_DEVELOPMENT_DISABLED", "Owner-assisted cross-account testing is not enabled on this computer.");
  }
  if (!OPERATOR_REF.test(operatorRef || "") || controls.owner_operator_ref !== operatorRef) {
    throw new BetaError("OWNER_ASSISTED_OPERATOR_MISMATCH", "Only the configured development owner can authorize a cross-account test.");
  }
  const policy = controls.cross_account_testing || {};
  if (
    policy.explicit_authorization_required !== true ||
    policy.single_active_authorization !== true ||
    policy.private_draft_only !== true ||
    policy.read_only_sources !== true ||
    policy.retain_raw_transcript !== false
  ) {
    throw new BetaError("OWNER_ASSISTED_CONTROL_MISSING", "The owner-assisted development controls are incomplete.");
  }
  const requestedMinutes = Number(policy.max_authorization_minutes);
  if (!Number.isInteger(requestedMinutes) || requestedMinutes < 1 || requestedMinutes > MAX_AUTHORIZATION_MINUTES) {
    throw new BetaError("OWNER_ASSISTED_CONTROL_MISSING", `max_authorization_minutes must be an integer from 1 to ${MAX_AUTHORIZATION_MINUTES}.`);
  }
  return { max_authorization_minutes: requestedMinutes };
}

export function ownerAssistedDevelopmentStatus({ controls, operatorRef }) {
  try {
    const policy = validateOwnerAssistedDevelopment({ controls, operatorRef });
    return {
      status: "ready",
      scope: "owner_only_cross_account_testing",
      requires_explicit_authorization: true,
      max_authorization_minutes: policy.max_authorization_minutes,
      shared_beta_affected: false,
      raw_transcript_retained: false,
      production_system_writes: false,
    };
  } catch (error) {
    if (!(error instanceof BetaError)) throw error;
    return {
      status: "unavailable",
      scope: "owner_only_cross_account_testing",
      shared_beta_affected: false,
      reason_code: error.code,
    };
  }
}

export function authorizeOwnerAssistedTest({
  controls,
  authorizationPath,
  operatorRef,
  input,
  now = new Date(),
}) {
  const policy = validateOwnerAssistedDevelopment({ controls, operatorRef });
  if (input.explicit_authorization_confirmed !== true) {
    throw new BetaError("OWNER_ASSISTED_AUTHORIZATION_REQUIRED", "Explicit authorization must be confirmed before a cross-account test is opened.");
  }
  if (!SCOPE_KINDS.has(input.scope_kind)) {
    throw new BetaError("INVALID_OWNER_ASSISTED_SCOPE", "scope_kind must be gong_call or account_portfolio.");
  }
  requireDigest(input.authorization_reference_digest, "authorization_reference_digest");
  requireDigest(input.scope_digest, "scope_digest");
  requireDigest(input.account_ref_digest, "account_ref_digest");
  requireDigest(input.account_owner_ref_digest, "account_owner_ref_digest");

  const state = readAuthorizationState(authorizationPath);
  const active = state.authorizations.find((item) => item.status === "active" && new Date(item.expires_at) > now);
  if (active) {
    throw new BetaError("OWNER_ASSISTED_AUTHORIZATION_ACTIVE", "Finish or let the current owner-assisted test expire before authorizing another one.");
  }
  const expiresAt = new Date(now.getTime() + policy.max_authorization_minutes * 60 * 1000).toISOString();
  const authorization = {
    schema_version: "1.0",
    authorization_id: crypto.randomUUID(),
    status: "active",
    authorized_by_operator_ref: operatorRef,
    authorization_reference_digest: input.authorization_reference_digest,
    scope_kind: input.scope_kind,
    scope_digest: input.scope_digest,
    account_ref_digest: input.account_ref_digest,
    account_owner_ref_digest: input.account_owner_ref_digest,
    explicit_authorization_confirmed: true,
    private_draft_only: true,
    read_only_sources: true,
    raw_transcript_retained: false,
    created_at: now.toISOString(),
    expires_at: expiresAt,
    consumed_at: null,
    case_id: null,
  };
  state.authorizations.push(authorization);
  writePrivateJson(authorizationPath, state);
  return authorization;
}

export function consumeOwnerAssistedTestAuthorization({
  controls,
  authorizationPath,
  operatorRef,
  authorizationId,
  scopeKind,
  scopeDigest,
  accountRefDigest,
  accountOwnerRefDigest,
  caseId,
  now = new Date(),
}) {
  validateOwnerAssistedDevelopment({ controls, operatorRef });
  if (!AUTHORIZATION_ID.test(authorizationId || "") || !AUTHORIZATION_ID.test(caseId || "")) {
    throw new BetaError("INVALID_OWNER_ASSISTED_AUTHORIZATION", "The owner-assisted authorization or case identifier is invalid.");
  }
  if (!SCOPE_KINDS.has(scopeKind)) throw new BetaError("INVALID_OWNER_ASSISTED_SCOPE", "scope_kind is invalid.");
  requireDigest(scopeDigest, "scope_digest");
  requireDigest(accountRefDigest, "account_ref_digest");
  requireDigest(accountOwnerRefDigest, "account_owner_ref_digest");

  const state = readAuthorizationState(authorizationPath);
  const authorization = state.authorizations.find((item) => item.authorization_id === authorizationId);
  if (!authorization || authorization.status !== "active") {
    throw new BetaError("OWNER_ASSISTED_AUTHORIZATION_NOT_FOUND", "No active owner-assisted authorization matches this test.");
  }
  if (new Date(authorization.expires_at) <= now) {
    authorization.status = "expired";
    writePrivateJson(authorizationPath, state);
    throw new BetaError("OWNER_ASSISTED_AUTHORIZATION_EXPIRED", "The owner-assisted authorization expired. Obtain a new explicit authorization.");
  }
  const matches =
    authorization.authorized_by_operator_ref === operatorRef &&
    authorization.scope_kind === scopeKind &&
    authorization.scope_digest === scopeDigest &&
    authorization.account_ref_digest === accountRefDigest &&
    authorization.account_owner_ref_digest === accountOwnerRefDigest;
  if (!matches) {
    throw new BetaError("OWNER_ASSISTED_SCOPE_MISMATCH", "The selected source or account does not match the explicit owner-assisted authorization.");
  }
  authorization.status = "consumed";
  authorization.consumed_at = now.toISOString();
  authorization.case_id = caseId;
  writePrivateJson(authorizationPath, state);
  return {
    authorization_id: authorization.authorization_id,
    authorized_by_operator_ref: authorization.authorized_by_operator_ref,
    authorization_reference_digest: authorization.authorization_reference_digest,
    scope_kind: authorization.scope_kind,
    scope_digest: authorization.scope_digest,
    account_ref_digest: authorization.account_ref_digest,
    account_owner_ref_digest: authorization.account_owner_ref_digest,
    authorized_at: authorization.created_at,
    expires_at: authorization.expires_at,
    private_draft_only: true,
    read_only_sources: true,
    raw_transcript_retained: false,
  };
}
