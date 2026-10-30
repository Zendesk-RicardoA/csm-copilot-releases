const PROHIBITED_POWERPOINT_MARKERS = [
  "pptx",
  "powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

/**
 * The beta's only presentation output is a private native Google Slides draft.
 * The renderer may receive customer content in bridgeInput, so inspect only the
 * output instructions rather than scanning all content for ordinary mentions of
 * PowerPoint.
 */
export function assertNoPowerPointOutput(output = {}) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    fail("INVALID_RENDER_OUTPUT", "The presentation output instructions must be an object.");
  }
  const outputValues = [
    output.format,
    output.mimeType,
    output.mime_type,
    output.extension,
    output.fileExtension,
    output.file_extension,
    output.filename,
    output.fileName,
    output.exportFormat,
    output.export_format,
  ];
  const prohibited = outputValues.some((value) => (
    typeof value === "string"
    && PROHIBITED_POWERPOINT_MARKERS.some((marker) => value.toLowerCase().includes(marker))
  ));
  if (prohibited) {
    fail(
      "PPTX_OUTPUT_PROHIBITED",
      "This beta creates private native Google Slides drafts only. PPTX or PowerPoint output is not allowed.",
    );
  }
  return true;
}

export const NATIVE_PRESENTATION_OUTPUT = Object.freeze({
  provider: "google_slides",
  native: true,
  private_draft_only: true,
});
