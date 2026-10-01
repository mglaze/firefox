/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// mozperftest parses this file with Python esprima (ES2017) to read
// evalMetadata, so avoid ?., ??, logical assignment and optional catch
// bindings here; they break `./mach eval` but not `./mach test`.

const evalMetadata = {
  owner: "Smart Window",
  name: "Smart Window E2E Eval - group tabs",
  description:
    "Asks the real Smart Window chat, through MLPA, to group the recipe tabs, several times per model, and checks that exactly those tabs were grouped. An LLM judge scores the tool use.",
  test: "mochitest",
  options: {
    default: {
      manifest: "eval.toml",
      manifest_flavor: "browser-chrome",
      evaluations: {
        LlmJudge: { shouldAlert: false },
      },
      perfherder: true,
    },
  },
};

const { buildJudgePayload, judgeConfig } = ChromeUtils.importESModule(
  "chrome://mochitests/content/browser/browser/components/aiwindow/models/tests/browser_eval/prompts/judge.sys.mjs"
);

const { MODES, SCENARIOS, plannedTabTitle, scenarioVariants } =
  ChromeUtils.importESModule(
    "chrome://mochitests/content/browser/browser/components/aiwindow/models/tests/browser_eval/scenarios.sys.mjs"
  );

const { toolsConfig } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);

const {
  judgeId,
  judgeResultsScript,
  runStamp,
  writeScenarioReport,
  writeRollupReport,
} = ChromeUtils.importESModule(
  "chrome://mochitests/content/browser/browser/components/aiwindow/models/tests/browser_eval/report.sys.mjs"
);

/**
 * @param {object} scenario
 * @returns {object[]} Smart Window's definitions of the tools the scenario
 *   uses, which the judge sees.
 */
function judgeTools(scenario) {
  return toolsConfig.filter(tool =>
    scenario.judge.tools.includes(tool.function.name)
  );
}

// The judge sees tab titles only: catalog URLs carry role-coded ids, such as
// rec-f01, that would give the answer away.
function judgeTabView(outcome) {
  const titles = new Map(outcome.openTabs.map(tab => [tab.url, tab.title]));
  const titleFor = url => titles.get(url) || plannedTabTitle(url);
  return {
    openTabs: outcome.openTabs.map(tab => tab.title),
    // How the URL tokens in the tool calls map to tabs, as Smart Window
    // resolves them.
    urlTokens: outcome.urlTokens.map(({ token, url }) => ({
      token: `§url_token: ${token}§`,
      tab: titleFor(url),
    })),
    groups: outcome.groups.map(group => ({
      label: group.label,
      tabs: group.urls.map(titleFor),
    })),
  };
}

const SELECTED_SCENARIOS = Services.env.get("SMARTWINDOW_E2E_SCENARIOS")
  ? Services.env.get("SMARTWINDOW_E2E_SCENARIOS").split(",")
  : SCENARIOS.map(s => s.id);
// Every scenario runs in each selected mode, so the modes can be compared on
// the same prompts and tabs.
const SELECTED_MODES = (
  Services.env.get("SMARTWINDOW_E2E_MODES") || MODES.join(",")
).split(",");
const RUN_UNITS = scenarioVariants(
  SCENARIOS.filter(s => SELECTED_SCENARIOS.includes(s.id)),
  SELECTED_MODES.filter(mode => MODES.includes(mode))
);

// browser.smartwindow.firstrun.modelChoice values: 1 is gemini-3.1-flash-lite,
// 2 is qwen3-235b (the default) and 3 is mistral-small.
const MODEL_CHOICES = (
  Services.env.get("SMARTWINDOW_E2E_MODEL_CHOICES") || "1,2,3"
).split(",");
const ATTEMPTS_PER_MODEL = Number(
  Services.env.get("SMARTWINDOW_E2E_ATTEMPTS") || 5
);
const PASS_RATE_GATE = 0.8;
// The model users get by default (is_default in the ai-window-prompts dump),
// called out in the roll-up.
const DEFAULT_MODEL_CHOICE = "2";
// Each model runs the basic scenario first as a smoke check; only models with
// at least BASIC_GATE_MIN_PASSES passes go on to the advanced scenarios.
const BASIC_ATTEMPTS = Number(
  Services.env.get("SMARTWINDOW_E2E_BASIC_ATTEMPTS") || 3
);
const BASIC_GATE_MIN_PASSES = Number(
  Services.env.get("SMARTWINDOW_E2E_BASIC_MIN_PASSES") || 2
);
// MLPA rate limits are per account, so a burst from one model can starve the
// next. Rate-limited attempts wait and retry instead of counting as results.
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_WAIT_MS = Number(
  Services.env.get("SMARTWINDOW_E2E_RATE_LIMIT_WAIT_MS") || 30000
);
// Input + output tokens the whole run may use across all scenarios, modes and
// models; by default 1.5M per mode. Checked before each attempt, so the
// attempt in flight can overshoot it. 0 disables the cap.
const TOKEN_BUDGET = Number(
  Services.env.get("SMARTWINDOW_E2E_TOKEN_BUDGET") ||
    1500000 * SELECTED_MODES.length
);

// Size the harness timeout (45s units) from the plan: up to a minute per
// attempt plus its rate-limit waits. It is a ceiling, not the expected time.
const PLANNED_ATTEMPTS =
  MODEL_CHOICES.length *
  RUN_UNITS.reduce(
    (n, s) => n + (s.tier === "basic" ? BASIC_ATTEMPTS : ATTEMPTS_PER_MODEL),
    0
  );
const TIMEOUT_FACTOR = Math.max(
  40,
  Math.ceil(
    (PLANNED_ATTEMPTS *
      (60 + (RATE_LIMIT_RETRIES * RATE_LIMIT_WAIT_MS) / 1000)) /
      45
  )
);
requestLongerTimeout(TIMEOUT_FACTOR);

/**
 * Finds open tabs that a manage_tabs call asked to group but that did not end
 * up in a group. The model picked them, so leaving them out is a Firefox bug.
 *
 * @param {object} manageTabsCall - The chat-completions tool call.
 * @param {Map<string, string>} tokenToUrl - The conversation's URL tokens.
 * @param {object} outcome - With `openTabs` and `groups` filled in.
 * @returns {{requested: number, dropped: string[]}} How many tabs the call
 *   named, and the titles of the open tabs left out.
 */
function findDroppedTabs(manageTabsCall, tokenToUrl, outcome) {
  let items = [];
  try {
    items = JSON.parse(manageTabsCall.function.arguments).url_tokens || [];
  } catch (e) {}
  const requested = items
    .map(item => {
      const match = /§url_token:\s*([A-Z0-9_]+_\d+)§/.exec(String(item));
      return match ? tokenToUrl.get(match[1]) : item;
    })
    .filter(Boolean);
  const titles = new Map(outcome.openTabs.map(tab => [tab.url, tab.title]));
  const grouped = new Set(outcome.groups.flatMap(group => group.urls));
  return {
    requested: requested.length,
    dropped: [...new Set(requested)]
      .filter(url => titles.has(url) && !grouped.has(url))
      .map(url => titles.get(url)),
  };
}

/**
 * @param {string} modelChoice
 * @param {number} attempt
 * @param {object} [fields] - Fields that differ from an attempt that has not
 *   run yet.
 * @returns {object} An attempt outcome.
 */
function makeOutcome(modelChoice, attempt, fields = {}) {
  return {
    modelChoice,
    attempt,
    model: "",
    result: "",
    reason: "",
    path: null,
    toolCalls: [],
    reply: "",
    groups: [],
    openTabs: [],
    urlTokens: [],
    durationMs: 0,
    usage: null,
    ...fields,
  };
}

/**
 * Runs a scenario once in a fresh Smart Window.
 *
 * @param {object} scenario - An entry of SCENARIOS.
 * @param {string} modelChoice
 * @param {number} attempt
 * @returns {Promise<object>} The outcome. `result` is "pass", "model",
 *   "product" or "infra".
 */
async function runAttempt(scenario, modelChoice, attempt) {
  const outcome = makeOutcome(modelChoice, attempt);
  const fail = (result, reason) => Object.assign(outcome, { result, reason });

  const fetchWithHistorySpy = sinon.spy(Chat, "fetchWithHistory");
  const receiveResponseSpy = sinon.spy(
    ChatConversation.prototype,
    "receiveResponse"
  );
  let win;

  try {
    win = await AIWindowTestUtils.openReadyAIWindow();
    // A new Smart Window opens on its full-page chat tab.
    const chatTab = win.gBrowser.selectedTab;
    // Added in order, loaded in parallel.
    const tabs = scenario.tabs.map(url =>
      BrowserTestUtils.addTab(win.gBrowser, url)
    );
    await Promise.all(
      tabs.map((tab, i) =>
        BrowserTestUtils.browserLoaded(tab.linkedBrowser, {
          wantLoad: scenario.tabs[i],
        })
      )
    );
    outcome.openTabs = tabs.map(tab => ({
      title: tab.label,
      url: tab.linkedBrowser.currentURI.spec,
    }));

    // In the sidebar the last scenario tab is selected, so the model sees it
    // as the current page; in full page the chat tab itself is selected.
    let chatBrowser;
    if (scenario.mode === "fullpage") {
      win.gBrowser.selectedTab = chatTab;
      chatBrowser = chatTab.linkedBrowser;
      await TestUtils.waitForCondition(
        () =>
          chatBrowser.contentDocument &&
          chatBrowser.contentDocument.querySelector("ai-window:defined"),
        "The full-page ai-window should be loaded"
      );
    } else {
      win.gBrowser.selectedTab = tabs.at(-1);
      chatBrowser = await openSmartWindowSidebar(win);
    }
    const aiWindow = chatBrowser.contentDocument.querySelector("ai-window");

    await typeInSmartbar(chatBrowser, scenario.instruction);
    await AIWindowTestUtils.selectExplicitSmartbarAction(chatBrowser, "chat");
    const start = ChromeUtils.now();
    await submitSmartbar(chatBrowser);
    await waitForTurnComplete(aiWindow);
    outcome.durationMs = ChromeUtils.now() - start;
    const engine = aiWindow.conversation.engine;
    outcome.model = (engine && engine.model) || "";
    outcome.usage = await collectTurnUsage(
      receiveResponseSpy,
      aiWindow.conversation
    );

    if (!fetchWithHistorySpy.called) {
      return fail("product", "the chat request was never sent");
    }
    const chatError = await fetchWithHistorySpy.lastCall.returnValue.then(
      () => null,
      error => error
    );
    if (chatError) {
      const { kind, reason, rateLimited } = describeChatError(chatError);
      outcome.rateLimited = rateLimited;
      return fail(kind, reason);
    }
    const { signal } = fetchWithHistorySpy.lastCall.args[0];
    if (signal && signal.aborted) {
      return fail(
        "product",
        "the chat request was aborted before the turn finished"
      );
    }

    const { conversation } = aiWindow;
    outcome.urlTokens = [...conversation.tokenToUrl].map(([token, url]) => ({
      token,
      url,
    }));
    const messages = conversation.getMessagesInChatCompletionsFormat();
    outcome.toolCalls = messages
      .filter(message => message.tool_calls)
      .flatMap(message => message.tool_calls);
    const lastReply = messages.findLast(
      message => message.role === "assistant"
    );
    outcome.reply = (lastReply && lastReply.content) || "";

    const manageTabsCall = outcome.toolCalls.findLast(
      call => call.function && call.function.name === "manage_tabs"
    );
    if (!manageTabsCall) {
      return fail("model", "manage_tabs was not called");
    }

    const lastUIMessage = conversation.messages.findLast(
      message => message.toolUIData
    );
    const uiType = lastUIMessage && lastUIMessage.toolUIData.uiType;
    if (uiType === "tab-group-confirmation") {
      outcome.path = "confirmation";
      await clickConfirmationCardConfirm(aiWindow);
    } else if (uiType === "ai-action-result") {
      outcome.path = "direct";
    } else {
      return fail(
        "model",
        `manage_tabs did not produce a tab group (tool UI "${uiType}")`
      );
    }

    try {
      await TestUtils.waitForCondition(
        () => win.gBrowser.tabGroups.length,
        "A tab group should be created"
      );
    } catch (e) {
      return fail(
        "product",
        `no tab group was created after the "${outcome.path}" path`
      );
    }

    outcome.groups = snapshotTabGroups(win);
    const { requested, dropped } = findDroppedTabs(
      manageTabsCall,
      conversation.tokenToUrl,
      outcome
    );
    if (dropped.length) {
      return fail(
        "product",
        `manage_tabs asked to group ${requested} tabs, but Firefox left out ${dropped.map(title => `"${title}"`).join(", ")}`
      );
    }
    const { ok, reason } = scenario.required
      ? verifyGroupedCatalogTabs(
          outcome.groups,
          scenario.required,
          scenario.optional
        )
      : verifyGroupedExactly(outcome.groups, scenario.expectedUrls);
    return ok
      ? Object.assign(outcome, { result: "pass", reason })
      : fail("model", reason);
  } finally {
    fetchWithHistorySpy.restore();
    receiveResponseSpy.restore();
    if (win) {
      await BrowserTestUtils.closeWindow(win);
    }
  }
}

/**
 * Runs one attempt, waiting and retrying when MLPA rate limits it, so a
 * backend quota does not show up as a missing result.
 *
 * @param {object} scenario - An entry of SCENARIOS.
 * @param {string} modelChoice
 * @param {number} attempt
 * @returns {Promise<object>} The outcome, with the number of `retries` used.
 */
const NO_USAGE = {
  input: 0,
  output: 0,
  cached: 0,
  total: 0,
  reported: false,
  rounds: [],
};

function addUsage(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cached: a.cached + b.cached,
    total: a.total + b.total,
    reported: a.reported || b.reported,
    rounds: [...a.rounds, ...b.rounds],
  };
}

async function runAttemptWithRateLimitRetries(scenario, modelChoice, attempt) {
  // Tokens a rate-limited try spent before failing still count.
  let retryUsage = null;
  for (let retries = 0; ; retries++) {
    let outcome;
    try {
      outcome = await runAttempt(scenario, modelChoice, attempt);
    } catch (e) {
      outcome = makeOutcome(modelChoice, attempt, {
        result: "infra",
        reason: `unexpected error, possibly a slow or failing backend: ${e}`,
      });
    }
    outcome.retries = retries;
    if (!outcome.rateLimited || retries >= RATE_LIMIT_RETRIES) {
      if (retryUsage && retryUsage.total) {
        outcome.usage = addUsage(outcome.usage || NO_USAGE, retryUsage);
        outcome.usage.retryTokens = retryUsage.total;
      }
      return outcome;
    }
    if (outcome.usage) {
      retryUsage = addUsage(retryUsage || NO_USAGE, outcome.usage);
    }
    info(
      `${scenario.id}: model choice ${modelChoice} attempt ${attempt} was rate limited, retrying in ${RATE_LIMIT_WAIT_MS}ms`
    );
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
  }
}

/**
 * Runs every attempt of a scenario, round-robin over models so a rate limit
 * affects all of them equally, and writes its report.
 *
 * @param {object} scenario - An entry of SCENARIOS.
 * @param {{limit: number, used: number, warned: boolean}} budget - Token
 *   budget shared by the whole run.
 * @param {Map<string, string>} modelNames - Model name for each model choice,
 *   so attempts that never reach the model still show which one they were for.
 * @param {object} options
 * @param {number} options.attemptsPerModel
 * @param {Map<string, string>} options.smokeCheckFailures - Reason, keyed by
 *   model choice, for models that did not pass the smoke check scenario.
 * @param {{path: string, fileName: string}} options.judgeScript - Where the
 *   judge writes its results, see judgeResultsScript().
 * @returns {Promise<{attempts: object[], reportPath: string}>}
 */
async function runScenario(
  scenario,
  budget,
  modelNames,
  { attemptsPerModel, smokeCheckFailures, judgeScript }
) {
  const attempts = [];
  const notRun = (modelChoice, attempt, result, reason) =>
    makeOutcome(modelChoice, attempt, { result, reason, retries: 0 });
  for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
    for (const modelChoice of MODEL_CHOICES) {
      let outcome;
      if (smokeCheckFailures.has(modelChoice)) {
        outcome = notRun(
          modelChoice,
          attempt,
          "smoke-check",
          smokeCheckFailures.get(modelChoice)
        );
      } else if (budget.limit && budget.used >= budget.limit) {
        outcome = notRun(
          modelChoice,
          attempt,
          "budget",
          `not run: the token budget of ${budget.limit.toLocaleString()} was reached (${budget.used.toLocaleString()} tokens used before this attempt)`
        );
      } else {
        await SpecialPowers.pushPrefEnv({
          set: [["browser.smartwindow.firstrun.modelChoice", modelChoice]],
        });
        outcome = await runAttemptWithRateLimitRetries(
          scenario,
          modelChoice,
          attempt
        );
        await SpecialPowers.popPrefEnv();
        budget.used += (outcome.usage && outcome.usage.total) || 0;
        if (
          budget.limit &&
          !budget.warned &&
          budget.used >= budget.limit * 0.8
        ) {
          budget.warned = true;
          info(
            `Token budget warning: ${budget.used.toLocaleString()} of ${budget.limit.toLocaleString()} tokens used`
          );
        }
      }
      if (!outcome.model) {
        outcome.model = modelNames.get(modelChoice) || "";
      }
      attempts.push(outcome);
      info(
        `smartwindowE2EAttempt | ${JSON.stringify({
          scenario: scenario.id,
          modelChoice,
          model: outcome.model,
          attempt,
          result: outcome.result,
          reason: outcome.reason,
          retries: outcome.retries,
          tokens: (outcome.usage && outcome.usage.total) || 0,
        })}`
      );

      if (outcome.result === "budget" || outcome.result === "smoke-check") {
        info(`${scenario.id}: ${outcome.reason}`);
      } else if (outcome.result === "pass" || outcome.result === "model") {
        const tabView = judgeTabView(outcome);
        // Saved with the attempt so rejudge_saved_run.py can judge it again.
        outcome.judgeInput = {
          instruction: scenario.instruction,
          criteria: scenario.judge.criteria,
          dimensions: scenario.judge.dimensions,
          toolDefinitions: judgeTools(scenario),
          stateBefore: { label: "Open tabs", data: tabView.openTabs },
          urlTokens: tabView.urlTokens,
          toolCalls: outcome.toolCalls,
          stateAfter: { label: "Tab groups", data: tabView.groups },
        };
        MLTestUtils.reportEvalData({
          id: judgeId(scenario.id, modelChoice, attempt),
          results_script: judgeScript.path,
          subtest: outcome.model,
          ...buildJudgePayload(outcome.judgeInput),
          eval_config: judgeConfig(scenario.judge.dimensions),
          target_model: outcome.model,
          scenario: scenario.id,
        });
      } else {
        Assert.ok(
          false,
          `${scenario.id}: ${outcome.result}: ${outcome.reason}`
        );
      }
    }
  }

  // Fall back to the planned tabs when no attempt ran.
  const ranTabs = attempts.find(a => a.openTabs.length);
  const { path: reportPath } = await writeScenarioReport({
    id: scenario.id,
    title: scenario.title,
    instruction: scenario.instruction,
    openTabs: ranTabs
      ? ranTabs.openTabs
      : scenario.tabs.map(url => ({ title: plannedTabTitle(url), url })),
    expectedUrls: scenario.expectedUrls,
    optionalUrls: scenario.optionalUrls || [],
    tier: scenario.tier,
    mode: scenario.mode,
    baseId: scenario.baseId,
    judge: scenario.judge,
    judgeTools: judgeTools(scenario),
    attemptsPerModel,
    passRateGate: PASS_RATE_GATE,
    tokenBudget: { limit: budget.limit, used: budget.used },
    modelNames,
    attempts,
    judgeScriptFile: judgeScript.fileName,
  });
  info(`Report for ${scenario.id} written to ${reportPath}`);

  for (const modelChoice of MODEL_CHOICES) {
    const forModel = attempts.filter(a => a.modelChoice === modelChoice);
    const passes = forModel.filter(a => a.result === "pass").length;
    info(
      `${scenario.id}: model choice ${modelChoice} (${forModel.length ? forModel[0].model : ""}): ${passes}/${forModel.length} passed`
    );
  }
  return { attempts, reportPath };
}

/**
 * Works out which models did not pass the smoke check scenario.
 *
 * @param {object} scenario - The smoke check scenario.
 * @param {object[]} attempts - Its attempts.
 * @param {Map<string, string>} modelNames
 * @returns {Map<string, string>} Reason, keyed by model choice, for each
 *   model that did not pass.
 */
function findSmokeCheckFailures(scenario, attempts, modelNames) {
  const failures = new Map();
  for (const modelChoice of MODEL_CHOICES) {
    const forModel = attempts.filter(a => a.modelChoice === modelChoice);
    const passes = forModel.filter(a => a.result === "pass").length;
    const minPasses = Math.min(BASIC_GATE_MIN_PASSES, forModel.length);
    if (passes >= minPasses) {
      continue;
    }
    const name = modelNames.get(modelChoice) || `model choice ${modelChoice}`;
    const infra = forModel.filter(a => a.result === "infra").length;
    const misses = forModel.length - passes - infra;
    failures.set(
      modelChoice,
      infra && !misses
        ? `not run: the smoke check (${scenario.id}) could not check ${name} because ${infra} of ${forModel.length} attempts failed with infra errors (MLPA, auth or network)`
        : `not run: ${name} did not pass the smoke check (${scenario.id}): ${passes}/${forModel.length} passed, ${minPasses} needed` +
            (infra ? `, ${infra} infra failure(s)` : "")
    );
  }
  return failures;
}

add_task(async function test_group_recipe_tabs() {
  const token = Services.env.get("MOZ_FXA_BEARER_TOKEN");
  if (!token) {
    Assert.ok(
      false,
      "infra: MOZ_FXA_BEARER_TOKEN must be set in the environment. Please run ./mach eval-tools login."
    );
    return;
  }

  Assert.ok(
    RUN_UNITS.length,
    `SMARTWINDOW_E2E_SCENARIOS should name at least one of: ${SCENARIOS.map(s => s.id).join(", ")}, and SMARTWINDOW_E2E_MODES at least one of: ${MODES.join(", ")}`
  );

  const { cleanup } = await setupSmartWindowE2E(token);
  info(
    `Timeout sized for ${PLANNED_ATTEMPTS} planned attempts (factor ${TIMEOUT_FACTOR})`
  );
  const budget = { limit: TOKEN_BUDGET, used: 0, warned: false };
  const stamp = runStamp();
  const judgeScript = await judgeResultsScript(stamp);
  // Resolved from the in-tree Remote Settings dump, the same way the Smart
  // Window model picker does, without calling the model.
  const modelNames = new Map();
  for (const modelChoice of MODEL_CHOICES) {
    const model = await getModelForChoice(modelChoice);
    modelNames.set(modelChoice, (model && model.model) || "");
  }
  const results = [];
  // Rewritten after every scenario, so a harness timeout still leaves an
  // up-to-date roll-up.
  const writeRollup = () =>
    writeRollupReport({
      scenarios: results,
      modelChoices: MODEL_CHOICES,
      modelNames,
      defaultModelChoice: DEFAULT_MODEL_CHOICE,
      passRateGate: PASS_RATE_GATE,
      tokenBudget: { limit: budget.limit, used: budget.used },
      judgeScriptFile: judgeScript.fileName,
      runStamp: stamp,
      scenariosPlanned: RUN_UNITS.length,
      feature: "Tab grouping",
      modes: [...new Set(RUN_UNITS.map(unit => unit.mode))],
    });
  let rollupPath;
  try {
    // Each mode runs its own smoke check, which gates that mode's advanced
    // scenarios, so a model can pass in one mode and not the other.
    for (const mode of new Set(RUN_UNITS.map(unit => unit.mode))) {
      const units = RUN_UNITS.filter(unit => unit.mode === mode);
      const smokeCheck = units.find(s => s.tier === "basic");
      const advanced = units.filter(s => s.tier !== "basic");
      let smokeCheckFailures = new Map();
      if (smokeCheck) {
        const result = await runScenario(smokeCheck, budget, modelNames, {
          attemptsPerModel: BASIC_ATTEMPTS,
          smokeCheckFailures,
          judgeScript,
        });
        results.push({
          ...smokeCheck,
          attemptsPerModel: BASIC_ATTEMPTS,
          ...result,
        });
        rollupPath = await writeRollup();
        smokeCheckFailures = findSmokeCheckFailures(
          smokeCheck,
          result.attempts,
          modelNames
        );
        if (
          smokeCheckFailures.size === MODEL_CHOICES.length &&
          advanced.length
        ) {
          info(
            `${mode}: no model passed the smoke check, so the advanced scenarios are not run`
          );
        }
      } else if (advanced.length) {
        info(
          `${mode}: the smoke check scenario is not selected, so no model is skipped`
        );
      }
      for (const scenario of advanced) {
        const result = await runScenario(scenario, budget, modelNames, {
          attemptsPerModel: ATTEMPTS_PER_MODEL,
          smokeCheckFailures,
          judgeScript,
        });
        results.push({
          ...scenario,
          attemptsPerModel: ATTEMPTS_PER_MODEL,
          ...result,
        });
        rollupPath = await writeRollup();
      }
    }
    info(`Roll-up written to ${rollupPath}`);
  } finally {
    await cleanup();
  }
  info(
    `Tokens used by the run: ${budget.used.toLocaleString()}${budget.limit ? ` of a ${budget.limit.toLocaleString()} budget` : " (no budget)"}`
  );
  Assert.ok(
    results.some(r =>
      r.attempts.some(a => a.result !== "budget" && a.result !== "smoke-check")
    ),
    "At least one attempt ran; model misses are reported, not failed"
  );
});
