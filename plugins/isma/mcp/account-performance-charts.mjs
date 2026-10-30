import { deflateSync } from "node:zlib";

const monthKey = (value) => String(value || "").match(/(\d{4})-?(0[1-9]|1[0-2])/)?.slice(1).join("-") || null;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const ordinal = (period) => Number(period.slice(0, 4)) * 12 + Number(period.slice(5)) - 1;
const periodAt = (n) => `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, "0")}`;
export function normalizeMetricMonths(metric) {
  const byMonth = new Map(), conflicts = new Set(), issues = [], unplaced = [];
  for (const point of metric.completed_month_trend || metric.trend || []) {
    const period = monthKey(point.period);
    if (!period) { issues.push(`${metric.metric}:invalid_period`); unplaced.push(point); continue; }
    const value = finite(point.value) ? point.value : null;
    if (conflicts.has(period)) continue;
    if (byMonth.has(period) && byMonth.get(period) !== value) { byMonth.set(period, null); conflicts.add(period); issues.push(`${metric.metric}:${period}:conflicting`); }
    else byMonth.set(period, value);
  }
  const periods = [...byMonth.keys()].sort();
  return { issues, unplaced, points: periods.length ? Array.from({ length: ordinal(periods.at(-1)) - ordinal(periods[0]) + 1 }, (_, index) => {
    const period = periodAt(ordinal(periods[0]) + index);
    return { period, value: byMonth.get(period) ?? null };
  }) : [] };
}
export function buildAccountPerformanceCharts(brief) {
  const metrics = brief?.sections?.support_operations?.facts?.metric_table || [];
  const groups = new Map(), issues = [];
  for (const metric of metrics) {
    const monthly = normalizeMetricMonths(metric);
    issues.push(...monthly.issues);
    if (monthly.points.filter((point) => finite(point.value)).length < 2) continue;
    // Metrics keep their own scale/definition. Only created/solved volume
    // shares a chart; never put hours, counts and rates on one axis.
    const group = metric.unit === "tickets" ? "Ticket volume" : metric.metric;
    if (!groups.has(group)) groups.set(group, { title: group, type: metric.unit === "tickets" ? "columns" : "line", unit: metric.unit || "value", series: [] });
    groups.get(group).series.push({ name: metric.metric, source: metric.source, definition: metric.definition,
      points: monthly.points });
  }
  const charts = [...groups.values()].map((chart, index) => {
    const allPeriods = [...new Set(chart.series.flatMap((series) => series.points.map((point) => point.period)))].sort();
    chart.series = chart.series.map((series) => ({ ...series, points: allPeriods.map((period) => ({ period, value: series.points.find((point) => point.period === period)?.value ?? null })) }));
    return { ...chart, id: `monthly_${index + 1}`, x_axis: "Month", y_axis: chart.unit,
      gap_policy: "Missing or conflicting months are gaps; no zero substitution, interpolation or line across gaps.",
      alternative: `${chart.title}, ${chart.unit}. Exact monthly values and definitions are in the accompanying table.` };
  });
  return { charts, issues };
}

// Small, dependency-free PNG renderer. Only chart marks and labels are drawn;
// no customer content is written to disk or sent to an external chart service.
// Palette values are the reviewed Zendesk Licorice, Coconut, Sesame-300,
// Blue-500 and Cyan-500 tokens. No skill or brand package is a runtime dependency.
const PALETTE = { text: [17, 17, 13], background: [255, 255, 255], grid: [213, 213, 210], series: [[58, 120, 170], [0, 74, 60]] };
const FONT = {
  A:"7e1111117e",B:"7f49494936",C:"3e41414122",D:"7f4141221c",E:"7f49494941",F:"7f09090901",G:"3e41495132",H:"7f0808087f",I:"00417f4100",J:"204040403f",K:"7f08142241",L:"7f40404040",M:"7f020c027f",N:"7f0408107f",O:"3e4141413e",P:"7f09090906",Q:"3e4151215e",R:"7f09192946",S:"2649494932",T:"01017f0101",U:"3f4040403f",V:"1f2040201f",W:"3f4038403f",X:"6314081463",Y:"0708700807",Z:"6151494543",
  0:"3e5149453e",1:"00427f4000",2:"4261514946",3:"2141454b31",4:"1814127f10",5:"2745454539",6:"3c4a494930",7:"0171090503",8:"3649494936",9:"064949291e",
  " ":"0000000000","-":"0808080808",".":"0060600000",":":"0036360000","/":"2010080402","%":"2313086462",",":[0,64,32,0,0],"?":"0201510906",
};
function crc(buffer) { let result = 0xffffffff; for (const byte of buffer) { result ^= byte; for (let n = 0; n < 8; n++) result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0); } return (result ^ 0xffffffff) >>> 0; }
function chunk(type, body) { const bytes = Buffer.concat([Buffer.from(type), body]), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(body.length); checksum.writeUInt32BE(crc(bytes)); return Buffer.concat([length, bytes, checksum]); }
export function accountPerformanceAxisLabels(periods) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const count = periods.length <= 12 ? periods.length : Math.min(12, Math.ceil(periods.length / 2));
  return Array.from({ length: count }, (_, tick) => {
    const index = count <= 1 ? 0 : Math.floor(tick * (periods.length - 1) / (count - 1));
    const period = periods[index];
    return { index, month: months[Number(period.slice(5, 7)) - 1], year: period.slice(0, 4) };
  });
}
export function renderAccountPerformanceChartPng(chart) {
  const width = 840, height = 380, pixels = Buffer.alloc(width * height * 3, 255);
  const pixel = (x, y, color) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= width || y >= height) return; const at = (y * width + x) * 3; color.forEach((v, i) => { pixels[at + i] = v; }); };
  const rect = (x, y, w, h, color) => { for (let a = Math.ceil(x); a < x + w; a++) for (let b = Math.ceil(y); b < y + h; b++) pixel(a, b, color); };
  const line = (x1, y1, x2, y2, color, thick = 1) => { const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1); for (let n = 0; n <= steps; n++) rect(x1 + (x2-x1)*n/steps, y1 + (y2-y1)*n/steps, thick, thick, color); };
  const text = (value, x, y, scale = 2) => { for (const letter of String(value).toUpperCase()) { const glyph = FONT[letter] || FONT["?"]; const columns = Array.isArray(glyph) ? glyph : glyph.match(/../g).map((v) => parseInt(v, 16)); columns.forEach((bits, a) => { for (let b = 0; b < 7; b++) if (bits & (1 << b)) rect(x+a*scale, y+b*scale, scale, scale, PALETTE.text); }); x += 6*scale; } };
  // Wrap rather than truncate long metric names.
  const title = String(chart.title).match(/.{1,55}(?:\s|$)|.{1,55}/g) || [chart.title];
  title.forEach((part, i) => text(part.trim(), 18, 12 + i*18));
  text(`${chart.y_axis} / ${chart.x_axis}`, 18, 12 + title.length*18);
  chart.series.forEach((series, i) => { rect(18+i*410, 70, 16, 8, PALETTE.series[i%2]); text(`${i+1}. ${series.name}`, 40+i*410, 65); });
  const periods = chart.series[0]?.points.map((p) => p.period) || [];
  const values = chart.series.flatMap((s) => s.points.map((p) => p.value)).filter(finite);
  if (!periods.length || !values.length) throw new Error("A chart needs verified observations.");
  const minimum = Math.min(0, ...values), maximum = Math.max(...values, 0), range = maximum - minimum || 1;
  const low = minimum, high = maximum + range*0.1;
  const left = 90, right = 810, top = 104, bottom = 302;
  const y = (value) => bottom - (value-low)/(high-low)*(bottom-top);
  const x = (index) => left + (index+0.5)/periods.length*(right-left);
  for (let index = 0; index <= 4; index++) { const value = low+(high-low)*index/4, at = y(value); line(left, at, right, at, PALETTE.grid); text(new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value), 8, at-6); }
  // A six-character YY-MM label overlaps in a twelve-month slot. Split the
  // month and full year onto separate lines. Tick spacing never removes data.
  accountPerformanceAxisLabels(periods).forEach(({ index, month, year }) => {
    text(month, x(index) - 18, 318);
    text(year, x(index) - 24, 335);
  });
  chart.series.forEach((series, seriesIndex) => {
    const color = PALETTE.series[seriesIndex%2];
    series.points.forEach((point, index) => {
      if (!finite(point.value)) return;
      const px = x(index), py = y(point.value);
      if (chart.type === "columns") { const barWidth = (right-left)/periods.length/(series.points.length ? chart.series.length+1 : 2); rect(px + (seriesIndex-chart.series.length/2)*barWidth, Math.min(py,y(0)), barWidth-2, Math.max(1,Math.abs(y(0)-py)), color); }
      else { if (index && finite(series.points[index-1].value)) line(x(index-1),y(series.points[index-1].value),px,py,color,2); rect(px-3,py-3,6,6,color); }
    });
  });
  text("Missing months are gaps. Exact values are in the monthly table.", 18, 355);
  const scan = Buffer.alloc((width*3+1)*height);
  for (let y = 0; y < height; y++) pixels.copy(scan, y*(width*3+1)+1, y*width*3, (y+1)*width*3);
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(scan)),chunk("IEND",Buffer.alloc(0))]);
}
