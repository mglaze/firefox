/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  AIWindowAccountAuth:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindowAccountAuth.sys.mjs",
  AIWindowTestUtils: "resource://testing-common/AIWindowTestUtils.sys.mjs",
  AIWindowUI:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindowUI.sys.mjs",
  Chat: "moz-src:///browser/components/aiwindow/models/Chat.sys.mjs",
  ChatConversation:
    "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs",
  getModelForChoice:
    "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  IntentClassifier:
    "moz-src:///browser/components/aiwindow/models/IntentClassifier.sys.mjs",
  MESSAGE_ROLE:
    "moz-src:///browser/components/aiwindow/models/Conversation.sys.mjs",
  MLTestUtils: "resource://testing-common/MLTestUtils.sys.mjs",
  openAIEngine:
    "moz-src:///browser/components/aiwindow/models/openAIEngine.sys.mjs",
  SearchTestUtils: "resource://testing-common/SearchTestUtils.sys.mjs",
  sinon: "resource://testing-common/Sinon.sys.mjs",
  _embeddingFunctions:
    "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs",
});

SearchTestUtils.init(this);
AIWindowTestUtils.init(this, window);

async function setupEvaluation({ url, waitForLoad = true }) {
  await SpecialPowers.pushPrefEnv({
    set: [["services.settings.server", "data:,#remote-settings-dummy/v1"]],
  });

  const { RemoteSettingsClient } = ChromeUtils.importESModule(
    "resource://services-settings/RemoteSettingsClient.sys.mjs"
  );
  const originalValidateCollectionSignature =
    RemoteSettingsClient.prototype.validateCollectionSignature;
  RemoteSettingsClient.prototype.validateCollectionSignature = async () => {};

  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    url,
    waitForLoad
  );

  return {
    tab,

    async cleanup() {
      info("Cleaning up");
      RemoteSettingsClient.prototype.validateCollectionSignature =
        originalValidateCollectionSignature;
      await BrowserTestUtils.removeTab(tab);
      await SpecialPowers.popPrefEnv();
    },
  };
}

/**
 * Collect the full text response and tool calls from Chat.fetchWithHistory.
 *
 * @param {ChatConversation} conversation
 * @returns {Promise<{ responseText: string, toolCalls: Array<{id: string, type: string, function: {name: string, arguments: string}}> }>}
 */
async function collectChatResponse(conversation) {
  const { Chat } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/models/Chat.sys.mjs"
  );
  await Chat.fetchWithHistory({ conversation });
  const messages = conversation.getMessagesInChatCompletionsFormat();
  const lastAssistant = messages.findLast(msg => msg.role === "assistant");
  const responseText = lastAssistant?.content ?? "";
  const toolCalls = messages
    .filter(msg => msg.tool_calls)
    .flatMap(msg => msg.tool_calls);
  return { responseText, toolCalls };
}

/**
 * Report eval data out to stdout, which will be picked up by the test harness for
 * analysis.
 *
 * @param {any} data - JSON serializable data.
 */
function reportEvalResult(data) {
  info("evalDataPayload | " + JSON.stringify(data));

  dump("-------------------------------------\n");
  dump("Eval result:\n");
  dump(JSON.stringify(data, null, 2));
  dump("\n");
}

/**
 * Renders a prompt from a string into a messages array, splitting on !role:[role]
 * markers and replacing {placeholder} tokens with provided values.
 *
 * @param {string} rawPromptContent              The raw prompt as a string
 * @param {object} stringsToReplace              A map of placeholder strings to their replacements
 * @returns {Array<{role: string, content: string}>}
 */
function renderPrompt(rawPromptContent, stringsToReplace = {}) {
  const roleRegex = /!role:\[(\w+)\]/g;
  const messages = [];
  let lastIndex = 0;
  let lastRole = null;
  let match;

  while ((match = roleRegex.exec(rawPromptContent)) !== null) {
    if (lastRole !== null) {
      messages.push({
        role: lastRole,
        content: rawPromptContent.slice(lastIndex, match.index).trim(),
      });
    }
    lastRole = match[1];
    lastIndex = match.index + match[0].length;
  }

  if (lastRole !== null) {
    messages.push({
      role: lastRole,
      content: rawPromptContent.slice(lastIndex).trim(),
    });
  }

  for (const message of messages) {
    for (const [orig, repl] of Object.entries(stringsToReplace)) {
      message.content = message.content.replace(
        new RegExp(`\\{${orig}\\}`, "g"),
        () => repl
      );
    }
  }

  return messages;
}

/**
 * Prepares a live end-to-end Smart Window run. Firefox stays real, the "chat"
 * engine talks to MLPA, and only auth, sign-in, on-device models (intent
 * classifier, tab-title embeddings) and non-chat model requests (starters,
 * titles) are stubbed.
 *
 * Must run before any Smart Window opens, so prompts and model configs are
 * read from the in-tree Remote Settings dump.
 *
 * @param {string} token - The FxA bearer token to send to MLPA.
 * @returns {Promise<{ cleanup: () => Promise<void> }>}
 */
async function setupSmartWindowE2E(token) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["services.settings.server", "data:,#remote-settings-dummy/v1"],
      ["browser.smartwindow.enabled", true],
      ["browser.smartwindow.firstrun.hasCompleted", true],
      ["browser.smartwindow.memories.generateFromConversation", false],
      ["browser.smartwindow.memories.generateFromHistory", false],
      ["browser.newtab.preload", false],
      ["browser.search.suggest.enabled", false],
      ["browser.urlbar.suggest.searches", false],
      ["sidebar.notification.badge.aichat", false],
      ["places.semanticHistory.featureGate", false],
    ],
  });

  const { RemoteSettingsClient } = ChromeUtils.importESModule(
    "resource://services-settings/RemoteSettingsClient.sys.mjs"
  );
  const originalValidateCollectionSignature =
    RemoteSettingsClient.prototype.validateCollectionSignature;
  RemoteSettingsClient.prototype.validateCollectionSignature = async () => {};

  await SearchTestUtils.installSearchExtension(
    {
      name: "SmartWindowE2EEngine",
      search_url: "https://example.org/smartwindow-e2e-serp/",
      search_url_get_params: "?q={searchTerms}",
    },
    { setAsDefault: true }
  );

  const realCreateEngine = openAIEngine._createEngine;
  const mockEngines = [];
  const stubs = [
    sinon.stub(openAIEngine, "getFxAccountToken").resolves(token),
    sinon.stub(openAIEngine, "_createEngine").callsFake(options => {
      // Match on featureId, not purpose: the LLM telemetry engine also uses
      // the "chat" purpose.
      if (options.featureId === "chat") {
        return realCreateEngine(options);
      }
      const engine = new MLTestUtils.MockLLMEngine(options);
      mockEngines.push(engine);
      return engine;
    }),
    sinon.stub(IntentClassifier, "_createEngine").resolves({
      run() {
        return [
          { label: "chat", score: 0.95 },
          { label: "search", score: 0.05 },
        ];
      },
    }),
    sinon.stub(AIWindowAccountAuth, "ensureAIWindowAccess").resolves(true),
    sinon
      .stub(_embeddingFunctions, "embedTexts")
      .rejects(new Error("On-device embeddings are disabled in this eval")),
  ];

  return {
    async cleanup() {
      for (const engine of mockEngines) {
        engine.rejectAllRequests();
      }
      for (const stub of stubs) {
        stub.restore();
      }
      RemoteSettingsClient.prototype.validateCollectionSignature =
        originalValidateCollectionSignature;
      await SpecialPowers.popPrefEnv();
      for (const pref of [
        "browser.smartwindow.chat.interactionCount",
        "browser.smartwindow.lastLLMTelemetryRunTime",
        "browser.smartwindow.lastSmartWindowUsageTime",
        "places.semanticHistory.initialized",
      ]) {
        Services.prefs.clearUserPref(pref);
      }
    },
  };
}

/**
 * Opens the Smart Window sidebar next to the selected tab.
 *
 * @param {Window} win
 * @returns {Promise<MozBrowser>} The sidebar browser hosting ai-window.
 */
async function openSmartWindowSidebar(win) {
  if (!AIWindowUI.isSidebarOpen(win)) {
    AIWindowUI.toggleSidebar(win);
  }
  const sidebarBrowser = win.document.getElementById("ai-window-browser");
  await TestUtils.waitForCondition(
    () => sidebarBrowser.contentDocument?.querySelector("ai-window:defined"),
    "The sidebar ai-window should be loaded"
  );
  return sidebarBrowser;
}

/**
 * Types text into the smartbar of the given ai-window browser.
 *
 * @param {MozBrowser} browser
 * @param {string} text
 */
async function typeInSmartbar(browser, text) {
  await SpecialPowers.spawn(browser, [text], async searchText => {
    const aiWindowElement = content.document.querySelector("ai-window");
    const smartbar = await ContentTaskUtils.waitForCondition(
      () => aiWindowElement.shadowRoot?.querySelector("#ai-window-smartbar"),
      "Wait for Smartbar to be rendered"
    );
    smartbar.inputField.focus();
    await ContentTaskUtils.waitForCondition(
      () => smartbar.matches(":focus-within"),
      "Wait for smartbar to receive focus"
    );
    EventUtils.sendString(searchText, content);
    await smartbar.lastQueryContextPromise;
  });
}

/**
 * Submits the smartbar of the given ai-window browser with Enter.
 *
 * @param {MozBrowser} browser
 */
async function submitSmartbar(browser) {
  await SpecialPowers.spawn(browser, [], async () => {
    const aiWindow = content.document.querySelector("ai-window");
    const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
    const inputCta = smartbar.querySelector("input-cta");
    await ContentTaskUtils.waitForCondition(
      () => inputCta.getAttribute("action") !== "stop",
      "Wait for generation to complete before submitting via Enter"
    );
    smartbar.inputField.focus();
    EventUtils.synthesizeKey("KEY_Enter", {}, content);
  });
}

/**
 * Waits until the submitted user turn has been fully handled, including every
 * tool call round.
 *
 * @param {Element} aiWindow - The ai-window element.
 */
async function waitForTurnComplete(aiWindow) {
  await TestUtils.waitForCondition(
    () =>
      aiWindow.conversation?.messages.some(
        message => message.role === MESSAGE_ROLE.USER
      ),
    "The user message should be added to the conversation"
  );
  await TestUtils.waitForCondition(
    () => !aiWindow.isGenerating,
    "The assistant turn should finish",
    500,
    360
  );
}

/**
 * Clicks Confirm on the tab confirmation card rendered in the chat.
 *
 * @param {Element} aiWindow - The ai-window element hosting #aichat-browser.
 */
async function clickConfirmationCardConfirm(aiWindow) {
  const aichatBrowser = aiWindow.shadowRoot.querySelector("#aichat-browser");
  await SpecialPowers.spawn(aichatBrowser, [], async () => {
    const chatContent = content.document.querySelector("ai-chat-content");
    const confirmation = await ContentTaskUtils.waitForCondition(
      () => chatContent.shadowRoot?.querySelector("ai-website-confirmation"),
      "The confirmation card should render"
    );
    const confirmButton = await ContentTaskUtils.waitForCondition(
      () =>
        confirmation.shadowRoot?.querySelector(
          "moz-button[type='primary']:not([disabled])"
        ),
      "The confirmation card should have an enabled Confirm button"
    );
    confirmButton.click();
  });
}

/**
 * Sums the token usage MLPA reported for each model round of a turn. Only
 * calls made on `conversation` count, so mocked side requests are ignored.
 *
 * @param {object} receiveResponseSpy - Sinon spy on
 *   ChatConversation.prototype.receiveResponse.
 * @param {object} conversation - The chat conversation of the turn.
 * @returns {Promise<{input: number, output: number, cached: number,
 *   total: number, reported: boolean,
 *   rounds: Array<{input: number, output: number, cached: number}>}>}
 */
async function collectTurnUsage(receiveResponseSpy, conversation) {
  const rounds = [];
  let reported = false;
  for (const call of receiveResponseSpy.getCalls()) {
    if (call.thisValue !== conversation) {
      continue;
    }
    const usage = (await call.returnValue.catch(() => null))?.usage;
    reported ||= !!usage;
    rounds.push({
      input: usage?.prompt_tokens ?? 0,
      output: usage?.completion_tokens ?? 0,
      cached: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    });
  }
  const sum = key => rounds.reduce((total, round) => total + round[key], 0);
  const input = sum("input");
  const output = sum("output");
  return {
    input,
    output,
    cached: sum("cached"),
    total: input + output,
    reported,
    rounds,
  };
}

/**
 * @param {Window} win
 * @returns {Array<{label: string, urls: string[]}>}
 */
function snapshotTabGroups(win) {
  return Array.from(win.gBrowser.tabGroups, group => ({
    label: group.label,
    urls: group.tabs.map(tab => tab.linkedBrowser.currentURI.spec),
  }));
}

/**
 * Checks that exactly one tab group exists and that it holds exactly the
 * expected URLs.
 *
 * @param {Array<{label: string, urls: string[]}>} groups
 * @param {string[]} expectedUrls
 * @returns {{ ok: boolean, reason: string }}
 */
function verifyGroupedExactly(groups, expectedUrls) {
  if (groups.length !== 1) {
    return {
      ok: false,
      reason: `expected 1 tab group, found ${groups.length}`,
    };
  }
  const actual = new Set(groups[0].urls);
  const expected = new Set(expectedUrls);
  const fileNames = urls =>
    [...urls].map(url => `"${url.split("/").pop()}"`).join(", ");
  const missing = expected.difference(actual);
  const unexpected = actual.difference(expected);
  if (missing.size || unexpected.size) {
    const parts = [];
    if (missing.size) {
      parts.push(`missing ${fileNames(missing)}`);
    }
    if (unexpected.size) {
      parts.push(`unexpected ${fileNames(unexpected)}`);
    }
    return { ok: false, reason: parts.join("; ") };
  }
  return { ok: true, reason: `grouped as "${groups[0].label}"` };
}

/**
 * Checks that exactly one tab group exists, that it holds every required
 * catalog tab and that it holds nothing outside required and optional.
 * Catalog tabs carry their id in the `id` query parameter.
 *
 * @param {Array<{label: string, urls: string[]}>} groups
 * @param {string[]} required - Catalog ids that must be grouped.
 * @param {string[]} optional - Catalog ids that may be grouped.
 * @returns {{ ok: boolean, reason: string }}
 */
function verifyGroupedCatalogTabs(groups, required, optional) {
  // Imported here: only the tests that list the catalog as a support file
  // call this.
  const { TAB_CATALOG, catalogIdForUrl } = ChromeUtils.importESModule(
    "chrome://mochitests/content/browser/browser/components/aiwindow/models/tests/browser_eval/data/tab_catalog.sys.mjs"
  );
  if (groups.length !== 1) {
    return {
      ok: false,
      reason: `expected 1 tab group, found ${groups.length}`,
    };
  }
  const grouped = groups[0].urls.map(catalogIdForUrl);
  const describe = ids =>
    ids.map(id => `"${TAB_CATALOG[id]?.title ?? id}"`).join(", ");
  const missing = required.filter(id => !grouped.includes(id));
  const extra = grouped.filter(
    id => !required.includes(id) && !optional.includes(id)
  );
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) {
      parts.push(`missing ${describe(missing)}`);
    }
    if (extra.length) {
      parts.push(`should not include ${describe(extra)}`);
    }
    return { ok: false, reason: parts.join("; ") };
  }
  const optionalIncluded = grouped.filter(id => optional.includes(id));
  return {
    ok: true,
    reason:
      `grouped as "${groups[0].label}"` +
      (optionalIncluded.length
        ? `, including optional ${describe(optionalIncluded)}`
        : ""),
  };
}

/**
 * Shuffles a copy of `items` with a seeded generator, so the order looks
 * random but is the same on every run.
 *
 * @param {Array} items
 * @param {number} seed
 * @returns {Array}
 */
function seededShuffle(items, seed) {
  // mulberry32
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Labels a failed chat request as an infrastructure problem (MLPA, auth,
 * network) or an unexpected product error.
 *
 * @param {Error} error
 * @returns {{ kind: "infra" | "product", reason: string, rateLimited: boolean }}
 */
function describeChatError(error) {
  const status = error.status ?? 0;
  // MLPA error codes, see ERROR_TELEMETRY_NAME_BY_CODE in ai-window.mjs. All
  // but 3 (context too large) are budget, rate limit or edge blocks.
  const mlpaCode = error.error ?? error.metadata?.errorMessage;
  const rateLimited = [2, 5, 6].includes(mlpaCode) || status === 429;
  const isInfra =
    [1, 2, 4, 5, 6, 7].includes(mlpaCode) ||
    status === 401 ||
    status === 403 ||
    status === 429 ||
    status >= 500 ||
    ["connectionFailure", "offline", "fxaTokenUnavailable"].includes(
      error.clientReason
    ) ||
    openAIEngine.isRetryableError(error);
  return {
    kind: isInfra ? "infra" : "product",
    rateLimited,
    reason: `chat request failed (status ${status}, reason ${error.clientReason ?? "none"}, MLPA code ${mlpaCode ?? "none"})${error.message ? `: ${error.message}` : ""}`,
  };
}
