/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Merges several Smart Window E2E runs into one roll-up, for example a
 * sidebar run and a full page run, or CI shards. Scenario reports stay where
 * they are; the merged roll-up links to them and loads a merged judge results
 * file. When two runs have the same scenario, the newer run wins.
 *
 * Usage, from the repo root:
 *   ./mach node browser/components/aiwindow/models/tests/browser_eval/merge_runs.mjs \
 *     <run> <run> [...] [--artifacts <dir>]
 *
 * <run> is a roll-up timestamp (as in smartwindow-e2e-rollup-<run>.json) or a
 * unique prefix of one.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let artifacts = path.resolve(evalDir, "../../../../../../artifacts");
const artifactsFlag = args.indexOf("--artifacts");
if (artifactsFlag !== -1) {
  artifacts = path.resolve(args[artifactsFlag + 1]);
  args.splice(artifactsFlag, 2);
}
if (args.length < 2) {
  console.error("Usage: merge_runs.mjs <run> <run> [...] [--artifacts <dir>]");
  process.exit(1);
}

const files = fs.readdirSync(artifacts);
const readJSON = file =>
  JSON.parse(fs.readFileSync(path.join(artifacts, file), "utf8"));
const runs = args
  .map(run => {
    const matches = files.filter(
      file =>
        file.startsWith(`smartwindow-e2e-rollup-${run}`) &&
        file.endsWith(".json")
    );
    if (matches.length !== 1) {
      console.error(
        `Expected one roll-up for ${run} in ${artifacts}, found ${matches.length}`
      );
      process.exit(1);
    }
    const stamp = matches[0].slice(
      "smartwindow-e2e-rollup-".length,
      -".json".length
    );
    return { stamp, rollup: readJSON(matches[0]) };
  })
  // Oldest first, so newer runs win.
  .sort((a, b) => a.rollup.generated.localeCompare(b.rollup.generated));

// The few Firefox APIs report.sys.mjs uses, for running it under Node.
const first = runs[0].rollup;
globalThis.Services = {
  env: { get: key => (key === "MOZ_UPLOAD_DIR" ? artifacts : "") },
  appinfo: {
    version: first.firefox?.version ?? "unknown",
    appBuildID: first.firefox?.buildID ?? "",
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
const { runStamp, writeRollupReport } = await import("./report.sys.mjs");

const scenarios = new Map();
const modelNames = new Map();
const judgeResults = {};
const tokenBudget = { limit: 0, used: 0 };
for (const { stamp, rollup } of runs) {
  for (const entry of rollup.models) {
    modelNames.set(entry.modelChoice, entry.model);
  }
  tokenBudget.used += rollup.health.tokensUsed;
  tokenBudget.limit += rollup.health.tokenLimit;
  for (const file of rollup.reports) {
    const report = readJSON(file.replace(/\.html$/, ".json"));
    if (scenarios.has(report.id)) {
      console.warn(
        `${report.id} is in more than one run; keeping the one from ${stamp}`
      );
    }
    scenarios.set(report.id, {
      ...report,
      reportPath: path.join(artifacts, file),
    });
  }
  const judgeFile =
    rollup.judgeScriptFile ?? `smartwindow-e2e-judge-${stamp}.js`;
  if (files.includes(judgeFile)) {
    const text = fs.readFileSync(path.join(artifacts, judgeFile), "utf8");
    Object.assign(
      judgeResults,
      JSON.parse(
        text
          .slice(text.indexOf("=") + 1)
          .trim()
          .replace(/;$/, "")
      )
    );
  }
}

const stamp = `merged-${runStamp()}`;
const judgeScriptFile = `smartwindow-e2e-judge-${stamp}.js`;
fs.writeFileSync(
  path.join(artifacts, judgeScriptFile),
  `window.LLM_JUDGE_RESULTS = ${JSON.stringify(judgeResults)};\n`
);
const rollupPath = await writeRollupReport({
  scenarios: [...scenarios.values()],
  modelChoices: [...modelNames.keys()].sort(),
  modelNames,
  defaultModelChoice:
    first.defaultModelChoice ??
    first.models.find(entry => entry.isDefault)?.modelChoice,
  passRateGate: first.passRateGate,
  tokenBudget,
  judgeScriptFile,
  runStamp: stamp,
  scenariosPlanned: scenarios.size,
  feature: first.feature,
  mergedFrom: runs.map(run => run.stamp),
});
console.log(`Merged roll-up: ${rollupPath}`);
