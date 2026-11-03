# ISMA Snowflake setup repair

Package: **0.3.5-isma.live.codex.20261103174914**.
Frozen package SHA-256: 52b0ffe790c2e69130db5f25010714e86b5ed912f0bb87f40d0cf4f84489ff29.

This candidate update repairs Snowflake setup when Homebrew installs Snowflake CLI through a Bash launcher. ISMA now resolves the formula's Python runtime, rejects a shell launcher as a Python interpreter, and reports an explicit unsupported-runtime error when it cannot find a valid runtime. If the CLI is installed but local configuration fails, setup reports the configuration block and preserves existing settings instead of attempting another CLI install.

Homebrew detection and installation guidance is deferred to a later update. Existing company sign-in, source permissions and private draft reviews remain in force. The frozen candidate passed all technical gates and invented workflow simulations. Independent colleague installation, live customer workflows and human rendered-output acceptance have not been completed for this version.
