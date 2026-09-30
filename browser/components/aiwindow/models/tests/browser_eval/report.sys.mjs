/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * HTML and JSON reports for the Smart Window E2E evals: one detailed report
 * per scenario and one roll-up per run for health checks.
 *
 * Attempt results: "pass", "model" (the model missed), "product" (Firefox did
 * not do what the model asked), "infra" (MLPA, auth or network), "budget" and
 * "smoke-check" (not run because the token budget was reached or the model did
 * not pass the smoke check scenario).
 */

import { catalogIdForUrl } from "./data/tab_catalog.sys.mjs";
import { JUDGE_DIMENSIONS } from "./prompts/judge.sys.mjs";

const FAILURE_RESULTS = ["model", "product", "infra"];

export const VERDICTS = {
  healthy: "Healthy",
  "investigate-browser": "Investigate: browser",
  "investigate-model": "Investigate: model",
  inconclusive: "Inconclusive",
  "not-run": "Not run",
};

export function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const formatTokens = n => (n ?? 0).toLocaleString("en-US");
const percent = rate => (rate === null ? "n/a" : `${Math.round(rate * 100)}%`);

function median(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * @returns {Promise<string>} MOZ_UPLOAD_DIR in CI, <srcdir>/artifacts locally.
 */
async function reportDir() {
  const dir =
    Services.env.get("MOZ_UPLOAD_DIR") ||
    PathUtils.join(Services.env.get("MOZ_DEVELOPER_REPO_DIR"), "artifacts");
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  return dir;
}

/**
 * Picks the file the LLM judge writes its per-attempt results to once
 * `./mach eval` finishes. Reports load it with a script tag, since pages
 * opened from disk cannot fetch sibling files.
 *
 * @param {string} stamp - From runStamp().
 * @returns {Promise<{path: string, fileName: string}>}
 */
export async function judgeResultsScript(stamp) {
  const fileName = `smartwindow-e2e-judge-${stamp}.js`;
  return { path: PathUtils.join(await reportDir(), fileName), fileName };
}

/**
 * @returns {string} A timestamp that names one run's roll-up and judge
 *   results files, so the roll-up can be rewritten in place as the run goes.
 */
export function runStamp() {
  return timestamp();
}

/**
 * @param {string} scenarioId
 * @param {string} modelChoice
 * @param {number} attempt
 * @returns {string} The id that links a judge result to its attempt.
 */
export const judgeId = (scenarioId, modelChoice, attempt) =>
  `${scenarioId}|${modelChoice}|${attempt}`;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Decides a verdict from one model's results in one scenario.
 *
 * - Any product failure: "Investigate: browser", whatever the pass rate.
 * - Fewer judged attempts than min(3, planned): "Inconclusive".
 * - Pass rate at or above the gate: "Healthy", otherwise "Investigate: model".
 *
 * Judged attempts are passes, model failures and product failures. Infra
 * failures and skipped attempts say nothing about the model or Firefox.
 *
 * @param {object} counts
 * @param {number} planned - Attempts planned per model.
 * @param {number} passRateGate - Between 0 and 1.
 * @returns {{key: string, label: string, detail: string}}
 */
export function computeVerdict(counts, planned, passRateGate) {
  const {
    passes,
    modelFailures,
    productFailures: product,
    infraFailures: infra,
    budget,
    smokeCheck,
  } = counts;
  const judged = passes + modelFailures + product;
  const verdict = (key, detail = "") => ({ key, label: VERDICTS[key], detail });

  if (!judged && !infra) {
    const reasons = [];
    if (smokeCheck) {
      reasons.push("did not pass the smoke check");
    }
    if (budget) {
      reasons.push("token budget reached");
    }
    return verdict("not-run", reasons.join("; "));
  }
  if (product) {
    return verdict(
      "investigate-browser",
      `${product} attempt(s) where Firefox did not do what the model asked`
    );
  }
  if (judged < Math.min(3, planned)) {
    return verdict(
      "inconclusive",
      infra
        ? `backend: ${infra} infra failure(s) left ${judged} judged attempt(s)`
        : `only ${judged} attempt(s) ran`
    );
  }
  const passRate = passes / judged;
  return passRate >= passRateGate
    ? verdict("healthy")
    : verdict(
        "investigate-model",
        `pass rate ${percent(passRate)} is under ${percent(passRateGate)}`
      );
}

function tokenTotals(attempts) {
  const withUsage = attempts.filter(a => a.usage);
  const sum = key => withUsage.reduce((total, a) => total + a.usage[key], 0);
  return {
    input: sum("input"),
    output: sum("output"),
    cached: sum("cached"),
    total: sum("total"),
  };
}

/**
 * @param {object[]} attempts
 * @returns {?{reason: string, count: number, text: string}} The most common
 *   problem among model and browser failures, falling back to infra failures,
 *   or null if there are none. A reason can list several problems separated
 *   by "; ", and each is counted.
 */
export function topIssue(attempts) {
  const mostCommon = results => {
    const counts = new Map();
    for (const a of attempts) {
      if (results.includes(a.result)) {
        for (const problem of a.reason.split("; ")) {
          counts.set(problem, (counts.get(problem) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  };
  const found = mostCommon(["model", "product"]);
  if (found) {
    const [reason, count] = found;
    return { reason, count, text: `${reason} (${count}x)` };
  }
  const infra = mostCommon(["infra"]);
  if (infra) {
    const [reason, count] = infra;
    return { reason, count, text: `Infra: ${reason} (${count}x)` };
  }
  return null;
}

/**
 * Summarizes one model's attempts in one scenario.
 *
 * @param {object[]} attempts - That model's attempts.
 * @param {number} planned - Attempts planned per model.
 * @param {number} passRateGate
 * @param {string} name - Model name.
 * @returns {object}
 */
export function summarizeModel(attempts, planned, passRateGate, name) {
  const count = result => attempts.filter(a => a.result === result).length;
  const turns = attempts.map(a => a.durationMs).filter(ms => ms > 0);
  const counts = {
    passes: count("pass"),
    modelFailures: count("model"),
    productFailures: count("product"),
    infraFailures: count("infra"),
    budget: count("budget"),
    smokeCheck: count("smoke-check"),
  };
  const judged = counts.passes + counts.modelFailures + counts.productFailures;
  const tokens = tokenTotals(attempts);
  const ran = attempts.length - counts.budget - counts.smokeCheck;
  return {
    modelChoice: attempts[0].modelChoice,
    model: name,
    attempts: attempts.length,
    ...counts,
    judged,
    passRate: judged ? counts.passes / judged : null,
    verdict: computeVerdict(counts, planned, passRateGate),
    confirmationPath: attempts.filter(a => a.path === "confirmation").length,
    directPath: attempts.filter(a => a.path === "direct").length,
    // Only attempts that ran a turn; skipped and early infra attempts are 0.
    medianSeconds: turns.length ? median(turns) / 1000 : null,
    rateLimitRetries: attempts.reduce((sum, a) => sum + (a.retries ?? 0), 0),
    tokens,
    tokensPerAttempt: ran ? Math.round(tokens.total / ran) : 0,
    tokensPerPass: counts.passes
      ? Math.round(tokens.total / counts.passes)
      : null,
    topIssue: topIssue(attempts),
  };
}

/**
 * Groups attempts by model choice and summarizes each group.
 *
 * @param {object[]} attempts
 * @param {number} planned - Attempts planned per model.
 * @param {number} passRateGate
 * @param {Map<string, string>} modelNames - Model name per choice.
 * @returns {object[]} One summary per model, in model choice order.
 */
function summarizeScenario(attempts, planned, passRateGate, modelNames) {
  const byModel = new Map();
  for (const attempt of attempts) {
    if (!byModel.has(attempt.modelChoice)) {
      byModel.set(attempt.modelChoice, []);
    }
    byModel.get(attempt.modelChoice).push(attempt);
  }
  return [...byModel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([modelChoice, forModel]) =>
      summarizeModel(
        forModel,
        planned,
        passRateGate,
        modelNames.get(modelChoice) || `model choice ${modelChoice}`
      )
    );
}

const failureMix = s =>
  `${s.modelFailures} model · ${s.productFailures} browser · ${s.infraFailures} infra`;

// What each verdict means and who acts on it; shown when a pill is tapped and
// in the help drawer.
const VERDICT_HELP = {
  healthy: {
    meaning: "Pass rate at or above the gate and no browser failures.",
    who: "Nobody",
  },
  "investigate-browser": {
    meaning: "Firefox did not do what the model asked, at least once.",
    who: "Firefox / Smart Window front end",
  },
  "investigate-model": {
    meaning: "Pass rate under the gate because of model misses.",
    who: "Models team",
  },
  inconclusive: {
    meaning: "Too few judged attempts, usually because of backend errors.",
    who: "MLPA owners, if it keeps happening",
  },
  "not-run": {
    meaning: "Every attempt was skipped (token budget or smoke check).",
    who: "Nobody; rerun if needed",
  },
};

const verdictBadge = verdict => {
  const { meaning, who } = VERDICT_HELP[verdict.key];
  const explanation = `${meaning}${verdict.detail ? ` Here: ${verdict.detail}.` : ""} Who looks: ${who}.`;
  return `<button type="button" class="verdict verdict-${verdict.key}" data-explain-title="${escapeHTML(verdict.label)}"
    data-explain="${escapeHTML(explanation)}" data-help-section="help-verdicts">${escapeHTML(verdict.label)}</button>`;
};

function cardIssue(summary) {
  if (summary.topIssue) {
    return `<div class="issue"><strong>Top issue:</strong> ${escapeHTML(summary.topIssue.text)}</div>`;
  }
  if (summary.verdict.key !== "healthy" && summary.verdict.detail) {
    return `<div class="muted">${escapeHTML(summary.verdict.detail)}</div>`;
  }
  return "";
}

const verdictNote = verdict =>
  verdict.detail
    ? `<div class="verdict-note">${escapeHTML(verdict.detail)}</div>`
    : "";

// One identity color per model, by picker choice, so a model looks the same
// in every table and report. Kept clear of the red, amber and green used for
// status.
const MODEL_COLORS = [
  { accent: "#0060df", tint: "#e8f0fe" },
  { accent: "#7542e5", tint: "#f1ebfd" },
  { accent: "#00767a", tint: "#e0f2f2" },
  { accent: "#4a5a8a", tint: "#eceff6" },
];

/**
 * @param {string} modelChoice
 * @returns {string} A style attribute setting the model's color variables.
 */
function modelStyle(modelChoice) {
  const index = Math.max(0, Number(modelChoice) - 1) % MODEL_COLORS.length;
  const { accent, tint } = MODEL_COLORS[index];
  return `style="--model-accent: ${accent}; --model-tint: ${tint}"`;
}

/**
 * @param {object[]} verdicts - One scenario's verdicts across models.
 * @returns {string} "investigate", "inconclusive", "healthy" or "not-run":
 *   the most serious, used to color the scenario.
 */
function scenarioStatus(verdicts) {
  const keys = verdicts.map(verdict => verdict.key);
  if (keys.some(key => key.startsWith("investigate"))) {
    return "investigate";
  }
  if (keys.includes("inconclusive")) {
    return "inconclusive";
  }
  return keys.includes("healthy") ? "healthy" : "not-run";
}

const STATUS_LABELS = {
  investigate: "Needs investigation",
  inconclusive: "Inconclusive",
  healthy: "Healthy",
  "not-run": "Not run",
};

function cellTint(verdict) {
  if (verdict.key.startsWith("investigate")) {
    return "cell-investigate";
  }
  if (verdict.key === "inconclusive") {
    return "cell-inconclusive";
  }
  return "";
}

const JUDGED_RESULTS = ["pass", "model"];

const judgeScriptTag = fileName =>
  fileName ? `<script src="${escapeHTML(fileName)}"></script>` : "";

// Used for scenario reports saved before scenarios declared a judge block.
const DEFAULT_JUDGE = {
  dimensions: ["goal_completion", "tool_accuracy"],
  summary: "goal_completion",
};
const judgeOf = scenario => scenario.judge ?? DEFAULT_JUDGE;

// Summaries hide a scenario's judge scores when the judge agrees with the
// browser check on fewer than this share of its judged attempts.
const JUDGE_AGREEMENT_GATE = 0.9;

/**
 * @param {Array<{id: string, judge: ?object, attempts: object[]}>} scenarios
 * @returns {string} JSON the judge filler reads: dimension labels, each
 *   scenario's summary dimension and the browser result of judged attempts.
 */
function judgeDataTag(scenarios) {
  const dimensions = new Set(
    scenarios.flatMap(scenario => judgeOf(scenario).dimensions)
  );
  const data = {
    gate: JUDGE_AGREEMENT_GATE,
    labels: Object.fromEntries(
      [...dimensions].map(key => [
        key,
        {
          label: JUDGE_DIMENSIONS[key].label,
          description: JUDGE_DIMENSIONS[key].description,
        },
      ])
    ),
    summary: Object.fromEntries(
      scenarios.map(scenario => [scenario.id, judgeOf(scenario).summary])
    ),
    attempts: scenarios.flatMap(scenario =>
      scenario.attempts
        .filter(a => JUDGED_RESULTS.includes(a.result))
        .map(a => ({
          id: judgeId(scenario.id, a.modelChoice, a.attempt),
          scenario: scenario.id,
          modelChoice: a.modelChoice,
          result: a.result,
        }))
    ),
  };
  return `<script type="application/json" id="judge-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

// Fills [data-judge-*] placeholders from window.LLM_JUDGE_RESULTS, which the
// judge results script defines, keyed by judgeId(). Scores show as colored
// chips: 8 and up good, 5 to 7 fair, 4 and under poor. The judge agrees with
// the browser check when a pass scores 5 or more on the scenario's summary
// dimension, or a failure scores 4 or less.
const JUDGE_FILLER = `<script>
(() => {
  const results = window.LLM_JUDGE_RESULTS;
  const dataElement = document.getElementById("judge-data");
  if (!results || !dataElement) {
    return;
  }
  const data = JSON.parse(dataElement.textContent);
  const oneDecimal = n => (Math.round(n * 10) / 10).toString();
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
  const bandText = {
    good: "8 and up: good.",
    fair: "5 to 7: the right items with minor issues.",
    poor: "4 and under: a real problem, such as a wrong or missing item.",
  };
  const chip = (key, score) => {
    const button = document.createElement("button");
    let band = "poor";
    if (score >= 8) {
      band = "good";
    } else if (score >= 5) {
      band = "fair";
    }
    button.type = "button";
    button.className = "score score-" + band;
    button.textContent = data.labels[key].label + " " + oneDecimal(score);
    button.dataset.explainTitle = data.labels[key].label + " " + oneDecimal(score);
    button.dataset.explain = data.labels[key].description + " " + bandText[band] +
      " From the LLM judge; it does not change the verdict.";
    button.dataset.helpSection = "help-judge";
    return button;
  };
  const showScores = (el, scores, judged) => {
    el.textContent = "";
    el.classList.remove("muted");
    el.dataset.judgeDims.split(",").forEach((key, i) => {
      el.append(i ? " " : "", chip(key, scores[key]));
    });
    if (judged) {
      const count = document.createElement("span");
      count.className = "judged-count";
      count.textContent = judged + " judged";
      el.append(" ", count);
    }
  };

  const agreement = {};
  for (const a of data.attempts) {
    const r = results[a.id];
    const key = data.summary[a.scenario];
    if (!r) {
      continue;
    }
    const tally = agreement[a.scenario] || (agreement[a.scenario] = { agree: 0, total: 0 });
    tally.total++;
    if (a.result === "pass" ? r[key] >= 5 : r[key] <= 4) {
      tally.agree++;
    }
  }

  for (const el of document.querySelectorAll("[data-judge-id]")) {
    const r = results[el.dataset.judgeId];
    if (r) {
      showScores(el, r);
    } else {
      el.textContent = "not judged";
    }
  }
  for (const el of document.querySelectorAll("[data-judge-reason]")) {
    const r = results[el.dataset.judgeReason];
    el.textContent = r ? r.reason || "(no reason given)" : "not judged";
  }
  for (const el of document.querySelectorAll("[data-judge-model]")) {
    const scenario = el.dataset.judgeScenario;
    const matching = data.attempts.filter(
      a => a.scenario === scenario && a.modelChoice === el.dataset.judgeModel && results[a.id]
    );
    if (!matching.length) {
      el.textContent = "not judged";
      continue;
    }
    const tally = agreement[scenario];
    if (tally.agree / tally.total < data.gate) {
      el.textContent = "Not calibrated (" + Math.round((100 * tally.agree) / tally.total) + "% agreement)";
      el.title = "The judge agrees with the browser check on fewer than " + Math.round(data.gate * 100) +
        "% of this scenario's judged attempts, so its scores are hidden here. Attempt rows still show them.";
      continue;
    }
    const scores = {};
    for (const key of el.dataset.judgeDims.split(",")) {
      scores[key] = mean(matching.map(a => results[a.id][key]));
    }
    showScores(el, scores, "judgeCompact" in el.dataset ? 0 : matching.length);
  }
})();
</script>`;

const judgePending = (attrs, tag = "span") =>
  `<${tag} ${attrs} class="muted" title="Filled in when ./mach eval runs the LLM judge">pending</${tag}>`;

const STYLES = `
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2em; color: #1c1b22; max-width: 110em; }
  h1 { margin-bottom: 0.2em; }
  .subtitle { color: #5b5b66; margin-top: 0; }
  .subtitle strong { color: #1c1b22; }
  table { border-collapse: collapse; margin: 1em 0; width: 100%; }
  th, td { border: 1px solid #cfcfd8; padding: 6px 8px; text-align: start; vertical-align: top; }
  th { background: #f0f0f4; }
  .pass { color: #017a40; font-weight: 600; }
  .fail { color: #c50042; font-weight: 600; }
  .muted { color: #5b5b66; }
  .banner { background: #ffe1e6; border: 1px solid #c50042; border-radius: 4px; padding: 10px 14px; margin: 0 0 1em; }
  .verdict { display: inline-block; padding: 1px 8px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
  .verdict-healthy { background: #d7f5e3; color: #01532b; }
  .verdict-investigate-browser, .verdict-investigate-model { background: #ffe1e6; color: #8f0030; }
  .verdict-inconclusive { background: #fff4de; color: #7a4a00; }
  .verdict-not-run { background: #f0f0f4; color: #5b5b66; }
  .cards { display: flex; flex-wrap: wrap; gap: 1em; margin: 1em 0; }
  button.verdict, button.score { border: none; font: inherit; cursor: pointer; }
  button.verdict { font-weight: 600; }
  button.score { font-size: 0.9em; font-weight: 600; }
  /* A small "?" badge marks pills that explain themselves when tapped. */
  button.verdict::after, button.score::after, .tap-hint {
    content: "?"; display: inline-block; width: 1.2em; height: 1.2em; line-height: 1.2em; margin-inline-start: 0.4em;
    border-radius: 50%; background: rgb(255 255 255 / 0.7); border: 1px solid currentColor; font-size: 0.75em; text-align: center; vertical-align: 0.1em;
  }
  .tap-hint { color: #5b5b66; }
  button.verdict:hover, button.score:hover { box-shadow: 0 0 0 2px currentColor; }
  button.verdict:focus-visible, button.score:focus-visible, .help-button:focus-visible { outline: 2px solid #0061e0; outline-offset: 2px; }
  .help-button:focus-visible { outline-color: #1c1b22; }
  .help-button { position: fixed; top: 12px; inset-inline-end: 12px; z-index: 5; display: inline-flex; align-items: center; gap: 0.4em; font: inherit; font-weight: 600; color: #fff; background: #0061e0; border: none; border-radius: 16px; padding: 5px 14px; cursor: pointer; box-shadow: 0 2px 8px rgb(0 0 0 / 0.2); }
  .help-button:hover { background: #0250bb; }
  /* Same circle as the "?" badge on tappable pills. */
  .help-icon { display: inline-block; width: 1.2em; height: 1.2em; line-height: 1.2em; border: 1px solid currentColor; border-radius: 50%; font-size: 0.75em; text-align: center; }
  body.help-open { margin-inline-end: calc(min(460px, 100vw) + 2em); }
  .help-drawer { position: fixed; inset-block: 0; inset-inline-start: auto; inset-inline-end: 0; margin: 0; width: min(460px, 100vw); height: 100vh; max-height: none; box-sizing: border-box; border: none; border-inline-start: 1px solid #cfcfd8; padding: 0 16px 16px; overflow-y: auto; background: #fff; color: #1c1b22; box-shadow: -4px 0 16px rgb(0 0 0 / 0.12); z-index: 10; }
  .help-drawer section { scroll-margin-top: 64px; }
  .help-drawer h3 { font-size: 1em; margin: 1.25em 0 0.25em; }
  .help-table { width: 100%; margin: 0.5em 0 1em; font-size: 0.9em; }
  .help-table th, .help-table td { padding: 5px 7px; }
  .help-table tbody tr:nth-child(even) td, .help-table tr:nth-child(even) > td { background: #f9f9fb; }
  .help-table th[scope="row"] { background: #f9f9fb; font-weight: 600; white-space: nowrap; }
  .help-table thead th { position: static; }
  .help-header { position: sticky; top: 0; background: #fff; display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #e0e0e6; }
  .help-header h2 { margin: 0; font-size: 1.15em; }
  .help-close { font: inherit; background: none; border: 1px solid #8f8f9d; border-radius: 4px; padding: 2px 10px; cursor: pointer; }
  .explain { position: fixed; inset: auto; margin: 0; max-width: min(22em, calc(100vw - 16px)); padding: 10px 12px; border: 1px solid #cfcfd8; border-radius: 6px; background: #fff; color: #1c1b22; box-shadow: 0 4px 16px rgb(0 0 0 / 0.15); }
  .explain p { margin: 4px 0 6px; }
  .matrix tbody th, .matrix tfoot th { background: #f9f9fb; font-weight: 600; white-space: nowrap; }
  .matrix td { overflow-wrap: anywhere; }
  .card { border: 1px solid #cfcfd8; border-radius: 6px; padding: 12px 16px; min-width: 16em; }
  .card h3 { margin: 0 0 6px; font-size: 1em; }
  .card .rate { font-size: 1.6em; font-weight: 600; }
  .card { max-width: 28em; }
  .issue { margin-top: 6px; font-size: 0.93em; }
  .rate-line { font-size: 0.9em; color: #5b5b66; margin-top: 3px; }
  .verdict-note { font-size: 0.9em; color: #5b5b66; margin-top: 3px; }
  .matrix td.cell-investigate { background: #fff0f3; }
  .matrix td.cell-inconclusive { background: #fffaf0; }
  #attempts td { background: #fff; }
  #attempts tr.result-product td, #attempts tr.result-infra td { background: #fff4de; }
  #attempts tr.result-budget td, #attempts tr.result-smoke-check td { background: #f0f0f4; color: #5b5b66; }
  details { margin: 0.5em 0; }
  summary { cursor: pointer; font-weight: 600; }
  pre { background: #f9f9fb; padding: 8px; max-width: 60em; white-space: pre-wrap; overflow-wrap: anywhere; }
  code { overflow-wrap: break-word; }
  thead th { position: sticky; top: 0; z-index: 2; }
  .score { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 0.9em; font-weight: 600; white-space: nowrap; }
  .score-good { background: #d7f5e3; color: #01532b; }
  .score-fair { background: #fff4de; color: #7a4a00; }
  .score-poor { background: #ffe1e6; color: #8f0030; }
  .judged-count { color: #5b5b66; font-size: 0.85em; white-space: nowrap; }
  .model-dot::before { content: ""; display: inline-block; width: 0.65em; height: 0.65em; border-radius: 50%; background: var(--model-accent); margin-inline-end: 0.45em; vertical-align: 0.05em; }
  .model-row th[scope="row"] { background: var(--model-tint); border-inline-start: 4px solid var(--model-accent); }
  th.model-head { background: var(--model-tint); border-bottom: 3px solid var(--model-accent); }
  .model-card { border-inline-start: 4px solid var(--model-accent); padding-top: 0; }
  .model-card h3 { background: var(--model-tint); margin: 0 -16px 8px; padding: 8px 16px; border-radius: 0 6px 0 0; }
  .note { background: #f0f0f4; border: 1px solid #cfcfd8; border-radius: 4px; padding: 10px 14px; margin: 0 0 1em; }
  .matrix tr.overall-row > * { background: #f0f0f4; font-weight: 600; border-bottom: 2px solid #8f8f9d; }
  .matrix-narrow { display: none; }
  .overall-rates ul, .scenario-models { list-style: none; padding: 0; margin: 0.4em 0; }
  .overall-rates li { padding: 2px 0; }
  .scenario-block { border: 1px solid; border-inline-start-width: 6px; border-radius: 6px; padding: 4px 12px; margin: 0.6em 0; }
  .scenario-block.status-investigate { background: #fff0f3; border-color: #c50042; }
  .scenario-block.status-inconclusive { background: #fffaf0; border-color: #a86500; }
  .scenario-block.status-healthy { background: #edfbf3; border-color: #017a40; }
  .scenario-block.status-not-run { background: #f9f9fb; border-color: #cfcfd8; }
  .scenario-block summary { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4em; }
  .scenario-block summary::before { content: "▸"; display: inline-block; transition: transform 0.15s; }
  .scenario-block[open] summary::before { transform: rotate(90deg); }
  .scenario-block .status-label { margin-inline-start: auto; font-size: 0.85em; }
  .scenario-models li { padding: 8px 0; border-top: 1px solid rgb(0 0 0 / 0.08); }
  .scenario-models li > div { margin-top: 4px; }
  .tag { display: inline-block; border: 1px solid #8f8f9d; border-radius: 4px; padding: 0 5px; font-size: 0.85em; font-weight: 600; margin-inline-start: 4px; }
  .headline { border: 1px solid; border-radius: 6px; padding: 12px 16px; margin: 1em 0; font-size: 1.1em; }
  .headline-healthy { background: #d7f5e3; border-color: #017a40; }
  .headline-investigate-browser, .headline-investigate-model { background: #ffe1e6; border-color: #c50042; }
  .headline-inconclusive { background: #fff4de; border-color: #a86500; }
  .headline-not-run { background: #f0f0f4; border-color: #8f8f9d; }
  .models th, .models td:nth-child(2), .models td:nth-child(3) { white-space: nowrap; }
  .hot-spot { border: 1px solid #cfcfd8; border-radius: 6px; padding: 8px 12px; }
  .hot-spot table { margin: 0.5em 0; }
  .hs-stats { font-weight: normal; color: #5b5b66; margin-inline-start: 0.5em; }
  dt { font-weight: 600; }
  .controls { display: flex; flex-wrap: wrap; gap: 1.5em; align-items: center; margin: 0.5em 0; }
  #attempts th[data-sortable] { cursor: pointer; user-select: none; }
  #attempts th[data-sortable]::after { content: " \\2195"; color: #8f8f9d; }
  #attempts th[aria-sort="ascending"]::after { content: " \\2191"; color: #1c1b22; }
  #attempts th[aria-sort="descending"]::after { content: " \\2193"; color: #1c1b22; }
  #attempts [data-col] { display: none; }
  #attempts.show-toolcalls [data-col="toolcalls"], #attempts.show-path [data-col="path"],
  #attempts.show-label [data-col="label"], #attempts.show-turn [data-col="turn"],
  #attempts.show-retries [data-col="retries"] { display: table-cell; }
  @media (max-width: 720px) {
    body { margin: 1em; }
    table.stack thead { display: none; }
    table.stack, table.stack tbody, table.stack tfoot, table.stack tr,
    table.stack th, table.stack td { display: block; width: auto; }
    table.stack tr { border: 1px solid #cfcfd8; border-radius: 6px; margin-bottom: 0.75em; }
    table.stack th, table.stack td,
    .matrix tfoot tr:first-child > * { border: none; border-top: 1px solid #e0e0e6; }
    table.stack tr > :first-child { border-top: none; border-radius: 6px 6px 0 0; }
    table.stack td[data-label]::before { content: attr(data-label); display: block; font-size: 0.9em; font-weight: 600; color: #5b5b66; }
    .matrix tbody th, .models th, .models td:nth-child(n) { white-space: normal; }
    .matrix-wide { display: none; }
    .matrix-narrow { display: block; }
    table.stack tr.model-row { border-inline-start: 4px solid var(--model-accent); }
    table.stack tr.model-row > th[scope="row"] { border-inline-start: none; }
    .card { flex: 1 1 100%; max-width: none; min-width: 0; }
    .card .rate { font-size: 1.3em; }
    .controls { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.5em; }
    .controls label { display: flex; flex-direction: column; align-items: stretch; gap: 2px; font-size: 0.9em; }
    .controls label:has(input[type="checkbox"]) { flex-direction: row; align-items: center; min-height: 44px; }
    .controls select { min-width: 0; width: 100%; }
    #column-chooser { display: none; }
    .desktop-only, table.desktop-only { display: none; }
    select, .touch { min-height: 44px; }
    .touch { display: inline-flex; align-items: center; }
    summary { padding-block: 12px; }
    .help-drawer { inset-block-start: auto; inset-inline: 0; width: 100vw; height: auto; max-height: 80vh; border-inline-start: none; border-top: 1px solid #cfcfd8; border-radius: 12px 12px 0 0; box-shadow: 0 -4px 16px rgb(0 0 0 / 0.15); }
    .help-drawer::backdrop { background: rgb(0 0 0 / 0.3); }
    .help-drawer { max-width: none; }
    .help-button { top: auto; bottom: 16px; min-height: 44px; }
    body { padding-bottom: 72px; }
    button.verdict, button.score { min-height: 32px; }
    /* Attempts become cards with a stripe colored by result. */
    #attempts, #attempts tbody, #attempts tr { display: block; }
    #attempts thead, #attempts [data-col] { display: none; }
    #attempts tr[hidden] { display: none; }
    #attempts tr { border: 1px solid #cfcfd8; border-inline-start: 6px solid #017a40; border-radius: 6px; margin: 0.6em 0; padding: 8px 12px; background: #fff; }
    #attempts tr.result-model, #attempts tr.result-product { border-inline-start-color: #c50042; }
    #attempts tr.result-infra { border-inline-start-color: #a86500; }
    #attempts tr.result-budget, #attempts tr.result-smoke-check { border-inline-start-color: #8f8f9d; }
    #attempts td { display: block; border: none; padding: 2px 0; }
    #attempts tr[class] td { background: transparent; }
    #attempts td.attempt-model, #attempts td.attempt-number, #attempts td.attempt-result { display: inline; }
    #attempts td.attempt-number::before { content: " #"; }
    #attempts td.attempt-result::before { content: " · "; color: #5b5b66; font-weight: normal; }
    #attempts td.attempt-reason { margin-top: 4px; }
    #attempts td[data-label]::before { content: attr(data-label) ": "; font-weight: 600; color: #5b5b66; }
  }
`;

const HELP_BUTTON = `<button type="button" id="help-open" class="help-button" aria-haspopup="dialog" aria-controls="help"><span class="help-icon" aria-hidden="true">?</span>How to read</button>`;

// The help drawer (a side panel on desktop, a bottom sheet on narrow screens)
// and the popover that explains a tapped verdict pill or judge chip.
const HELP = `
<dialog id="help" class="help-drawer" aria-labelledby="help-title">
  <div class="help-header">
    <h2 id="help-title">How to read this report</h2>
    <button type="button" class="help-close">Close</button>
  </div>
  <p class="muted">Tap a verdict or score (the ones marked with <span class="tap-hint">?</span>) for a short explanation.</p>
  <section id="help-page">
    <h3>The page</h3>
    <table class="help-table">
      <tr><th scope="row">Model table</th><td>Each model's verdict, how many judged attempts passed and its most common problem.</td></tr>
      <tr><th scope="row">Hot spots</th><td>Scenarios with the most failures and the models that failed them. "View failures" opens those attempts.</td></tr>
      <tr><th scope="row">Scenarios by model</th><td>Each scenario's verdict per model, its pass rate and the judge's main score.</td></tr>
      <tr><th scope="row">All attempts</th><td>Every attempt in a scenario report, with filters. "details" shows the tool calls, reply and tab groups.</td></tr>
    </table>
  </section>
  <section id="help-verdicts">
    <h3>Verdicts (per model)</h3>
    <table class="help-table">
      <thead><tr><th>Verdict</th><th>Meaning</th><th>Who looks</th></tr></thead>
      <tbody>
      ${Object.entries(VERDICT_HELP)
        .map(
          ([key, { meaning, who }]) =>
            `<tr><th scope="row"><span class="verdict verdict-${key}">${VERDICTS[key]}</span></th><td>${meaning}</td><td>${who}</td></tr>`
        )
        .join("")}
      </tbody>
    </table>
  </section>
  <section id="help-results">
    <h3>Attempt results</h3>
    <table class="help-table">
      <thead><tr><th>Result</th><th>Meaning</th><th>In pass rate</th></tr></thead>
      <tbody>
        <tr><th scope="row">pass</th><td>Exactly the expected tabs were grouped.</td><td>Yes</td></tr>
        <tr><th scope="row">model</th><td>The model did not call the tool or grouped the wrong tabs.</td><td>Yes</td></tr>
        <tr><th scope="row">product</th><td>Firefox did not do what the model asked: request not sent or aborted, no group after confirming, or a requested tab left out.</td><td>Yes</td></tr>
        <tr><th scope="row">infra</th><td>MLPA, auth or network errors.</td><td>No</td></tr>
        <tr><th scope="row">budget</th><td>Not run: the token budget was reached.</td><td>No</td></tr>
        <tr><th scope="row">smoke-check</th><td>Not run: the model did not pass the smoke check.</td><td>No</td></tr>
      </tbody>
    </table>
  </section>
  <section id="help-judge">
    <h3>Judge scores</h3>
    <p class="muted">An LLM second opinion, 1 to 10, on passes and model failures. It does not change verdicts.</p>
    <table class="help-table">
      <thead><tr><th>Score</th><th>What it asks</th><th>Shown on</th></tr></thead>
      <tbody>
        <tr><th scope="row">Goal completion</th><td>Did the end state match the request: every requested item handled, nothing else touched? Any wrong or missing item scores 4 or less.</td><td>Summaries and attempts</td></tr>
        <tr><th scope="row">Tool accuracy</th><td>Were the tools used correctly? Ignores which items were picked, so it can be 10 on a failure.</td><td>Attempts only</td></tr>
      </tbody>
    </table>
    <table class="help-table">
      <thead><tr><th>Color</th><th>Meaning</th></tr></thead>
      <tbody>
        <tr><th scope="row"><span class="score score-good">8 and up</span></th><td>Good</td></tr>
        <tr><th scope="row"><span class="score score-fair">5 to 7</span></th><td>The right items, with minor issues</td></tr>
        <tr><th scope="row"><span class="score score-poor">4 and under</span></th><td>A real problem, such as a wrong or missing item</td></tr>
      </tbody>
    </table>
    <table class="help-table">
      <thead><tr><th>Label</th><th>Meaning</th></tr></thead>
      <tbody>
        <tr><th scope="row">Not calibrated</th><td>The judge agrees with the browser check on fewer than 90% of the scenario's attempts, so summaries hide its score.</td></tr>
      </tbody>
    </table>
  </section>
  <section id="help-terms">
    <h3>Terms</h3>
    <table class="help-table">
      <tr><th scope="row">Pass rate</th><td>Passes out of judged attempts (passes, model and product failures). Infra failures and skipped attempts are left out.</td></tr>
      <tr><th scope="row">Smoke check</th><td>The basic scenario runs first; models that do not pass it skip the other scenarios.</td></tr>
      <tr><th scope="row">Tokens per pass</th><td>All tokens divided by passes, so failures add to it.</td></tr>
      <tr><th scope="row">Picker choice</th><td>The Smart Window model picker setting used to select the model.</td></tr>
    </table>
  </section>
</dialog>
<div id="explain" class="explain" popover>
  <strong class="explain-title"></strong>
  <p class="explain-body"></p>
  <a href="#" class="explain-more">More in How to read</a>
</div>
<script>
(() => {
  const drawer = document.getElementById("help");
  const narrow = window.matchMedia("(max-width: 720px)");
  const setOpen = open => document.body.classList.toggle("help-open", open && !narrow.matches);
  const openHelp = section => {
    if (!drawer.open) {
      if (narrow.matches) {
        drawer.showModal();
      } else {
        drawer.show();
      }
      setOpen(true);
    }
    const target = section && document.getElementById(section);
    if (target) {
      target.scrollIntoView({ block: "start" });
    }
  };
  drawer.addEventListener("close", () => setOpen(false));
  document.getElementById("help-open").addEventListener("click", () => {
    if (drawer.open) {
      drawer.close();
    } else {
      openHelp();
    }
  });
  drawer.querySelector(".help-close").addEventListener("click", () => drawer.close());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && drawer.open) {
      drawer.close();
    }
  });

  const explain = document.getElementById("explain");
  const more = explain.querySelector(".explain-more");
  document.addEventListener("click", event => {
    const pill = event.target.closest("[data-explain]");
    if (!pill || drawer.contains(pill)) {
      return;
    }
    explain.querySelector(".explain-title").textContent = pill.dataset.explainTitle;
    explain.querySelector(".explain-body").textContent = pill.dataset.explain;
    more.dataset.helpSection = pill.dataset.helpSection || "";
    explain.showPopover();
    const rect = pill.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - explain.offsetWidth - 8);
    const below = rect.bottom + 6;
    const top = below + explain.offsetHeight > window.innerHeight
      ? rect.top - explain.offsetHeight - 6
      : below;
    explain.style.left = Math.max(8, left) + "px";
    explain.style.top = Math.max(8, top) + "px";
  });
  more.addEventListener("click", event => {
    event.preventDefault();
    explain.hidePopover();
    openHelp(more.dataset.helpSection);
  });
})();
</script>`;

function budgetBanner(report) {
  const skipped = report.attempts.filter(a => a.result === "budget").length;
  const { limit, used } = report.tokenBudget ?? {};
  if (!skipped && !(limit && used >= limit)) {
    return "";
  }
  return `<div class="banner" role="alert">
    <strong>Token budget reached.</strong>
    The run used ${formatTokens(used)} of its ${formatTokens(limit)} token budget.
    ${
      skipped
        ? `${skipped} of ${report.attempts.length} attempts here were not run (result <code>budget</code>) and are left out of pass rates.`
        : "Every attempt here ran, but later attempts in this run may have been skipped."
    }
    Raise <code>SMARTWINDOW_E2E_TOKEN_BUDGET</code> to run them.
  </div>`;
}

function smokeCheckBanner(report, summaries) {
  const skipped = summaries.filter(s => s.smokeCheck);
  if (!skipped.length) {
    return "";
  }
  return `<div class="note">
    <strong>Smoke check not passed.</strong>
    ${skipped.map(s => escapeHTML(s.model)).join(", ")} did not pass the smoke check scenario, so
    ${skipped.reduce((n, s) => n + s.smokeCheck, 0)} of ${report.attempts.length} attempts here were not run
    (result <code>smoke-check</code>) and are left out of pass rates.
  </div>`;
}

/**
 * Writes the detailed report for one scenario.
 *
 * @param {object} report
 * @param {string} report.id - Scenario id, used in the file names.
 * @param {string} report.title
 * @param {string} report.instruction
 * @param {string} report.tier - "basic" (the smoke check) or "advanced".
 * @param {Array<{title: string, url: string}>} report.openTabs
 * @param {string[]} report.expectedUrls
 * @param {string[]} report.optionalUrls
 * @param {number} report.attemptsPerModel
 * @param {number} report.passRateGate - Between 0 and 1.
 * @param {{limit: number, used: number}} report.tokenBudget
 * @param {Map<string, string>} report.modelNames - Model name per choice.
 * @param {object[]} report.attempts - One outcome per attempt.
 * @param {string} [report.judgeScriptFile] - See judgeResultsScript().
 * @returns {Promise<{path: string, summaries: object[]}>}
 */
export async function writeScenarioReport(report) {
  const dir = await reportDir();
  const baseName = `smartwindow-e2e-${report.id}-${timestamp()}`;
  const modelName = a =>
    a.model ||
    report.modelNames.get(a.modelChoice) ||
    `model choice ${a.modelChoice}`;
  const summaries = summarizeScenario(
    report.attempts,
    report.attemptsPerModel,
    report.passRateGate,
    report.modelNames
  );
  const verdictByChoice = new Map(
    summaries.map(s => [s.modelChoice, s.verdict])
  );

  const cards = summaries
    .map(
      s => `<div class="card model-card" ${modelStyle(s.modelChoice)}>
        <h3 class="model-dot">${escapeHTML(s.model)}</h3>
        ${verdictBadge(s.verdict)}
        <div class="rate">${percent(s.passRate)}</div>
        <div>${s.passes}/${s.judged} judged attempts passed</div>
        <div class="muted">${failureMix(s)}</div>
        <div class="muted">${s.tokensPerPass === null ? "no passes" : `${formatTokens(s.tokensPerPass)} tokens per pass`}</div>
        <div>Quality (judge): ${judgePending(`data-judge-model="${escapeHTML(s.modelChoice)}" data-judge-scenario="${escapeHTML(report.id)}" data-judge-dims="${judgeOf(report).summary}"`)}</div>
        ${cardIssue(s)}
      </div>`
    )
    .join("");

  const summaryRows = summaries
    .map(
      s => `<tr class="model-row" ${modelStyle(s.modelChoice)}>
        <th scope="row"><code class="model-dot">${escapeHTML(s.model)}</code></th>
        <td data-label="Verdict">${verdictBadge(s.verdict)}</td>
        <td data-label="Pass rate">${percent(s.passRate)} (${s.passes}/${s.judged})</td>
        <td data-label="Failures">${failureMix(s)}</td>
        <td data-label="Not run">${s.budget} budget · ${s.smokeCheck} smoke check</td>
        <td data-label="Tokens per pass">${s.tokensPerPass === null ? "n/a" : formatTokens(s.tokensPerPass)}</td>
      </tr>`
    )
    .join("");
  const moreMetricsRows = summaries
    .map(
      s => `<tr>
        <th scope="row"><code>${escapeHTML(s.model)}</code></th>
        <td data-label="Picker choice">${escapeHTML(s.modelChoice)}</td>
        <td data-label="Confirmation / direct">${s.confirmationPath} / ${s.directPath}</td>
        <td data-label="Median turn">${s.medianSeconds === null ? "n/a" : `${s.medianSeconds.toFixed(1)}s`}</td>
        <td data-label="Rate-limit retries">${s.rateLimitRetries}</td>
        <td data-label="Tokens in / out">${formatTokens(s.tokens.input)} / ${formatTokens(s.tokens.output)} (${formatTokens(s.tokens.cached)} cached)</td>
        <td data-label="Tokens per attempt">${formatTokens(s.tokensPerAttempt)}</td>
      </tr>`
    )
    .join("");

  const usageCell = a => {
    if (!a.usage) {
      return "";
    }
    if (!a.usage.reported) {
      return "not reported";
    }
    return `${formatTokens(a.usage.input)} / ${formatTokens(a.usage.output)}${
      a.usage.cached ? ` (${formatTokens(a.usage.cached)} cached)` : ""
    }`;
  };
  const roundsText = a =>
    a.usage?.rounds.length
      ? a.usage.rounds
          .map(
            (r, i) =>
              `round ${i + 1}: ${formatTokens(r.input)} / ${formatTokens(r.output)} / ${formatTokens(r.cached)}`
          )
          .join("; ")
      : "none";

  // Attempts run round-robin across models; list them grouped by model.
  const sortedAttempts = [...report.attempts].sort(
    (a, b) =>
      a.modelChoice.localeCompare(b.modelChoice) || a.attempt - b.attempt
  );
  const attemptRows = sortedAttempts
    .map(a => {
      const toolCalls =
        a.toolCalls.map(c => c.function?.name).join(" → ") || "none";
      const id = escapeHTML(judgeId(report.id, a.modelChoice, a.attempt));
      const judged = JUDGED_RESULTS.includes(a.result);
      return `<tr class="result-${a.result}" ${modelStyle(a.modelChoice)} data-model="${escapeHTML(a.modelChoice)}"
          data-result="${escapeHTML(a.result)}" data-verdict="${verdictByChoice.get(a.modelChoice)?.key ?? ""}">
        <td class="attempt-model" data-sort="${a.modelChoice}-${String(a.attempt).padStart(4, "0")}"><code class="model-dot">${escapeHTML(modelName(a))}</code></td>
        <td class="attempt-number" data-sort="${a.attempt}">${a.attempt}</td>
        <td class="attempt-result ${a.result === "pass" ? "pass" : "fail"}">${escapeHTML(a.result)}</td>
        <td class="attempt-reason">${escapeHTML(a.reason)}</td>
        <td data-label="Tokens in / out" data-sort="${a.usage?.total ?? 0}">${usageCell(a)}</td>
        <td data-label="Judge">${judged ? judgePending(`data-judge-id="${id}" data-judge-dims="${judgeOf(report).dimensions.join(",")}"`) : '<span class="muted">not judged</span>'}</td>
        <td data-col="toolcalls">${escapeHTML(toolCalls)}</td>
        <td data-col="path">${escapeHTML(a.path ?? "")}</td>
        <td data-col="label">${escapeHTML(a.groups?.[0]?.label ?? "")}</td>
        <td data-col="turn" data-sort="${a.durationMs}">${(a.durationMs / 1000).toFixed(1)}s</td>
        <td data-col="retries" data-sort="${a.retries ?? 0}">${a.retries ?? 0}</td>
        <td>
          <details>
            <summary>details</summary>
            <p><strong>Tool calls:</strong> ${escapeHTML(toolCalls)}</p>
            <p><strong>Path:</strong> ${escapeHTML(a.path ?? "n/a")}
              · <strong>Group label:</strong> ${escapeHTML(a.groups?.[0]?.label ?? "n/a")}
              · <strong>Turn:</strong> ${(a.durationMs / 1000).toFixed(1)}s
              · <strong>Rate-limit retries:</strong> ${a.retries ?? 0}</p>
            <p><strong>Reply:</strong> ${escapeHTML(a.reply || "(empty)")}</p>
            <p><strong>Judge:</strong> ${judged ? judgePending(`data-judge-reason="${id}"`) : "not judged"}</p>
            <p><strong>Tokens per model round (input / output / cached):</strong> ${roundsText(a)}${
              a.usage?.retryTokens
                ? `, including ${formatTokens(a.usage.retryTokens)} from rate-limited tries`
                : ""
            }</p>
            <p><strong>Raw tool calls:</strong></p>
            <pre>${escapeHTML(JSON.stringify(a.toolCalls, null, 2))}</pre>
            <p><strong>Tab groups after the turn:</strong></p>
            <pre>${escapeHTML(JSON.stringify(a.groups ?? [], null, 2))}</pre>
          </details>
        </td>
      </tr>`;
    })
    .join("");

  const modelOptions = [
    ...new Map(sortedAttempts.map(a => [a.modelChoice, modelName(a)])),
  ]
    .map(
      ([choice, name]) =>
        `<option value="${escapeHTML(choice)}">${escapeHTML(name)}</option>`
    )
    .join("");
  const verdictOptions = Object.entries(VERDICTS)
    .map(
      ([key, label]) => `<option value="${key}">${escapeHTML(label)}</option>`
    )
    .join("");

  // Catalog tabs are matched by their id, which survives URL normalization.
  const expectedKeys = new Set(report.expectedUrls.map(catalogIdForUrl));
  const optionalKeys = new Set(
    (report.optionalUrls ?? []).map(catalogIdForUrl)
  );
  const tabsList = report.openTabs
    .map(tab => {
      let note = "";
      if (expectedKeys.has(catalogIdForUrl(tab.url))) {
        note = " <em>(expected in group)</em>";
      } else if (optionalKeys.has(catalogIdForUrl(tab.url))) {
        note = " <em>(optional: may be grouped)</em>";
      }
      return `<li>${escapeHTML(tab.title)}${note}</li>`;
    })
    .join("");
  const scenarioTokens = tokenTotals(report.attempts);
  const tierText =
    report.tier === "basic"
      ? "Smoke check: runs first; models that do not pass it skip the other scenarios"
      : "Advanced: runs only for models that passed the smoke check";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(report.title)}</title>
<style>${STYLES}</style>
${judgeScriptTag(report.judgeScriptFile)}
</head>
<body>
${HELP_BUTTON}
<h1>${escapeHTML(report.title)}</h1>
<p class="subtitle">"${escapeHTML(report.instruction)}" · ${report.openTabs.length} tabs · ${escapeHTML(tierText)}</p>
${smokeCheckBanner(report, summaries)}
${budgetBanner(report)}
<div class="cards">${cards}</div>

<h2 class="desktop-only">Summary by model</h2>
<table class="stack desktop-only">
  <thead><tr><th>Model</th><th>Verdict</th><th>Pass rate</th><th>Failures</th><th>Not run</th><th>Tokens per pass</th></tr></thead>
  <tbody>${summaryRows}</tbody>
</table>
<details>
  <summary>More metrics</summary>
  <table class="stack">
    <thead><tr><th>Model</th><th title="Smart Window model picker setting, browser.smartwindow.firstrun.modelChoice">Picker choice</th>
        <th>Confirmation / direct</th><th>Median turn</th><th>Rate-limit retries</th><th>Tokens in / out</th><th>Tokens per attempt</th></tr></thead>
    <tbody>${moreMetricsRows}</tbody>
  </table>
</details>
<details>
  <summary>Scenario details</summary>
  <dl>
    <dt>Instruction</dt><dd>${escapeHTML(report.instruction)}</dd>
    <dt>Open tabs</dt><dd><ul>${tabsList}</ul></dd>
    <dt>Pass condition</dt><dd>${
      report.optionalUrls?.length
        ? "Exactly one tab group containing every expected tab, any of the optional tabs and nothing else."
        : "Exactly one tab group containing exactly the expected tabs."
    } Label and confirmation choice are ignored.</dd>
    <dt>Tier</dt><dd>${escapeHTML(tierText)}</dd>
    <dt>Attempts per model</dt><dd>${report.attemptsPerModel}</dd>
    <dt>Verdict gate</dt><dd>Healthy at a pass rate of ${percent(report.passRateGate)} or more with no browser failures.</dd>
    <dt>Tokens (this scenario)</dt><dd>${formatTokens(scenarioTokens.input)} input / ${formatTokens(scenarioTokens.output)} output (${formatTokens(scenarioTokens.cached)} cached), chat model only</dd>
    <dt>Token budget</dt><dd>${
      report.tokenBudget?.limit
        ? `${formatTokens(report.tokenBudget.used)} of ${formatTokens(report.tokenBudget.limit)} tokens used by the run so far`
        : "No budget set"
    }</dd>
    <dt>Firefox build</dt><dd>${escapeHTML(Services.appinfo.version)} (${escapeHTML(Services.appinfo.appBuildID)})</dd>
    <dt>Generated</dt><dd>${escapeHTML(new Date().toISOString())}</dd>
  </dl>
</details>

<h2 id="all-attempts">All attempts</h2>
<div class="controls">
  <label>Model <select id="filter-model"><option value="">All</option>${modelOptions}</select></label>
  <label>Result <select id="filter-result">
    <option value="">All</option><option>pass</option><option>model</option><option>product</option>
    <option>infra</option><option>budget</option><option>smoke-check</option>
  </select></label>
  <label>Verdict <select id="filter-verdict"><option value="">All</option>${verdictOptions}</select></label>
  <label><input type="checkbox" id="filter-failures"> Failures only</label>
  <span id="filter-count"></span>
</div>
<div class="controls" id="column-chooser">
  Columns:
  <label><input type="checkbox" value="toolcalls"> Tool calls</label>
  <label><input type="checkbox" value="path"> Path</label>
  <label><input type="checkbox" value="label"> Group label</label>
  <label><input type="checkbox" value="turn"> Turn</label>
  <label><input type="checkbox" value="retries"> Retries</label>
</div>
<div class="scroll">
<table id="attempts">
  <thead>
    <tr><th data-sortable>Model</th><th data-sortable>#</th><th data-sortable>Result</th>
        <th data-sortable>Reason</th><th data-sortable>Tokens in / out</th>
        <th data-sortable title="LLM judge scores, 1 to 10">Judge</th>
        <th data-sortable data-col="toolcalls">Tool calls</th><th data-sortable data-col="path">Path</th>
        <th data-sortable data-col="label">Group label</th><th data-sortable data-col="turn">Turn</th>
        <th data-sortable data-col="retries">Retries</th><th></th></tr>
  </thead>
  <tbody>
  ${attemptRows}
  </tbody>
</table>
</div>
<script>
  const table = document.getElementById("attempts");
  const tbody = table.tBodies[0];
  const filters = {
    model: document.getElementById("filter-model"),
    result: document.getElementById("filter-result"),
    verdict: document.getElementById("filter-verdict"),
    failures: document.getElementById("filter-failures"),
  };
  const count = document.getElementById("filter-count");
  const FAILURES = ${JSON.stringify(FAILURE_RESULTS)};

  function applyFilters() {
    let shown = 0;
    for (const row of tbody.rows) {
      row.hidden =
        (filters.model.value && row.dataset.model !== filters.model.value) ||
        (filters.result.value && row.dataset.result !== filters.result.value) ||
        (filters.verdict.value && row.dataset.verdict !== filters.verdict.value) ||
        (filters.failures.checked && !FAILURES.includes(row.dataset.result));
      shown += row.hidden ? 0 : 1;
    }
    count.textContent = shown + " of " + tbody.rows.length + " attempts";
  }
  for (const control of Object.values(filters)) {
    control.addEventListener("change", applyFilters);
  }
  // The roll-up links here with #model=<picker choice>&failures=1.
  const linked = new URLSearchParams(location.hash.slice(1));
  if (linked.has("model")) {
    filters.model.value = linked.get("model");
  }
  filters.failures.checked ||= linked.get("failures") === "1";
  applyFilters();
  if (linked.size) {
    document.getElementById("all-attempts").scrollIntoView();
  }

  const COLUMNS_KEY = "smartwindow-e2e-columns";
  let shownColumns = [];
  try {
    shownColumns = JSON.parse(localStorage.getItem(COLUMNS_KEY)) ?? [];
  } catch (e) {}
  for (const box of document.querySelectorAll("#column-chooser input")) {
    box.checked = shownColumns.includes(box.value);
    table.classList.toggle("show-" + box.value, box.checked);
    box.addEventListener("change", () => {
      table.classList.toggle("show-" + box.value, box.checked);
      const selected = [...document.querySelectorAll("#column-chooser input:checked")].map(b => b.value);
      try {
        localStorage.setItem(COLUMNS_KEY, JSON.stringify(selected));
      } catch (e) {}
    });
  }

  const headers = [...table.tHead.rows[0].cells];
  headers.forEach((th, index) => {
    if (!th.hasAttribute("data-sortable")) {
      return;
    }
    th.addEventListener("click", () => {
      const ascending = th.getAttribute("aria-sort") !== "ascending";
      headers.forEach(h => h.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", ascending ? "ascending" : "descending");
      const key = row => row.cells[index].dataset.sort ?? row.cells[index].textContent.trim();
      const rows = [...tbody.rows].sort((a, b) => {
        const x = key(a);
        const y = key(b);
        const bothNumbers = x !== "" && y !== "" && !isNaN(x) && !isNaN(y);
        const order = bothNumbers ? Number(x) - Number(y) : x.localeCompare(y);
        return ascending ? order : -order;
      });
      tbody.append(...rows);
    });
  });
</script>
${HELP}
${judgeDataTag([report])}
${JUDGE_FILLER}
</body>
</html>
`;

  const path = PathUtils.join(dir, `${baseName}.html`);
  await IOUtils.writeUTF8(path, html);
  await IOUtils.writeJSON(PathUtils.join(dir, `${baseName}.json`), {
    ...report,
    modelNames: Object.fromEntries(report.modelNames),
    summaries,
  });
  return { path, summaries };
}

const VERDICT_PRECEDENCE = [
  "investigate-browser",
  "investigate-model",
  "inconclusive",
];

/**
 * Combines one model's scenario verdicts into an overall verdict: the most
 * serious "Investigate" or "Inconclusive" wins; "Healthy" needs every
 * scenario to have run and be healthy. The detail is a short count, since the
 * roll-up already shows each scenario's verdict.
 *
 * @param {Array<{scenario: string, verdict: object}>} results
 * @param {number} passRateGate
 * @returns {{key: string, label: string, detail: string}}
 */
export function overallVerdict(results, passRateGate) {
  const verdict = (key, detail) => ({ key, label: VERDICTS[key], detail });
  const total = results.length;
  const countOf = key => results.filter(r => r.verdict.key === key).length;
  const notRun = countOf("not-run");
  const notRunNote = notRun ? `; ${notRun} not run` : "";
  const scenarios = n => `${n} of ${total} scenario${total === 1 ? "" : "s"}`;
  const details = {
    "investigate-browser": n => `browser failures in ${scenarios(n)}`,
    "investigate-model": n => `${scenarios(n)} under ${percent(passRateGate)}`,
    inconclusive: n => `${scenarios(n)} inconclusive`,
  };
  for (const key of VERDICT_PRECEDENCE) {
    const n = countOf(key);
    if (n) {
      return verdict(key, details[key](n) + notRunNote);
    }
  }
  if (notRun === total) {
    return verdict(
      "not-run",
      results[0]?.verdict.detail ?? "every scenario was skipped"
    );
  }
  if (notRun) {
    return verdict("inconclusive", `${scenarios(notRun)} not run`);
  }
  return verdict("healthy", "");
}

/**
 * The one-sentence answer at the top of the roll-up.
 *
 * @param {object[]} models - Per-model roll-up entries.
 * @param {number} productFailures - Browser failures across the run.
 * @returns {{key: string, label: string, text: string}}
 */
function rollupHeadline(models, productFailures) {
  const flagged = models.filter(m => m.verdict.key.startsWith("investigate"));
  const unjudged = models.filter(m =>
    ["inconclusive", "not-run"].includes(m.verdict.key)
  );
  const defaultModel = models.find(m => m.isDefault);
  const ofModels = (group, verb) =>
    `${group.length} of ${models.length} models ${verb}${
      group.includes(defaultModel) ? ", including the default model" : ""
    }.`;
  let key = "healthy";
  if (productFailures) {
    key = "investigate-browser";
  } else if (flagged.length) {
    key = "investigate-model";
  } else if (unjudged.length) {
    key = "inconclusive";
  }
  const sentences = [];
  if (productFailures) {
    sentences.push(
      `Firefox did not do what the model asked in ${productFailures} attempt${productFailures === 1 ? "" : "s"}; see the hot spots below.`
    );
  }
  if (flagged.length) {
    sentences.push(ofModels(flagged, "need attention"));
  }
  if (unjudged.length) {
    sentences.push(ofModels(unjudged, "could not be judged"));
  }
  if (key === "healthy") {
    sentences.push(`All ${models.length} models passed every scenario.`);
  } else if (defaultModel?.verdict.key === "healthy") {
    sentences.push("The default model is healthy.");
  }
  return { key, label: VERDICTS[key], text: sentences.join(" ") };
}

/**
 * Writes the one-page roll-up for a run: a headline, a verdict per model, a
 * scenarios by models matrix and the scenarios with the most failures.
 *
 * @param {object} rollup
 * @param {Array<{id: string, title: string, tier: string, reportPath: string,
 *   attemptsPerModel: number, attempts: object[]}>} rollup.scenarios
 * @param {string[]} rollup.modelChoices
 * @param {Map<string, string>} rollup.modelNames
 * @param {string} rollup.defaultModelChoice - The model users get by default.
 * @param {number} rollup.passRateGate
 * @param {{limit: number, used: number}} rollup.tokenBudget
 * @param {string} [rollup.judgeScriptFile] - See judgeResultsScript().
 * @param {string} [rollup.runStamp] - From runStamp(); the same stamp
 *   overwrites the same roll-up.
 * @param {number} [rollup.scenariosPlanned] - Shows a partial run banner
 *   while fewer scenarios than this have finished.
 * @param {string} [rollup.feature] - What the scenarios test, shown under
 *   the title, e.g. "Tab grouping".
 * @returns {Promise<string>} The path of the HTML roll-up.
 */
export async function writeRollupReport(rollup) {
  const dir = await reportDir();
  const baseName = `smartwindow-e2e-rollup-${rollup.runStamp ?? timestamp()}`;
  const finished = rollup.scenarios.length;
  const partial = finished < (rollup.scenariosPlanned ?? finished);
  const scenarioSummaries = rollup.scenarios.map(scenario => ({
    scenario,
    summaries: summarizeScenario(
      scenario.attempts,
      scenario.attemptsPerModel,
      rollup.passRateGate,
      rollup.modelNames
    ),
  }));

  const models = rollup.modelChoices.map(modelChoice => {
    const perScenario = scenarioSummaries.map(({ scenario, summaries }) => ({
      scenario: scenario.id,
      tier: scenario.tier,
      summary: summaries.find(s => s.modelChoice === modelChoice),
    }));
    const present = perScenario.filter(p => p.summary);
    const passes = present.reduce((n, p) => n + p.summary.passes, 0);
    const judged = present.reduce((n, p) => n + p.summary.judged, 0);
    const smoke = present.find(p => p.tier === "basic")?.summary;
    return {
      modelChoice,
      model:
        rollup.modelNames.get(modelChoice) || `model choice ${modelChoice}`,
      isDefault: modelChoice === rollup.defaultModelChoice,
      smokeCheck: smoke
        ? {
            passes: smoke.passes,
            attempts: smoke.attempts,
            verdict: smoke.verdict,
          }
        : null,
      perScenario,
      passes,
      judged,
      passRate: judged ? passes / judged : null,
      verdict: overallVerdict(
        present.map(p => ({
          scenario: p.scenario,
          verdict: p.summary.verdict,
        })),
        rollup.passRateGate
      ),
      topIssue: topIssue(
        rollup.scenarios.flatMap(s =>
          s.attempts.filter(a => a.modelChoice === modelChoice)
        )
      ),
    };
  });
  models.sort((a, b) => b.isDefault - a.isDefault);

  const hotSpots = scenarioSummaries
    .map(({ scenario, summaries }) => {
      const failures = scenario.attempts.filter(
        a => a.result === "model" || a.result === "product"
      );
      const judged = summaries.reduce((n, s) => n + s.judged, 0);
      const product = failures.filter(a => a.result === "product").length;
      return {
        scenario: scenario.id,
        title: scenario.title,
        reportFile: PathUtils.filename(scenario.reportPath),
        judged,
        failures: failures.length,
        failureRate: judged ? failures.length / judged : 0,
        product,
        mostlyKind: product > failures.length - product ? "browser" : "model",
        topReason: topIssue(failures)?.text ?? "",
        models: summaries
          .map(s => ({
            modelChoice: s.modelChoice,
            model: s.model,
            verdict: s.verdict,
            failures: s.modelFailures + s.productFailures,
            judged: s.judged,
            topReason:
              topIssue(failures.filter(a => a.modelChoice === s.modelChoice))
                ?.text ?? "",
          }))
          .filter(m => m.failures)
          .sort((a, b) => b.failures / b.judged - a.failures / a.judged),
      };
    })
    .filter(h => h.failures)
    .sort((a, b) => b.failureRate - a.failureRate);

  const allAttempts = rollup.scenarios.flatMap(s => s.attempts);
  const countAll = result =>
    allAttempts.filter(a => a.result === result).length;
  const health = {
    tokensUsed: rollup.tokenBudget?.used ?? 0,
    tokenLimit: rollup.tokenBudget?.limit ?? 0,
    budgetSkipped: countAll("budget"),
    smokeCheckSkipped: countAll("smoke-check"),
    productFailures: countAll("product"),
    infraFailures: countAll("infra"),
    rateLimitRetries: allAttempts.reduce((n, a) => n + (a.retries ?? 0), 0),
  };
  const headline = rollupHeadline(models, health.productFailures);

  // Scenarios are rows and models are columns, so adding scenarios grows the
  // table downwards; per-model totals are footer rows.
  const modelHeaders = models
    .map(
      m =>
        `<th class="model-head" ${modelStyle(m.modelChoice)}><code class="model-dot">${escapeHTML(m.model)}</code>${m.isDefault ? '<span class="tag">default</span>' : ""}</th>`
    )
    .join("");
  const matrixRows = rollup.scenarios
    .map((s, index) => {
      const cells = models
        .map(m => {
          const summary = m.perScenario[index].summary;
          const label = `data-label="${escapeHTML(m.model)}"`;
          if (!summary) {
            return `<td ${label} class="muted">not selected</td>`;
          }
          const judgeLine = summary.judged
            ? `<div class="rate-line">Judge: ${judgePending(`data-judge-model="${escapeHTML(m.modelChoice)}" data-judge-scenario="${escapeHTML(s.id)}" data-judge-dims="${judgeOf(s).summary}" data-judge-compact`)}</div>`
            : "";
          return `<td ${label} class="${cellTint(summary.verdict)}">${verdictBadge(summary.verdict)}
            <div class="rate-line">${percent(summary.passRate)} · ${summary.passes}/${summary.judged}</div>${judgeLine}</td>`;
        })
        .join("");
      return `<tr>
        <th scope="row"><a href="${escapeHTML(PathUtils.filename(s.reportPath))}">${escapeHTML(s.id)}</a>${
          s.tier === "basic" ? '<br><span class="muted">smoke check</span>' : ""
        }</th>
        ${cells}
      </tr>`;
    })
    .join("");
  const overallRow = `<tr class="overall-row"><th scope="row">Overall pass rate</th>${models
    .map(
      m =>
        `<td data-label="${escapeHTML(m.model)}">${percent(m.passRate)} · ${m.passes}/${m.judged}</td>`
    )
    .join("")}</tr>`;

  // On narrow screens the matrix becomes one collapsible block per scenario,
  // colored by its most serious verdict; blocks that need a look start open.
  const overallList = models
    .map(
      m =>
        `<li ${modelStyle(m.modelChoice)}><code class="model-dot">${escapeHTML(m.model)}</code> ${percent(m.passRate)} · ${m.passes}/${m.judged}</li>`
    )
    .join("");
  const scenarioBlocks = rollup.scenarios
    .map((s, index) => {
      const present = models.filter(m => m.perScenario[index].summary);
      const status = scenarioStatus(
        present.map(m => m.perScenario[index].summary.verdict)
      );
      const rows = present
        .map(m => {
          const summary = m.perScenario[index].summary;
          const judge = summary.judged
            ? `<div class="rate-line">Judge: ${judgePending(`data-judge-model="${escapeHTML(m.modelChoice)}" data-judge-scenario="${escapeHTML(s.id)}" data-judge-dims="${judgeOf(s).summary}" data-judge-compact`)}</div>`
            : "";
          return `<li ${modelStyle(m.modelChoice)}>
            <code class="model-dot">${escapeHTML(m.model)}</code>
            <div>${verdictBadge(summary.verdict)} <span class="rate-line">${percent(summary.passRate)} · ${summary.passes}/${summary.judged}</span></div>
            ${judge}
          </li>`;
        })
        .join("");
      return `<details class="scenario-block status-${status}"${status === "healthy" || status === "not-run" ? "" : " open"}>
        <summary><span class="scenario-name">${escapeHTML(s.id)}</span>${
          s.tier === "basic" ? ' <span class="muted">(smoke check)</span>' : ""
        } <span class="status-label">${STATUS_LABELS[status]}</span></summary>
        <ul class="scenario-models">${rows}</ul>
        <a class="touch" href="${escapeHTML(PathUtils.filename(s.reportPath))}">Open the scenario report</a>
      </details>`;
    })
    .join("");
  const modelRows = models
    .map(
      m => `<tr class="model-row" ${modelStyle(m.modelChoice)}>
        <th scope="row"><code class="model-dot">${escapeHTML(m.model)}</code>${m.isDefault ? '<span class="tag">default</span>' : ""}</th>
        <td data-label="Verdict">${verdictBadge(m.verdict)}${verdictNote(m.verdict)}</td>
        <td data-label="Passed">${m.passes}/${m.judged} · ${percent(m.passRate)}</td>
        <td data-label="Top issue">${m.topIssue ? escapeHTML(m.topIssue.text) : '<span class="muted">none</span>'}</td>
      </tr>`
    )
    .join("");
  const hotSpotModelRows = h =>
    h.models
      .map(
        m => `<tr class="model-row" ${modelStyle(m.modelChoice)}>
          <th scope="row"><code class="model-dot">${escapeHTML(m.model)}</code></th>
          <td data-label="Verdict">${verdictBadge(m.verdict)}</td>
          <td data-label="Failed">${m.failures}/${m.judged}</td>
          <td data-label="Top reason">${escapeHTML(m.topReason)}</td>
          <td><a class="touch" href="${escapeHTML(`${h.reportFile}#model=${encodeURIComponent(m.modelChoice)}&failures=1`)}">View failures</a></td>
        </tr>`
      )
      .join("");
  const hotSpotList = hotSpots.length
    ? hotSpots
        .map(
          (h, i) => `<details class="hot-spot"${i === 0 ? " open" : ""}>
            <summary>${escapeHTML(h.scenario)}<span class="hs-stats">${percent(h.failureRate)} failed (${h.failures}/${h.judged})
              · mostly ${h.mostlyKind === "browser" ? '<strong class="fail">browser</strong>' : "model"}</span></summary>
            <table class="stack">
              <thead><tr><th>Model</th><th>Verdict</th><th>Failed</th><th>Top reason</th><th></th></tr></thead>
              <tbody>${hotSpotModelRows(h)}</tbody>
            </table>
            <a class="touch" href="${escapeHTML(h.reportFile)}">Open the full report</a>
          </details>`
        )
        .join("")
    : `<p class="muted">No model or browser failures.</p>`;

  // Smoke check skips are the run working as designed; only budget skips
  // mean the run stopped early.
  let runStatus = "Run complete";
  if (health.budgetSkipped) {
    runStatus = `<strong class="fail">Stopped early</strong>: ${health.budgetSkipped} attempts skipped for budget`;
  } else if (partial) {
    runStatus = "Run not finished";
  }
  if (health.smokeCheckSkipped) {
    runStatus += ` · ${health.smokeCheckSkipped} attempts skipped by the smoke check`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smart Window AI Quality Report</title>
<style>${STYLES}</style>
${judgeScriptTag(rollup.judgeScriptFile)}
</head>
<body>
${HELP_BUTTON}
<h1>Smart Window AI Quality Report</h1>
<p class="subtitle"><strong>${escapeHTML(rollup.feature ?? "")}</strong> · ${rollup.scenariosPlanned ?? finished} scenarios · ${rollup.modelChoices.length} models<br>
  ${escapeHTML(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC · Firefox ${escapeHTML(Services.appinfo.version)}
  · ${formatTokens(health.tokensUsed)}${health.tokenLimit ? ` of ${formatTokens(health.tokenLimit)}` : ""} tokens<br>
  ${runStatus}
  · ${health.infraFailures} infra failures · ${health.rateLimitRetries} rate-limit retries</p>
${
  partial
    ? `<div class="banner" role="alert"><strong>Partial run: ${finished} of ${rollup.scenariosPlanned} scenarios finished.</strong>
    This roll-up is rewritten after each scenario. If the run has ended, it stopped early (for example a harness timeout), and the other scenarios did not run.</div>`
    : ""
}
<div class="headline headline-${headline.key}" role="status"><strong>${escapeHTML(headline.label)}.</strong> ${escapeHTML(headline.text)}</div>

<table class="models stack">
  <thead><tr><th>Model</th><th>Verdict</th><th>Passed</th><th>Top issue</th></tr></thead>
  <tbody>${modelRows}</tbody>
</table>

<h2>Hot spots: scenarios to check</h2>
${hotSpotList}

<h2>Scenarios by model</h2>
<table class="matrix matrix-wide">
  <thead><tr><th>Scenario</th>${modelHeaders}</tr></thead>
  <tbody>${overallRow}${matrixRows}</tbody>
</table>
<div class="matrix-narrow">
  <div class="overall-rates"><strong>Overall pass rate</strong><ul>${overallList}</ul></div>
  ${scenarioBlocks}
</div>
${HELP}
${judgeDataTag(rollup.scenarios)}
${JUDGE_FILLER}
</body>
</html>
`;

  const path = PathUtils.join(dir, `${baseName}.html`);
  await IOUtils.writeUTF8(path, html);
  await IOUtils.writeJSON(PathUtils.join(dir, `${baseName}.json`), {
    generated: new Date().toISOString(),
    firefox: {
      version: Services.appinfo.version,
      buildID: Services.appinfo.appBuildID,
    },
    passRateGate: rollup.passRateGate,
    scenariosFinished: finished,
    scenariosPlanned: rollup.scenariosPlanned ?? finished,
    headline,
    health,
    models: models.map(m => ({
      modelChoice: m.modelChoice,
      model: m.model,
      isDefault: m.isDefault,
      verdict: m.verdict,
      passRate: m.passRate,
      passes: m.passes,
      judged: m.judged,
      smokeCheck: m.smokeCheck,
      topIssue: m.topIssue,
      scenarios: m.perScenario
        .filter(p => p.summary)
        .map(p => ({
          scenario: p.scenario,
          verdict: p.summary.verdict,
          passRate: p.summary.passRate,
          passes: p.summary.passes,
          judged: p.summary.judged,
        })),
      quality: null,
    })),
    hotSpots,
    reports: rollup.scenarios.map(s => PathUtils.filename(s.reportPath)),
  });
  return path;
}
