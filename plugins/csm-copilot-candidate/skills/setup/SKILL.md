---
name: setup
description: Complete or repair first-run CSM Copilot setup after installation from its private marketplace. Use for marketplace activation and setup, not customer research or a workflow case.
---

# CSM Copilot first-run setup

Installation adds the plugin. It does not approve customer access, authenticate a
person, verify a Slides builder or complete any customer workflow.

## Check before changing anything

Resolve the plugin root from this installed skill's directory (`../..`). Use the
desktop's existing Node runtime to run the packaged helper
`mcp/marketplace-setup.mjs inspect`. Do not fetch or install another runtime.
The helper returns only setup status; never print the private files.

- If `configured`, continue the normal native setup wizard. Do not import again.
- If `private_setup_required`, ask for the matching private setup file supplied
  by the release owner. It is separate from the Git marketplace and contains
  release controls, not credentials. Do not create, edit or guess it.
- If blocked, show the returned code and next action. Do not modify a manifest,
  retry a sign-in to repair release configuration, or bypass company restrictions.

## Apply only the selected release setup

Ask once for permission to save the displayed bounded local release setup and
for the user's own company sign-in name if it was not already supplied. This is
only an SSO login hint; identity and permissions come from actual authentication.
Never ask for a password, token or sign-in code.

After that authorization, invoke `mcp/marketplace-setup.mjs apply` using the
existing Node runtime. Supply this JSON through the process's standard input,
not command-line arguments, shell interpolation, a repository file or a log:

```json
{
  "setup_file": "/absolute/path/to/selected/private-setup.json",
  "local_configuration_authorized": true,
  "login_hint": "operator@example.invalid"
}
```

Replace the example with only the selected path and the user's supplied login
hint. The helper verifies the exact plugin, frozen release proof, controls and
renderer contracts before saving anything. It preserves credentials, personal
settings and cases; it does not install software, sign in, query sources, update
builders or create drafts. Do not run customer workflows during this step.

If `restart_required`, tell the user to restart the desktop app and open a fresh
chat. Do not claim the current process has reloaded the configuration.

## Continue the existing setup controls

Use the native `beta_start_setup_wizard`, `beta_prepare_snowflake_setup`,
`beta_configure_snowflake_zdp` and `beta_connect_snowflake_zdp` controls as needed.
Software installation and local Snowflake-profile creation retain their own
permission requirements. Use existing host plugins for their own connection
flows; never import a teammate's credentials or change security settings.

Keep connection readiness separate from workflow verification. A missing Gmail
signature or Slides builder must not prevent book analysis or account preparation.
Stop after setup; a setup request does not authorize a customer case, source
acceptance run, email draft or deck. Follow the normal CSM Copilot workflow skill
only when the user requests that work.
