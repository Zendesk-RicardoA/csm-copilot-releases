// Test-only source replacement. The caller also sets an impossible Snowflake
// Python path, so a loader failure cannot reach a live source.
export async function load(url, context, nextLoad) {
  if (url.endsWith("/mcp/persistent-snowflake-session.mjs")) {
    const fixture = new URL("./meeting-synthetic-session.mjs", import.meta.url).href;
    return {
      format: "module",
      shortCircuit: true,
      source: `export { PersistentSnowflakeSession } from ${JSON.stringify(fixture)};`,
    };
  }
  return nextLoad(url, context);
}
