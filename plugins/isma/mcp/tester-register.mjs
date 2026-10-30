import fs from "node:fs";
import path from "node:path";

import { BetaError, readJson } from "./core.mjs";

export const REGISTER_EVENT_TYPES = new Set([
  "setup_ready",
  "case_created",
  "feedback_submitted",
  "support_issue",
]);

export function createTesterRegisterEvent({
  eventType,
  operatorRef,
  packageVersion,
  rendererBaseline,
  caseId = null,
  status,
  occurredAt = new Date(),
}) {
  if (!REGISTER_EVENT_TYPES.has(eventType)) {
    throw new BetaError("INVALID_REGISTER_EVENT", "The tester-register event type is not supported.");
  }
  if (!/^operator_[a-f0-9]{20}$/.test(operatorRef || "")) {
    throw new BetaError("INVALID_OPERATOR_REF", "The tester register accepts only a derived operator reference.");
  }
  if (!packageVersion || !rendererBaseline || !status) {
    throw new BetaError("INVALID_REGISTER_EVENT", "Package, renderer, and status are required.");
  }
  if (caseId !== null && !/^[0-9a-f-]{36}$/i.test(caseId)) {
    throw new BetaError("INVALID_CASE_ID", "case_id is invalid.");
  }

  const eventKey = [eventType, operatorRef, packageVersion, caseId || "none", status].join(":");
  return {
    schema_version: "1.0",
    event_key: eventKey,
    event_type: eventType,
    operator_ref: operatorRef,
    package_version: packageVersion,
    renderer_baseline: rendererBaseline,
    case_id: caseId,
    status,
    occurred_at: occurredAt.toISOString(),
  };
}

export function appendLocalRegisterEvent(filePath, event) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const current = fs.existsSync(filePath) ? readJson(filePath) : { schema_version: "1.0", events: [] };
  if (!Array.isArray(current.events)) {
    throw new BetaError("REGISTER_STATE_INVALID", "The local tester-register state is invalid.");
  }
  if (!current.events.some((existing) => existing.event_key === event.event_key)) {
    current.events.push(event);
    fs.writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  }
  return current;
}
