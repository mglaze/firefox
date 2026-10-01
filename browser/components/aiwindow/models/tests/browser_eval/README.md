# `browser_eval` Get Started (temporary README)
## **How to run the tests**
- Use a Firefox build from the spike branch, `mglaze/smartwindow-e2e-tab-grouping-spike`. It isn't landed yet, and an artifact build works. After pulling, run `./mach build faster`.
- (Temporary while running locally for the spike) Get an FxA token. In a normally launched Release Firefox, signed in with Smart Window, open the Browser Console (Cmd+Shift+J) and run:
  ```js
  await (async () => {
    const { getFxAccountsSingleton } = ChromeUtils.importESModule("resource://gre/modules/FxAccounts.sys.mjs");
    const { OAUTH_CLIENT_ID, SCOPE_SMART_WINDOW, SCOPE_PROFILE_UID } = ChromeUtils.importESModule("resource://gre/modules/FxAccountsCommon.sys.mjs");
    const fxa = getFxAccountsSingleton();
    const options = { scope: [SCOPE_SMART_WINDOW, SCOPE_PROFILE_UID], client_id: OAUTH_CLIENT_ID };
    await fxa.removeCachedOAuthToken({ token: await fxa.getOAuthToken(options) });
    return fxa.getOAuthToken(options);
  })();
  ```
- In your terminal, from the repo root:
  ```
  export MOZ_FXA_BEARER_TOKEN='<token>'
  export MOZ_EVAL_JUDGE_SERVICE_TYPE=ai
  unset MOZ_MLPA_AUTHORIZATION_TOKEN
  ```
- Run the tests and the judge:
  ```
  ./mach eval browser/components/aiwindow/models/tests/browser_eval/browser_eval_e2e_group_tabs.js -- \
    --headless --setpref=network.socket.allowed_nonlocal_domains=mlpa-prod-prod-mozilla.freetls.fastly.net \
    > artifacts/eval.log 2>&1
  ```
- A full run takes about 6-7 minutes and about 1M tokens, capped at 1.5M.
- For a smaller run, set one of these first:
  - `SMARTWINDOW_E2E_SCENARIOS=group-tabs-basic` for the smoke check only;
  - `SMARTWINDOW_E2E_MODEL_CHOICES=1,3` for some models only (1 gemini, 2 qwen, 3 mistral);
  - `SMARTWINDOW_E2E_ATTEMPTS=3` for fewer attempts.
- Tokens expire after a few hours. If every attempt fails with a 401, get a new token.

## **How to view the reports**
- Open `artifacts/smartwindow-e2e-rollup-<date>.html` in Firefox. The log line `Roll-up written to …` gives the exact path.
- Click a scenario name, or "View failures", to open its detailed report.
- Judge scores load from `smartwindow-e2e-judge-<date>.js` in the same folder, so keep the files together.
- The reports work on desktop and phone.

## **How to understand the reports**
- **Headline:** the overall answer, for example "Investigate: model. 2 of 3 models need attention, including the default model."
- **Model table:** each model's verdict, how many attempts passed, and its most common problem.
- **Verdicts:**
  - Healthy: 80% or more passed, with no browser failures.
  - Investigate: model: the model made mistakes (Models team).
  - Investigate: browser: Firefox didn't do what the model asked (Firefox front end).
  - Inconclusive: mostly backend errors.
  - Not run: skipped.
- **Hot spots:** the scenarios with the most failures, and which models failed them.
- **Scenarios by model:** each scenario's verdict per model. On a phone, these show as red, amber or green blocks.
- **Judge scores:** an LLM's second opinion, scored 1 to 10. They don't change the verdict. "Not calibrated" means the judge disagrees with the browser check too often to trust in summaries.
- **Help:** tap any pill marked **?** for a quick explanation, or use the blue **How to read** button for the full guide.

## **How the tests are run**
- `./mach eval` starts mozperftest, which runs the test as a normal Firefox mochitest.
- Firefox opens a real Smart Window, loads tabs, and types the request into the sidebar, such as "Group my recipe tabs". The real chat model answers through prod MLPA, using your token.
- Each model runs a short smoke check first. Models that fail it skip the harder scenarios.
- The test then checks the browser itself: is there exactly one tab group, with exactly the right tabs?
- After Firefox exits, an LLM judge scores each attempt. The scores are added to the reports.
- `./mach test` with the same arguments skips the judge. That's useful for quick checks, but judge scores show as "pending".
- The code lives in `browser/components/aiwindow/models/tests/browser_eval/`:
  - `scenarios.sys.mjs`: what's tested;
  - `browser_eval_e2e_group_tabs.js`: how it runs;
  - `report.sys.mjs`: the reports;
  - `prompts/judge.sys.mjs`: the judge.