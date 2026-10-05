/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Packages saved Smart Window E2E runs into a static site: each run is
 * re-rendered with the current report code into reports/<run>/ (roll-up as
 * index.html, plus its scenario reports and judge results), and a top-level
 * index.html lists every packaged run. Fails if anything that looks like a
 * credential ends up in the output.
 *
 * Usage, from the repo root:
 *   ./mach node browser/components/aiwindow/models/tests/browser_eval/publish_reports.mjs \
 *     <run> [<run> ...] --out <site dir> [--artifacts <dir>]
 *
 * <run> is a roll-up timestamp (as in smartwindow-e2e-rollup-<run>.json) or a
 * unique prefix of one. Runs already in <site dir>/reports stay listed.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const takeFlag = flag => {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const [, value] = args.splice(index, 2);
  return value;
};
const artifacts = path.resolve(
  takeFlag("--artifacts") ?? path.join(evalDir, "../../../../../../artifacts")
);
const outFlag = takeFlag("--out");
if (!outFlag || !args.length) {
  console.error(
    "Usage: publish_reports.mjs <run> [<run> ...] --out <site dir> [--artifacts <dir>]"
  );
  process.exit(1);
}
const out = path.resolve(outFlag);

const files = fs.readdirSync(artifacts);
const readJSON = file =>
  JSON.parse(fs.readFileSync(path.join(artifacts, file), "utf8"));

// The few Firefox APIs report.sys.mjs uses, for running it under Node.
let uploadDir = "";
let firefoxVersion = "unknown";
globalThis.Services = {
  env: { get: key => (key === "MOZ_UPLOAD_DIR" ? uploadDir : "") },
  appinfo: {
    get version() {
      return firefoxVersion;
    },
    appBuildID: "",
  },
};
globalThis.PathUtils = {
  join: (...parts) => path.join(...parts),
  filename: file => path.basename(file),
};
globalThis.IOUtils = {
  makeDirectory: async dir => fs.mkdirSync(dir, { recursive: true }),
  writeUTF8: async (file, text) => fs.writeFileSync(file, text),
  writeJSON: async (file, data) => fs.writeFileSync(file, JSON.stringify(data)),
};
const { writeRollupReport, writeScenarioReport } =
  await import("./report.sys.mjs");

for (const run of args) {
  const matches = files.filter(
    file =>
      file.startsWith(`smartwindow-e2e-rollup-${run}`) && file.endsWith(".json")
  );
  if (matches.length !== 1) {
    console.error(
      `Expected one roll-up for ${run} in ${artifacts}, found ${matches.length}`
    );
    process.exit(1);
  }
  const stamp = matches[0].slice("smartwindow-e2e-rollup-".length, -5);
  const rollup = readJSON(matches[0]);
  uploadDir = path.join(out, "reports", stamp);
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  firefoxVersion = rollup.firefox?.version ?? "unknown";

  const judgeScriptFile =
    rollup.judgeScriptFile ?? `smartwindow-e2e-judge-${stamp}.js`;
  if (files.includes(judgeScriptFile)) {
    fs.copyFileSync(
      path.join(artifacts, judgeScriptFile),
      path.join(uploadDir, judgeScriptFile)
    );
  } else {
    console.warn(`${stamp}: no judge results; scores will show as pending`);
  }

  const modelNames = new Map(rollup.models.map(m => [m.modelChoice, m.model]));
  const scenarios = [];
  for (const file of rollup.reports) {
    const report = readJSON(file.replace(/\.html$/, ".json"));
    const { path: reportPath } = await writeScenarioReport({
      ...report,
      modelNames: new Map(Object.entries(report.modelNames ?? {})),
      judgeScriptFile,
    });
    scenarios.push({ ...report, reportPath });
  }
  const rollupPath = await writeRollupReport({
    scenarios,
    modelChoices: rollup.modelChoices ?? [...modelNames.keys()].sort(),
    modelNames,
    defaultModelChoice:
      rollup.defaultModelChoice ??
      rollup.models.find(m => m.isDefault)?.modelChoice,
    passRateGate: rollup.passRateGate,
    tokenBudget: rollup.tokenBudget ?? {
      used: rollup.health.tokensUsed,
      limit: rollup.health.tokenLimit,
    },
    judgeScriptFile,
    runStamp: stamp,
    scenariosPlanned: rollup.scenariosPlanned,
    feature: rollup.feature ?? "Tab grouping",
    mergedFrom: rollup.mergedFrom,
  });
  fs.renameSync(rollupPath, path.join(uploadDir, "index.html"));
  fs.renameSync(
    rollupPath.replace(/\.html$/, ".json"),
    path.join(uploadDir, "index.json")
  );
  console.log(`Packaged ${stamp} (${scenarios.length} scenarios)`);
}

const escapeHTML = text =>
  String(text).replace(
    /[&<>"]/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
  );
const runs = fs
  .readdirSync(path.join(out, "reports"))
  .filter(stamp =>
    fs.existsSync(path.join(out, "reports", stamp, "index.json"))
  )
  .map(stamp => ({
    stamp,
    rollup: JSON.parse(
      fs.readFileSync(path.join(out, "reports", stamp, "index.json"), "utf8")
    ),
  }))
  .sort((a, b) => b.stamp.localeCompare(a.stamp));
const rows = runs
  .map(({ stamp, rollup }) => {
    const { headline } = rollup;
    const date = stamp.replace(
      /^(?:merged-)?(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2}).*$/,
      "$1 $2:$3 UTC"
    );
    return `<tr>
      <td><a href="reports/${encodeURIComponent(stamp)}/index.html">${escapeHTML(date)}</a></td>
      <td>${escapeHTML(rollup.feature ?? "")}</td>
      <td>${rollup.scenariosFinished} scenarios · ${rollup.models.length} models</td>
      <td><span class="pill pill-${escapeHTML(headline.key)}">${escapeHTML(headline.label)}</span> ${escapeHTML(headline.text)}</td>
    </tr>`;
  })
  .join("");
fs.writeFileSync(
  path.join(out, "index.html"),
  `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smart Window AI Quality Reports</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2em; color: #1c1b22; max-width: 80em; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #cfcfd8; padding: 6px 8px; text-align: start; vertical-align: top; }
  th { background: #f0f0f4; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
  .pill-green { background: #d7f5e3; color: #01532b; }
  .pill-yellow { background: #fff4de; color: #7a4a00; }
  .pill-red { background: #ffe1e6; color: #8f0030; }
  .pill-gray { background: #f0f0f4; color: #5b5b66; }
  @media (max-width: 720px) {
    body { margin: 1em; }
    thead { display: none; }
    table, tbody, tr, td { display: block; }
    tr { border: 1px solid #cfcfd8; border-radius: 6px; margin-bottom: 0.75em; }
    td { border: none; }
  }
</style>
</head>
<body>
<h1>Smart Window AI Quality Reports</h1>
<p>End-to-end evals of Smart Window features against real models. Newest first.</p>
<table>
  <thead><tr><th>Run</th><th>Feature</th><th>Size</th><th>Result</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body>
</html>
`
);

// Fail rather than publish anything that looks like a credential.
const secrets = [
  process.env.MOZ_FXA_BEARER_TOKEN,
  process.env.MOZ_MLPA_AUTHORIZATION_TOKEN,
].filter(value => value && value.length > 8);
const patterns = [
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/,
  /Bearer\s+[\w.~+/-]{20,}/i,
  /\b[0-9a-f]{64}\b/,
];
const leaks = [];
const scan = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(file);
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    if (
      secrets.some(secret => text.includes(secret)) ||
      patterns.some(pattern => pattern.test(text))
    ) {
      leaks.push(path.relative(out, file));
    }
  }
};
scan(path.join(out, "reports"));
if (leaks.length) {
  console.error(
    `Possible credentials found; not safe to publish:\n  ${leaks.join("\n  ")}`
  );
  process.exit(1);
}
console.log(
  `Site ready in ${out} (${runs.length} runs, credential scan clean)`
);
