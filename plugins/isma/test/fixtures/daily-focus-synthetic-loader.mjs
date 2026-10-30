// Test-only source replacement. No production connection can run in this
// process: the test also sets an impossible Snowflake Python path.
export async function load(url, context, nextLoad) {
  if (url.endsWith("/mcp/persistent-snowflake-session.mjs")) {
    const fixture = new URL("./daily-focus-synthetic-session.mjs", import.meta.url).href;
    return { format: "module", shortCircuit: true, source: `export { PersistentSnowflakeSession } from ${JSON.stringify(fixture)};` };
  }
  if (url.endsWith("/mcp/journey-a-portfolio-relationships.mjs")) {
    const fixture = new URL("./daily-focus-synthetic-relationships.mjs", import.meta.url).href;
    return { format: "module", shortCircuit: true, source: `export { readPortfolioRelationships } from ${JSON.stringify(fixture)}; export { PortfolioRelationshipReadJobs } from ${JSON.stringify(`${url}?synthetic-original`)};` };
  }
  return nextLoad(url, context);
}
