export async function load(url, context, nextLoad) {
  if (url.endsWith("/mcp/persistent-snowflake-session.mjs")) return {
    format: "module", shortCircuit: true,
    source: `export { PersistentSnowflakeSession } from ${JSON.stringify(new URL("./outreach-regression-session.mjs", import.meta.url).href)};`,
  };
  return nextLoad(url, context);
}
