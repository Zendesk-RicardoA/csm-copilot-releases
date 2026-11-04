# ISMA 0.3.6 — managed Snowflake installation

ISMA 0.3.6 improves first-time Snowflake installation.

After the user approves Python and Snowflake CLI installation, ISMA can download its own tested private runtime. Homebrew and a preinstalled Python are no longer prerequisites on supported Macs.

The installer checks disk space and folder access, verifies the Python archive and every Snowflake package hash, reports progress, resumes verified partial downloads, and activates only after local checks pass. Existing profiles and working software are preserved. Broken software can receive a separate private environment.

Technical verification includes the complete source and packaged workflow checks and actual fresh installation tests for Apple Silicon and Intel. Apple Silicon ran natively; Intel ran through existing Rosetta support. Physical Intel and independent colleague installation remain separate acceptance checks.

This preserves the existing public candidate channel, company authentication, account permissions, no-expiry policy, private draft approvals and Gmail signature handling. No customer data was read and no presentation renderer was changed.
