// Only fixed categories and bounded numbers may cross a source-error boundary.
// Never copy exception messages, SDK stdout, SQL, source IDs or credential URLs.
const STAGES = new Set(["connection_start", "authentication", "worker_bootstrap", "worker_protocol",
  "statement_execution", "fetch_results", "serialization"]);
const TYPES = new Set(["SnowflakeSignInRequired", "ProgrammingError", "OperationalError", "DatabaseError",
  "InterfaceError", "InternalError", "IntegrityError", "DataError", "NotSupportedError", "Error",
  "ModuleNotFoundError", "ImportError", "PermissionError", "OSError", "ValueError", "TypeError",
  "KeyError", "TimeoutError", "ConnectionError", "BootstrapError", "SourceReadError"]);
const CODES = new Set(["SNOWFLAKE_SESSION_UNAVAILABLE", "SNOWFLAKE_SESSION_TIMEOUT",
  "SNOWFLAKE_SESSION_START_TIMEOUT", "SNOWFLAKE_SESSION_WINDOW_TIMEOUT", "SNOWFLAKE_SESSION_QUERY_FAILED",
  "SNOWFLAKE_SESSION_CLOSED", "SNOWFLAKE_CONNECTION_NOT_CONFIGURED", "SNOWFLAKE_SIGN_IN_REQUIRED"]);
const WORKER_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOMEM", "WORKER_START_FAILED",
  "INVALID_WORKER_RESPONSE", "WORKER_INPUT_FAILED"]);
const TIMINGS = ["connection_start_ms", "statement_execution_ms", "fetch_results_ms", "serialization_ms",
  "execution_duration_ms", "execution_timeout_ms", "worker_start_timeout_ms"];
const duration = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? Math.round(value) : null;

export function safeSnowflakeReadDiagnostics(error) {
  const details = error?.details || {};
  const result = {
    source_read_code: CODES.has(error?.code) ? error.code : "SNOWFLAKE_READ_FAILED",
    failure_stage: STAGES.has(details.failure_stage) ? details.failure_stage : "unknown",
    source_error_type: TYPES.has(details.source_error_type) ? details.source_error_type : null,
    source_error_number: Number.isSafeInteger(details.source_error_number) && details.source_error_number >= 0 ? details.source_error_number : null,
    source_sqlstate: typeof details.source_sqlstate === "string" && /^[A-Z0-9]{5}$/.test(details.source_sqlstate) ? details.source_sqlstate : null,
    worker_error_code: WORKER_CODES.has(details.worker_error_code) ? details.worker_error_code : null,
    worker_exit_code: Number.isInteger(details.worker_exit_code) && details.worker_exit_code >= 0 && details.worker_exit_code <= 255 ? details.worker_exit_code : null,
    worker_signal: ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"].includes(details.worker_signal) ? details.worker_signal : null,
  };
  for (const key of TIMINGS) if (duration(details[key]) !== null) result[key] = duration(details[key]);
  return result;
}
