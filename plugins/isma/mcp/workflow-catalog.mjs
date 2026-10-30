import fs from "node:fs";

const freeze = (value) => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const WORKFLOW_CATALOG = freeze(JSON.parse(fs.readFileSync(new URL("../config/workflow-catalog.json", import.meta.url), "utf8")));
export const WORKFLOW_STEPS = freeze(Object.fromEntries(Object.values(WORKFLOW_CATALOG.workflows).map((workflow) => [workflow.runtime_name, workflow.steps])));

export function validateWorkflowRegistration(toolNames, catalog = WORKFLOW_CATALOG) {
  const available = new Set(toolNames);
  return Object.entries(catalog.workflows).flatMap(([workflow, definition]) => definition.steps.flatMap(({ step, tools }) =>
    tools.filter((tool) => !available.has(tool)).map((tool) => ({ workflow, step, missing_tool: tool }))));
}
