import fs from "node:fs";

import { BetaError } from "./core.mjs";
import { googleAccessToken } from "./google-oauth.mjs";

export function readRendererConfig(filePath) {
  throw new BetaError("API_RENDERER_RETIRED", "The API-executable renderer is retired after a visual-template regression. Use the private reference-locked bound-script renderer.");
  /* istanbul ignore next -- retained only as documentation for invalid legacy configuration. */
  if (!fs.existsSync(filePath)) {
    throw new BetaError("RENDERER_NOT_CONFIGURED", "The approved Apps Script API executable is not configured on this computer.");
  }
  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (config.schema_version !== "1.0" || !config.deployment_id || !config.function_name) {
    throw new BetaError("RENDERER_CONFIG_INVALID", "The private renderer configuration is incomplete.");
  }
  if (config.function_name !== "runCsmCopilotDesktopBetaV1" || config.dev_mode === true) {
    throw new BetaError("RENDERER_CONFIG_INVALID", "Only the approved production-version API executable function is allowed.");
  }
  return config;
}

export async function invokeAppsScriptRenderer({
  configPath,
  clientPath,
  tokenPath,
  envelope,
  fetchImpl = fetch,
}) {
  const config = readRendererConfig(configPath);
  const token = await googleAccessToken({ clientPath, tokenPath });
  const response = await fetchImpl(`https://script.googleapis.com/v1/scripts/${encodeURIComponent(config.deployment_id)}:run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ function: config.function_name, parameters: [envelope], devMode: false }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    throw new BetaError("RENDERER_EXECUTION_FAILED", "The approved renderer did not complete.", {
      status: response.status,
      error_status: body.error?.status || null,
    });
  }
  return body.response?.result ?? body.response ?? body;
}

export async function probeAppsScriptRenderer({
  configPath,
  clientPath,
  tokenPath,
  verifyPersonalMaster = false,
  fetchImpl = fetch,
}) {
  const config = readRendererConfig(configPath);
  const token = await googleAccessToken({ clientPath, tokenPath });
  const response = await fetchImpl(`https://script.googleapis.com/v1/scripts/${encodeURIComponent(config.deployment_id)}:run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      function: "probeCsmCopilotDesktopBetaV1",
      parameters: verifyPersonalMaster ? [{ verifyPersonalMaster: true }] : [],
      devMode: false,
    }),
  });
  const body = await response.json().catch(() => ({}));
  const result = body.response?.result;
  if (!response.ok || body.error || result?.status !== "ready") {
    throw new BetaError("RENDERER_PROBE_FAILED", "The approved Apps Script renderer could not be verified.", { status: response.status });
  }
  if (verifyPersonalMaster && result.personalMasterReady !== true) {
    throw new BetaError("PERSONAL_MASTER_NOT_VERIFIED", "The active CSM's private personal master could not be verified.");
  }
  return result;
}
