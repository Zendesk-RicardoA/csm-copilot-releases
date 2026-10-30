export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("persistent-snowflake-session.mjs")) return { url: new URL("./outreach-monthly-recovery-session.mjs", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
