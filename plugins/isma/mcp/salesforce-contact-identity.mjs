import { spawn, spawnSync } from "node:child_process";

import { BetaError } from "./core.mjs";

// Contact identity is the minimum evidence needed to give the CSM a useful
// ranked shortlist. Keep its first-response budget aligned with the rest of
// the interactive read contract rather than failing five seconds early.
export const SALESFORCE_CONTACT_IDENTITY_TIMEOUT_MS = 25_000;
export const SALESFORCE_CONTACT_IDENTITY_BACKGROUND_TIMEOUT_MS = 60_000;
const MAX_CONTACTS = 100;

function validAccountId(accountId) {
  return /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "");
}

export function buildSalesforceContactIdentitySoql(accountId) {
  if (!validAccountId(accountId)) throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  return `SELECT Id, Name, (SELECT Id, Name, Email, Title FROM Contacts ORDER BY Name LIMIT ${MAX_CONTACTS}) FROM Account WHERE Id = '${accountId}' LIMIT 1`;
}

function recordsFrom(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.status !== 0 || !Array.isArray(parsed?.result?.records)) throw new Error("invalid result");
    return parsed.result.records;
  } catch (_error) {
    throw new BetaError("SALESFORCE_CONTACT_RESPONSE_INVALID", "Salesforce returned an unreadable contact response.");
  }
}

/** Returns the same row shape used by the governed contact-evidence presenter. */
export function readSalesforceContactIdentity({ accountId, targetOrg = process.env.CSM_COPILOT_SALESFORCE_TARGET_ORG || "prod", runner = spawnSync } = {}) {
  const startedAt = Date.now();
  const result = runner(
    "sf",
    ["data", "query", "--target-org", targetOrg, "--query", buildSalesforceContactIdentitySoql(accountId), "--json"],
    { encoding: "utf8", timeout: SALESFORCE_CONTACT_IDENTITY_TIMEOUT_MS, env: { ...process.env } },
  );
  if (result.error?.code === "ETIMEDOUT") {
    throw new BetaError("SALESFORCE_CONTACT_IDENTITY_TIMEOUT", "Salesforce contact identity did not return within 25 seconds. Nothing was saved.");
  }
  if (result.error || result.status !== 0) {
    throw new BetaError("SALESFORCE_CONTACT_IDENTITY_FAILED", "Salesforce contact identity could not be read. Check the approved Salesforce connection and try again.");
  }
  const account = recordsFrom(result.stdout)[0];
  if (!account?.Id || !account?.Name) {
    throw new BetaError("ACCOUNT_NOT_IN_CURRENT_BOOK", "The selected account is no longer available for contact evidence.");
  }
  const contacts = Array.isArray(account.Contacts?.records) ? account.Contacts.records : [];
  return {
    rows: (contacts.length ? contacts : [null]).map((contact) => ({
      ACCOUNT_ID: account.Id, ACCOUNT_NAME: account.Name,
      ACCOUNT_HEALTH: null, CS_SEGMENT: null, MARKET_SEGMENT: null, NET_ARR_USD: null, CSM_NAME: null,
      CONTACT_ID: contact?.Id ?? null, CONTACT_NAME: contact?.Name ?? null,
      CONTACT_EMAIL: contact?.Email ?? null, CONTACT_TITLE: contact?.Title ?? null,
    })),
    source_duration_ms: Date.now() - startedAt,
  };
}

/**
 * The background verification must never block the first useful account
 * response. This is the same bounded, read-only Salesforce query as above,
 * but its longer background budget is asynchronous and independent of the
 * Snowflake warehouse queue.
 */
export async function readSalesforceContactIdentityAsync({
  accountId,
  targetOrg = process.env.CSM_COPILOT_SALESFORCE_TARGET_ORG || "prod",
  timeoutMs = SALESFORCE_CONTACT_IDENTITY_BACKGROUND_TIMEOUT_MS,
  spawnProcess = spawn,
} = {}) {
  const startedAt = Date.now();
  const args = ["data", "query", "--target-org", targetOrg, "--query", buildSalesforceContactIdentitySoql(accountId), "--json"];
  const stdout = await new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    let child;
    const timer = setTimeout(() => {
      try { child?.kill(); } catch (_error) { /* process already ended */ }
      settle(reject, new BetaError("SALESFORCE_CONTACT_IDENTITY_TIMEOUT", `Salesforce contact identity did not return within ${timeoutMs / 1000} seconds. Nothing was saved.`));
    }, timeoutMs);
    try {
      child = spawnProcess("sf", args, { env: { ...process.env }, stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.once("error", () => settle(reject, new BetaError("SALESFORCE_CONTACT_IDENTITY_FAILED", "Salesforce contact identity could not be read. Check the approved Salesforce connection and try again.")));
      child.once("close", (code) => {
        if (code !== 0) return settle(reject, new BetaError("SALESFORCE_CONTACT_IDENTITY_FAILED", "Salesforce contact identity could not be read. Check the approved Salesforce connection and try again."));
        settle(resolve, output);
      });
    } catch (_error) {
      settle(reject, new BetaError("SALESFORCE_CONTACT_IDENTITY_FAILED", "Salesforce contact identity could not be read. Check the approved Salesforce connection and try again."));
    }
  });
  const account = recordsFrom(stdout)[0];
  if (!account?.Id || !account?.Name) {
    throw new BetaError("ACCOUNT_NOT_IN_CURRENT_BOOK", "The selected account is no longer available for contact evidence.");
  }
  const contacts = Array.isArray(account.Contacts?.records) ? account.Contacts.records : [];
  return {
    rows: (contacts.length ? contacts : [null]).map((contact) => ({
      ACCOUNT_ID: account.Id, ACCOUNT_NAME: account.Name,
      ACCOUNT_HEALTH: null, CS_SEGMENT: null, MARKET_SEGMENT: null, NET_ARR_USD: null, CSM_NAME: null,
      CONTACT_ID: contact?.Id ?? null, CONTACT_NAME: contact?.Name ?? null,
      CONTACT_EMAIL: contact?.Email ?? null, CONTACT_TITLE: contact?.Title ?? null,
    })),
    source_duration_ms: Date.now() - startedAt,
  };
}
