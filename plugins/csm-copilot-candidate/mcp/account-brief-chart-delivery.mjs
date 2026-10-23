import { BetaError } from "./core.mjs";
import { renderAccountPerformanceChartPng } from "./account-performance-charts.mjs";

/** Native image only, from an existing owner-scoped read. No query or local file. */
export function accountBriefChartResult(display, chartId) {
  const chart = display?.charts?.find((item) => item.id === chartId);
  if (!chart) throw new BetaError("ACCOUNT_BRIEF_CHART_UNAVAILABLE", "This chart is not available in the temporary account brief. Do not substitute another account or invent values.");
  return { isError: false, content: [
    { type: "text", text: JSON.stringify({ chart_id: chart.id, title: chart.title, unit: chart.unit, alternative: chart.alternative,
      delivery_state: "image_returned_visibility_unverified",
      preferred_delivery: "authorized_temporary_png_markdown",
      inline_delivery: { helper: "generatedImage", image_content_index: 1, encoding: "data_url", separate_completed_exec: true, local_file_required: false },
      next_action: "This tool PNG is not proof of visible delivery. If the CSM authorized temporary local chart images, call the same control with local_file_delivery_authorized=true and embed local_delivery.markdown directly in the final reply with its expiry. Otherwise keep the verified monthly tables and explain the display gap. Do not repeat the failed in-memory image route, print base64, upload data or reread the account. Visibility remains unverified until the CSM can see the chart." }) },
    { type: "image", mimeType: "image/png", data: renderAccountPerformanceChartPng(chart).toString("base64") },
  ] };
}

/** Exact native PNG to the desktop's visible image-output payload, in memory. */
export function accountBriefChartInlineImage(result) {
  const images = result?.content?.filter((item) => item.type === "image") || [];
  let receipt;
  try { receipt = JSON.parse(result?.content?.find((item) => item.type === "text")?.text); } catch { /* Fail closed below. */ }
  if (result?.isError || images.length !== 1 || images[0].mimeType !== "image/png"
      || receipt?.inline_delivery?.helper !== "generatedImage" || !receipt.title || !receipt.unit) {
    throw new BetaError("ACCOUNT_BRIEF_CHART_DELIVERY_INVALID", "The native chart output cannot be forwarded safely. Keep its table and report the display gap.");
  }
  const bytes = Buffer.from(images[0].data || "", "base64");
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new BetaError("ACCOUNT_BRIEF_CHART_DELIVERY_INVALID", "The chart output is not a valid native PNG. Do not substitute another chart.");
  }
  return { image_url: `data:image/png;base64,${images[0].data}`, output_hint: `${receipt.title} — ${receipt.unit}. ${receipt.alternative}` };
}
