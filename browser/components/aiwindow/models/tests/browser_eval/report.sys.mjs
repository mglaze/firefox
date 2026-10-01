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
import { MODES, MODE_LABELS } from "./scenarios.sys.mjs";

const FAILURE_RESULTS = ["model", "product", "infra"];

// Status categories, shown as the pill text. Each verdict also has a color:
// green (passing), yellow (borderline), red (failing) or gray (couldn't judge
// or not run).
export const VERDICTS = {
  healthy: "Healthy",
  "tool-use": "Tool use",
  "wrong-result": "Wrong result",
  firefox: "Firefox bug",
  service: "Service errors",
  "not-run": "Not run",
};

// Under the pass rate gate but at or above this pass rate is yellow; below it
// is red.
const WARNING_GATE = 0.6;

/**
 * @param {object} attempt
 * @returns {?string} The attempt's category (see VERDICTS), null for a pass.
 *   Attempts saved before the test recorded a category get one from their
 *   result and reason.
 */
function categoryOf(attempt) {
  if (attempt.category !== undefined) {
    return attempt.category;
  }
  switch (attempt.result) {
    case "pass":
      return null;
    case "product":
      return "firefox";
    case "infra":
      return "service";
    case "budget":
    case "smoke-check":
      return "not-run";
    default:
      return /^manage_tabs (was not called|did not produce)/.test(
        attempt.reason
      )
        ? "tool-use"
        : "wrong-result";
  }
}

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
 * Decides one model's verdict in one scenario: a color and a category.
 * - No attempt judged and no infra failure: gray "Not run".
 * - Any product failure: red "Firefox bug", whatever the pass rate.
 * - Fewer judged attempts than min(3, planned): gray "Service errors" (or
 *   "Not run" when nothing failed).
 * - Pass rate at or above the gate: green "Healthy"; at or above
 *   WARNING_GATE: yellow; below it: red. Yellow and red take the more common
 *   model failure category, "Tool use" or "Wrong result".
 *
 * Judged attempts are passes, model failures and product failures. Infra
 * failures and skipped attempts say nothing about the model or Firefox.
 *
 * @param {object} counts
 * @param {number} planned - Attempts planned per model.
 * @param {number} passRateGate - Between 0 and 1.
 * @param {object} [categoryCounts] - Model failures per category.
 * @returns {{key: string, color: string, label: string, detail: string}}
 */
export function computeVerdict(
  counts,
  planned,
  passRateGate,
  categoryCounts = {}
) {
  const {
    passes,
    modelFailures,
    productFailures: product,
    infraFailures: infra,
    budget,
    smokeCheck,
  } = counts;
  const judged = passes + modelFailures + product;
  const verdict = (key, color, detail = "") => ({
    key,
    color,
    label: VERDICTS[key],
    detail,
  });

  if (!judged && !infra) {
    const reasons = [];
    if (smokeCheck) {
      reasons.push("did not pass the smoke check");
    }
    if (budget) {
      reasons.push("token budget reached");
    }
    return verdict("not-run", "gray", reasons.join("; "));
  }
  if (product) {
    return verdict(
      "firefox",
      "red",
      `${product} attempt(s) where Firefox did not do what the model asked`
    );
  }
  if (judged < Math.min(3, planned)) {
    return infra
      ? verdict(
          "service",
          "gray",
          `${infra} service error(s) left ${judged} judged attempt(s)`
        )
      : verdict("not-run", "gray", `only ${judged} attempt(s) ran`);
  }
  const passRate = passes / judged;
  if (passRate >= passRateGate) {
    return verdict("healthy", "green");
  }
  const category =
    (categoryCounts["tool-use"] ?? 0) > (categoryCounts["wrong-result"] ?? 0)
      ? "tool-use"
      : "wrong-result";
  return verdict(
    category,
    passRate >= WARNING_GATE ? "yellow" : "red",
    `${percent(passRate)} passed`
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
  const categories = {};
  for (const attempt of attempts) {
    const category = categoryOf(attempt);
    if (category) {
      categories[category] = (categories[category] ?? 0) + 1;
    }
  }
  const tokens = tokenTotals(attempts);
  const ran = attempts.length - counts.budget - counts.smokeCheck;
  return {
    modelChoice: attempts[0].modelChoice,
    model: name,
    attempts: attempts.length,
    ...counts,
    judged,
    passRate: judged ? counts.passes / judged : null,
    categories,
    verdict: computeVerdict(counts, planned, passRateGate, categories),
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

// What each category means and who to notify; shown when a pill is tapped
// and in the help drawer.
const VERDICT_HELP = {
  healthy: {
    meaning: "80% or more of attempts passed, with no Firefox bugs.",
    notify: "Nobody",
  },
  "tool-use": {
    meaning:
      "The model didn't use the tools correctly: it didn't call the tool, or called it in a way Firefox couldn't act on.",
    notify: "Models / prompt team",
  },
  "wrong-result": {
    meaning:
      "The model used the tools, but the result was wrong: it grouped tabs it shouldn't have, or missed tabs it should have grouped.",
    notify: "Models team",
  },
  firefox: {
    meaning: "Firefox didn't do what the model asked, at least once.",
    notify: "Smart Window front end",
  },
  service: {
    meaning:
      "Too few attempts could be judged because of MLPA, auth or network errors.",
    notify: "MLPA owners, if it keeps happening",
  },
  "not-run": {
    meaning: "Every attempt was skipped (token budget or smoke check).",
    notify: "Nobody; rerun if needed",
  },
};

const COLOR_HELP = {
  green: { label: "Passing", when: "80% or more passed, and no Firefox bugs" },
  yellow: { label: "Borderline", when: "60 to 79% passed" },
  red: { label: "Failing", when: "Under 60% passed, or any Firefox bug" },
  gray: { label: "No result", when: "Service errors, or not run" },
};

const verdictBadge = verdict => {
  const { meaning, notify } = VERDICT_HELP[verdict.key];
  const color = COLOR_HELP[verdict.color];
  const explanation = `${color.label}: ${color.when}. ${meaning}${verdict.detail ? ` Here: ${verdict.detail}.` : ""} Notify: ${notify}.`;
  return `<button type="button" class="verdict verdict-${verdict.color}" data-explain-title="${escapeHTML(verdict.label)}"
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

const COLOR_ORDER = ["red", "yellow", "green", "gray"];

const scenarioCountsText = counts =>
  [
    `${counts.passed} passed`,
    `${counts.failed} failed`,
    counts.notRun ? `${counts.notRun} not run` : "",
    counts.unjudged ? `${counts.unjudged} couldn't be judged` : "",
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * @param {object[]} verdicts - One scenario's verdicts across models.
 * @returns {string} The most serious color, used to color the scenario.
 */
function scenarioStatus(verdicts) {
  return (
    COLOR_ORDER.find(color => verdicts.some(v => v.color === color)) ?? "gray"
  );
}

const STATUS_LABELS = {
  red: "Needs investigation",
  yellow: "Borderline",
  green: "Healthy",
  gray: "Not run",
};

const cellTint = verdict => `cell-${verdict.color}`;

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
  .verdict-green { background: #d7f5e3; color: #01532b; }
  .verdict-yellow { background: #fff4de; color: #7a4a00; }
  .verdict-red { background: #ffe1e6; color: #8f0030; }
  .verdict-gray { background: #f0f0f4; color: #5b5b66; }
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
  .explain-rows { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; margin: 8px 0 10px; }
  .explain-rows dt { font-weight: normal; color: #5b5b66; }
  .explain-rows dd { margin: 0; font-weight: 600; }
  .matrix tbody th, .matrix tfoot th { background: #f9f9fb; font-weight: 600; white-space: nowrap; }
  .matrix td { overflow-wrap: anywhere; }
  .card { border: 1px solid #cfcfd8; border-radius: 6px; padding: 12px 16px; min-width: 16em; }
  .card h3 { margin: 0 0 6px; font-size: 1em; }
  .card .rate { font-size: 1.6em; font-weight: 600; }
  .card { max-width: 28em; }
  .issue { margin-top: 6px; font-size: 0.93em; }
  .rate-line { font-size: 0.9em; color: #5b5b66; margin-top: 3px; }
  .matrix td.cell-green { background: #edfbf3; }
  .matrix td.cell-yellow { background: #fffaf0; }
  .matrix td.cell-red { background: #fff0f3; }
  .matrix td.cell-gray { background: #f9f9fb; }
  /* The whole cell links to the scenario report; the pill stays tappable. */
  .link-cell { position: relative; }
  .link-cell:hover { box-shadow: inset 0 0 0 2px #0061e0; }
  .cell-link { position: absolute; inset: 0; z-index: 1; font-size: 0; color: transparent; }
  .cell-link:focus-visible { outline: 2px solid #0061e0; outline-offset: -2px; }
  .link-cell button.verdict, .link-cell button.score { position: relative; z-index: 2; }
  .details-button { font: inherit; color: #0061e0; background: none; border: none; padding: 0; text-decoration: underline; cursor: pointer; }
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
  .scenario-block { border: 1px solid; border-inline-start-width: 6px; border-radius: 6px; padding: 4px 12px; margin: 0.6em 0; }
  .scenario-block.status-red { background: #fff0f3; border-color: #c50042; }
  .scenario-block.status-yellow { background: #fffaf0; border-color: #a86500; }
  .scenario-block.status-green { background: #edfbf3; border-color: #017a40; }
  .scenario-block.status-gray { background: #f9f9fb; border-color: #cfcfd8; }
  .scenario-block summary { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 0.25em 0.75em; }
  .scenario-block .hs-stats { margin: 0; text-align: end; }
  .scenario-block table { margin: 0.5em 0; background: #fff; }
  .scenario-block summary::before { content: "▸"; display: inline-block; transition: transform 0.15s; }
  .scenario-block[open] summary::before { transform: rotate(90deg); }
  .scenario-block .status-label { font-size: 0.85em; }
  .tag { display: inline-block; border: 1px solid #8f8f9d; border-radius: 4px; padding: 0 5px; font-size: 0.85em; font-weight: 600; margin-inline-start: 4px; }
  .headline { border: 1px solid; border-radius: 6px; padding: 12px 16px; margin: 1em 0; font-size: 1.1em; }
  .headline-green { background: #d7f5e3; border-color: #017a40; }
  .headline-yellow { background: #fff4de; border-color: #a86500; }
  .headline-red { background: #ffe1e6; border-color: #c50042; }
  .headline-gray { background: #f0f0f4; border-color: #8f8f9d; }
  .models th, .models td:nth-child(2), .models td:nth-child(3) { white-space: nowrap; }
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
    .scenario-block summary { grid-template-columns: auto minmax(0, 1fr) auto; }
    .scenario-block .hs-stats { grid-column: 2 / -1; grid-row: 2; text-align: start; font-size: 0.9em; }
    .scenario-block table.stack { background: none; }
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
      <tr><th scope="row">Model table</th><td>Each model's status, how many scenarios it passed, its pass rate over all judged attempts and its most common problem.</td></tr>
      <tr><th scope="row">Hot spots</th><td>Scenarios with the most failures and the models that failed them. "View failures" opens those attempts.</td></tr>
      <tr><th scope="row">Sidebar vs full page</th><td>Pass rates per model in each mode, over the scenarios run in both. Shown when a run covers both modes.</td></tr>
      <tr><th scope="row">Scenarios by model</th><td>Each scenario's status per model. Yellow and red cells add the pass rate and the judge's main score. Click a cell to open that scenario's report for the model.</td></tr>
      <tr><th scope="row">All attempts</th><td>Every attempt in a scenario report, with filters. "details" shows the tool calls, reply and tab groups.</td></tr>
    </table>
  </section>
  <section id="help-verdicts">
    <h3>Colors</h3>
    <table class="help-table">
      <thead><tr><th>Color</th><th>When</th></tr></thead>
      <tbody>
      ${Object.entries(COLOR_HELP)
        .map(
          ([color, { label, when }]) =>
            `<tr><th scope="row"><span class="verdict verdict-${color}">${label}</span></th><td>${when}.</td></tr>`
        )
        .join("")}
      </tbody>
    </table>
    <h3>Categories</h3>
    <p class="muted">Yellow and red pills name the main kind of failure.</p>
    <table class="help-table">
      <thead><tr><th>Category</th><th>Meaning</th><th>Notify</th></tr></thead>
      <tbody>
      ${Object.entries(VERDICT_HELP)
        .map(
          ([key, { meaning, notify }]) =>
            `<tr><th scope="row">${VERDICTS[key]}</th><td>${meaning}</td><td>${notify}</td></tr>`
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
  <dl class="explain-rows"></dl>
  <a href="#" class="explain-more">More in How to read</a>
</div>
<script>
(() => {
  const drawer = document.getElementById("help");
  const narrow = window.matchMedia("(max-width: 720px)");
  if (narrow.matches) {
    for (const section of document.querySelectorAll("details[open]")) {
      section.open = false;
    }
  }
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
    const body = explain.querySelector(".explain-body");
    const rows = explain.querySelector(".explain-rows");
    body.textContent = pill.dataset.explainRows ? "" : pill.dataset.explain;
    rows.replaceChildren();
    if (pill.dataset.explainRows) {
      for (const [label, value] of JSON.parse(pill.dataset.explainRows)) {
        const term = document.createElement("dt");
        term.textContent = label;
        const detail = document.createElement("dd");
        detail.textContent = value;
        rows.append(term, detail);
      }
    }
    body.hidden = !body.textContent;
    rows.hidden = !rows.children.length;
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
<p class="subtitle">"${escapeHTML(report.instruction)}" · ${report.openTabs.length} tabs${
    report.mode ? ` · ${MODE_LABELS[report.mode]}` : ""
  } · ${escapeHTML(tierText)}</p>
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

/**
 * Combines one model's scenario verdicts: any red makes it red (a Firefox bug
 * wins the category), then yellow, then green. Gray only when no scenario
 * could be judged. The category is the most common one among the failing
 * scenarios.
 *
 * @param {Array<{scenario: string, verdict: object}>} results
 * @returns {{key: string, color: string, label: string, detail: string}}
 */
export function overallVerdict(results) {
  const verdict = (key, color, detail) => ({
    key,
    color,
    label: VERDICTS[key],
    detail,
  });
  const total = results.length;
  const scenarios = n => `${n} of ${total} scenario${total === 1 ? "" : "s"}`;
  const withColor = color => results.filter(r => r.verdict.color === color);
  const mostCommon = group => {
    const counts = new Map();
    for (const r of group) {
      counts.set(r.verdict.key, (counts.get(r.verdict.key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  const red = withColor("red");
  const yellow = withColor("yellow");
  if (red.length) {
    const key = red.some(r => r.verdict.key === "firefox")
      ? "firefox"
      : mostCommon(red);
    return verdict(
      key,
      "red",
      `${scenarios(red.length + yellow.length)} failing`
    );
  }
  if (yellow.length) {
    return verdict(
      mostCommon(yellow),
      "yellow",
      `${scenarios(yellow.length)} borderline`
    );
  }
  if (withColor("green").length) {
    return verdict("healthy", "green", "");
  }
  if (results.some(r => r.verdict.key === "service")) {
    return verdict("service", "gray", `${scenarios(total)} couldn't be judged`);
  }
  return verdict(
    "not-run",
    "gray",
    results[0]?.verdict.detail || "every scenario was skipped"
  );
}

/**
 * The one-sentence answer at the top of the roll-up.
 *
 * @param {object[]} models - Per-model roll-up entries.
 * @param {number} productFailures - Browser failures across the run.
 * @returns {{key: string, label: string, text: string, html: string}} `key`
 *   is a color; `html` is `text` with the model names in bold.
 */
function rollupHeadline(models, productFailures) {
  const attention = models.filter(m =>
    ["red", "yellow"].includes(m.verdict.color)
  );
  const unjudged = models.filter(m => m.verdict.color === "gray");
  let key = "green";
  if (attention.some(m => m.verdict.color === "red")) {
    key = "red";
  } else if (attention.length) {
    key = "yellow";
  } else if (unjudged.length === models.length) {
    key = "gray";
  }
  const labels = {
    green: "Healthy",
    yellow: "Borderline",
    red: "Needs attention",
    gray: "No result",
  };
  // `name` formats a model name, so the page can bold it and the JSON can't.
  const describe = name => {
    if (!attention.length) {
      return "";
    }
    return `${attention.length} of ${models.length} models need attention: ${attention
      .map(
        m =>
          `${name(m.model)}${m.isDefault ? " (default)" : ""}, ${m.verdict.label.toLowerCase()}`
      )
      .join("; ")}.`;
  };
  const sentences = [];
  if (productFailures) {
    sentences.push(
      `Firefox didn't do what the model asked in ${productFailures} attempt${productFailures === 1 ? "" : "s"}.`
    );
  }
  if (key === "green") {
    sentences.push(`All ${models.length} models passed.`);
  } else if (key === "gray") {
    sentences.push("No model could be judged; see Run details.");
  } else if (unjudged.length) {
    sentences.push(
      `${unjudged.length} more could not be judged or did not run.`
    );
  }
  const join = first => [first, ...sentences].filter(Boolean).join(" ");
  return {
    key,
    label: labels[key],
    text: join(describe(name => name)),
    html: join(describe(name => `<strong>${escapeHTML(name)}</strong>`)),
  };
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
 * @param {string[]} [rollup.modes] - Modes the run covers; with more than
 *   one, scenarios are tagged with their mode and compared across modes.
 * @param {string[]} [rollup.mergedFrom] - Run stamps a merged roll-up was
 *   built from, see merge_runs.mjs.
 * @returns {Promise<string>} The path of the HTML roll-up.
 */
export async function writeRollupReport(rollup) {
  const dir = await reportDir();
  const baseName = `smartwindow-e2e-rollup-${rollup.runStamp ?? timestamp()}`;
  // Each base scenario's modes sit next to each other.
  const baseOrder = [...new Set(rollup.scenarios.map(s => s.baseId ?? s.id))];
  const scenarios = [...rollup.scenarios].sort(
    (a, b) =>
      baseOrder.indexOf(a.baseId ?? a.id) -
        baseOrder.indexOf(b.baseId ?? b.id) ||
      MODES.indexOf(a.mode ?? "sidebar") - MODES.indexOf(b.mode ?? "sidebar")
  );
  const modes = rollup.modes ?? [
    ...new Set(scenarios.map(s => s.mode ?? "sidebar")),
  ];
  const modeTag = s =>
    modes.length > 1 && s.mode
      ? ` <span class="tag">${MODE_LABELS[s.mode]}</span>`
      : "";
  const finished = scenarios.length;
  const partial = finished < (rollup.scenariosPlanned ?? finished);
  const scenarioSummaries = scenarios.map(scenario => ({
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
    const colors = present.map(p => p.summary.verdict);
    const scenarioCounts = {
      passed: colors.filter(v => v.color === "green").length,
      failed: colors.filter(v => ["red", "yellow"].includes(v.color)).length,
      notRun: colors.filter(v => v.key === "not-run").length,
      unjudged: colors.filter(v => v.key === "service").length,
    };
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
      scenarioCounts,
      verdict: overallVerdict(
        present.map(p => ({
          scenario: p.scenario,
          verdict: p.summary.verdict,
        }))
      ),
      topIssue: topIssue(
        scenarios.flatMap(s =>
          s.attempts.filter(a => a.modelChoice === modelChoice)
        )
      ),
    };
  });
  models.sort((a, b) => b.isDefault - a.isDefault);

  const scenarioStats = scenarioSummaries.map(({ scenario, summaries }) => {
    const failures = scenario.attempts.filter(
      a => a.result === "model" || a.result === "product"
    );
    const judged = summaries.reduce((n, s) => n + s.judged, 0);
    const product = failures.filter(a => a.result === "product").length;
    return {
      scenario: scenario.id,
      baseId: scenario.baseId ?? scenario.id,
      mode: scenario.mode,
      tier: scenario.tier,
      title: scenario.title,
      status: scenarioStatus(summaries.map(s => s.verdict)),
      reportFile: PathUtils.filename(scenario.reportPath),
      judged,
      failures: failures.length,
      failureRate: judged ? failures.length / judged : 0,
      product,
      mostlyKind: product > failures.length - product ? "browser" : "model",
      topReason: topIssue(failures)?.text ?? "",
      models: summaries.map(s => ({
        modelChoice: s.modelChoice,
        model: s.model,
        verdict: s.verdict,
        failures: s.modelFailures + s.productFailures,
        judged: s.judged,
        topReason:
          topIssue(failures.filter(a => a.modelChoice === s.modelChoice))
            ?.text ?? "",
      })),
    };
  });
  const hotSpots = scenarioStats
    .filter(h => h.failures)
    .map(h => ({
      ...h,
      models: h.models
        .filter(m => m.failures)
        .sort((a, b) => b.failures / b.judged - a.failures / a.judged),
    }))
    .sort((a, b) => b.failureRate - a.failureRate);

  const allAttempts = scenarios.flatMap(s => s.attempts);
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
  // Green and gray cells show only the pill; yellow and red cells add the pass
  // rate and the judge's score. Each cell links to the scenario report,
  // filtered to that model (and to its failures when it isn't green).
  const needsLook = verdict => ["red", "yellow"].includes(verdict.color);
  const cellLink = (s, m, summary) => {
    const href = `${PathUtils.filename(s.reportPath)}#model=${encodeURIComponent(m.modelChoice)}${needsLook(summary.verdict) ? "&failures=1" : ""}`;
    return `<a class="cell-link" href="${escapeHTML(href)}">Open ${escapeHTML(s.id)} for ${escapeHTML(m.model)}</a>`;
  };
  const cellDetails = (s, m, summary) => {
    if (!needsLook(summary.verdict)) {
      return "";
    }
    const judge = summary.judged
      ? `<div class="rate-line">Judge: ${judgePending(`data-judge-model="${escapeHTML(m.modelChoice)}" data-judge-scenario="${escapeHTML(s.id)}" data-judge-dims="${judgeOf(s).summary}" data-judge-compact`)}</div>`
      : "";
    return `<div class="rate-line">${percent(summary.passRate)} · ${summary.passes}/${summary.judged}</div>${judge}`;
  };
  const matrixRows = scenarios
    .map((s, index) => {
      const cells = models
        .map(m => {
          const summary = m.perScenario[index].summary;
          const label = `data-label="${escapeHTML(m.model)}"`;
          if (!summary) {
            return `<td ${label} class="muted">not selected</td>`;
          }
          return `<td ${label} class="link-cell ${cellTint(summary.verdict)}">${cellLink(s, m, summary)}${verdictBadge(summary.verdict)}${cellDetails(s, m, summary)}</td>`;
        })
        .join("");
      return `<tr>
        <th scope="row"><a href="${escapeHTML(PathUtils.filename(s.reportPath))}">${escapeHTML(s.baseId ?? s.id)}</a>${modeTag(s)}${
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

  const statsText = h => {
    if (!h.judged) {
      return "not judged";
    }
    if (!h.failures) {
      return `all passed (${h.judged}/${h.judged})`;
    }
    return `${percent(h.failureRate)} failed (${h.failures}/${h.judged}) · mostly ${
      h.mostlyKind === "browser"
        ? '<strong class="fail">browser</strong>'
        : "model"
    }`;
  };
  const blockModelRows = h =>
    h.models
      .map(m => {
        const href = `${h.reportFile}#model=${encodeURIComponent(m.modelChoice)}${m.failures ? "&failures=1" : ""}`;
        return `<tr class="model-row" ${modelStyle(m.modelChoice)}>
          <th scope="row"><code class="model-dot">${escapeHTML(m.model)}</code></th>
          <td data-label="Status">${verdictBadge(m.verdict)}</td>
          <td data-label="Failed">${m.failures}/${m.judged}</td>
          <td data-label="Top reason">${m.topReason ? escapeHTML(m.topReason) : '<span class="muted">none</span>'}</td>
          <td><a class="touch" href="${escapeHTML(href)}">${m.failures ? "View failures" : "View attempts"}</a></td>
        </tr>`;
      })
      .join("");
  // One collapsible block per scenario, colored by its most serious verdict,
  // used for hot spots and for the matrix on narrow screens.
  const scenarioBlock = (
    h,
    open
  ) => `<details class="scenario-block status-${h.status}"${open ? " open" : ""}>
    <summary><span class="block-title"><span class="scenario-name">${escapeHTML(h.baseId)}</span>${modeTag(h)}${
      h.tier === "basic" ? ' <span class="muted">(smoke check)</span>' : ""
    }</span><span class="hs-stats">${statsText(h)}</span><span class="status-label">${STATUS_LABELS[h.status]}</span></summary>
    <table class="stack">
      <thead><tr><th>Model</th><th>Status</th><th>Failed</th><th>Top reason</th><th></th></tr></thead>
      <tbody>${blockModelRows(h)}</tbody>
    </table>
    <a class="touch" href="${escapeHTML(h.reportFile)}">Open the full report</a>
  </details>`;

  // On narrow screens the matrix becomes one collapsed block per scenario.
  const scenarioBlocks = scenarioStats
    .map(h =>
      scenarioBlock(
        {
          ...h,
          models: models
            .map(m => h.models.find(r => r.modelChoice === m.modelChoice))
            .filter(Boolean),
        },
        false
      )
    )
    .join("");
  // Pass rates per mode, over the base scenarios each model ran in both
  // sidebar and full page, so the comparison is paired.
  const compareModes =
    modes.includes("sidebar") && modes.includes("fullpage")
      ? models.map(m => {
          const pairs = new Map();
          m.perScenario.forEach(({ summary }, index) => {
            if (!summary || !summary.judged) {
              return;
            }
            const scenario = scenarios[index];
            const base = scenario.baseId ?? scenario.id;
            pairs.set(base, {
              ...pairs.get(base),
              [scenario.mode ?? "sidebar"]: summary,
            });
          });
          const totals = {
            sidebar: { passes: 0, judged: 0 },
            fullpage: { passes: 0, judged: 0 },
          };
          for (const pair of pairs.values()) {
            if (pair.sidebar && pair.fullpage) {
              for (const mode of ["sidebar", "fullpage"]) {
                totals[mode].passes += pair[mode].passes;
                totals[mode].judged += pair[mode].judged;
              }
            }
          }
          return { m, totals };
        })
      : [];
  const rateCell = ({ passes, judged }) =>
    judged ? `${passes}/${judged} · ${percent(passes / judged)}` : "n/a";
  const modeCompareRows = compareModes
    .map(({ m, totals }) => {
      const { sidebar, fullpage } = totals;
      let difference = "n/a";
      if (sidebar.judged && fullpage.judged) {
        const points = Math.round(
          (fullpage.passes / fullpage.judged -
            sidebar.passes / sidebar.judged) *
            100
        );
        difference = `${points > 0 ? "+" : ""}${points} pts`;
      }
      return `<tr class="model-row" ${modelStyle(m.modelChoice)}>
        <th scope="row"><code class="model-dot">${escapeHTML(m.model)}</code></th>
        <td data-label="Sidebar">${rateCell(sidebar)}</td>
        <td data-label="Full page">${rateCell(fullpage)}</td>
        <td data-label="Full page minus sidebar">${difference}</td>
      </tr>`;
    })
    .join("");
  const modeCompareSection = modeCompareRows
    ? `<h2>Sidebar vs full page</h2>
<p class="muted">Same scenarios, prompts and tabs in both modes. In the sidebar the model sees the selected page as context; in full page it does not. Counts only scenarios each model ran in both modes.</p>
<table class="models stack">
  <thead><tr><th>Model</th><th>Sidebar</th><th>Full page</th><th>Full page minus sidebar</th></tr></thead>
  <tbody>${modeCompareRows}</tbody>
</table>`
    : "";
  const modelRows = models
    .map(
      m => `<tr class="model-row" ${modelStyle(m.modelChoice)}>
        <th scope="row"><code class="model-dot">${escapeHTML(m.model)}</code>${m.isDefault ? '<span class="tag">default</span>' : ""}</th>
        <td data-label="Status">${verdictBadge(m.verdict)}</td>
        <td data-label="Scenarios">${scenarioCountsText(m.scenarioCounts)}</td>
        <td data-label="Pass rate"><span title="${m.passes} of ${m.judged} judged attempts passed">${percent(m.passRate)}</span></td>
        <td data-label="Main issue">${m.topIssue ? escapeHTML(m.topIssue.text) : '<span class="muted">none</span>'}</td>
      </tr>`
    )
    .join("");
  const hotSpotList = hotSpots.length
    ? hotSpots.map((h, i) => scenarioBlock(h, i === 0)).join("")
    : `<p class="muted">No model or browser failures.</p>`;

  // Smoke check skips are the run working as designed; only budget skips
  // mean the run stopped early, and that stays visible. Everything else about
  // the run sits behind the "Run details" button.
  const stoppedEarly = health.budgetSkipped
    ? ` · <strong class="fail">Stopped early: ${health.budgetSkipped} attempts skipped for budget</strong>`
    : "";
  const stampTime = stamp =>
    stamp.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2}).*$/, "$1 $2:$3 UTC");
  const runDetails = [
    ["Status", partial ? "Run not finished" : "Run complete"],
    rollup.mergedFrom && [
      "Merged from",
      `${rollup.mergedFrom.length} runs: ${rollup.mergedFrom.map(stampTime).join(", ")}`,
    ],
    ["Firefox", Services.appinfo.version],
    [
      "Tokens used",
      `${formatTokens(health.tokensUsed)}${health.tokenLimit ? ` of ${formatTokens(health.tokenLimit)}` : ""}`,
    ],
    ["Skipped by smoke check", `${health.smokeCheckSkipped} attempts`],
    ["Skipped for budget", `${health.budgetSkipped} attempts`],
    ["Service errors", String(health.infraFailures)],
    ["Rate-limit retries", String(health.rateLimitRetries)],
  ].filter(Boolean);

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
<p class="subtitle"><strong>${escapeHTML(rollup.feature ?? "")}</strong> · ${
    modes.length > 1
      ? `${Math.round((rollup.scenariosPlanned ?? finished) / modes.length)} scenarios × ${modes.length} modes`
      : `${rollup.scenariosPlanned ?? finished} scenarios`
  } · ${rollup.modelChoices.length} models · ${escapeHTML(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC · ${formatTokens(health.tokensUsed)} tokens${stoppedEarly}
  · <button type="button" class="details-button" data-explain-title="Run details" data-explain="${escapeHTML(runDetails.map(row => row.join(": ")).join(" · "))}" data-explain-rows="${escapeHTML(JSON.stringify(runDetails))}" data-help-section="help-terms">Run details</button></p>
${
  partial
    ? `<div class="banner" role="alert"><strong>Partial run: ${finished} of ${rollup.scenariosPlanned} scenarios finished.</strong>
    This roll-up is rewritten after each scenario. If the run has ended, it stopped early (for example a harness timeout), and the other scenarios did not run.</div>`
    : ""
}
<div class="headline headline-${headline.key}" role="status"><strong>${escapeHTML(headline.label)}.</strong> ${headline.html}</div>

<table class="models stack">
  <thead><tr><th>Model</th><th>Status</th><th>Scenarios</th><th>Pass rate</th><th>Main issue</th></tr></thead>
  <tbody>${modelRows}</tbody>
</table>

<h2>Hot spots: scenarios to check</h2>
${hotSpotList}
${modeCompareSection}

<h2>Scenarios by model</h2>
<table class="matrix matrix-wide">
  <thead><tr><th>Scenario</th>${modelHeaders}</tr></thead>
  <tbody>${overallRow}${matrixRows}</tbody>
</table>
<div class="matrix-narrow">
  ${scenarioBlocks}
</div>
${HELP}
${judgeDataTag(scenarios)}
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
    feature: rollup.feature,
    modelChoices: rollup.modelChoices,
    defaultModelChoice: rollup.defaultModelChoice,
    modes,
    judgeScriptFile: rollup.judgeScriptFile,
    tokenBudget: rollup.tokenBudget,
    mergedFrom: rollup.mergedFrom,
    scenariosFinished: finished,
    scenariosPlanned: rollup.scenariosPlanned ?? finished,
    headline: { key: headline.key, label: headline.label, text: headline.text },
    health,
    models: models.map(m => ({
      modelChoice: m.modelChoice,
      model: m.model,
      isDefault: m.isDefault,
      verdict: m.verdict,
      scenarioCounts: m.scenarioCounts,
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
    reports: scenarios.map(s => PathUtils.filename(s.reportPath)),
  });
  return path;
}
