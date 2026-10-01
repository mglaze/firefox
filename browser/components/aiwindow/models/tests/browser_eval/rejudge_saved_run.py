# Any copyright is dedicated to the Public Domain.
# http://creativecommons.org/publicdomain/zero/1.0/

"""Re-judge a saved Smart Window E2E run with the current judge prompt.

Use it to calibrate the judge before trusting it on a new scenario, and after
any change to prompts/judge.sys.mjs or a scenario's judge criteria. It prints,
per scenario, how often the judge agrees with the browser check: a pass should
score 5 or more on the scenario's summary dimension and a failure 4 or less.
Reports hide a scenario's judge scores below 90% agreement.

Run from the repo root with MOZ_FXA_BEARER_TOKEN set, using the Python that
has the openai package (mach's common virtualenv):

  MOZ_EVAL_JUDGE_SERVICE_TYPE=ai <common venv>/bin/python \\
    browser/components/aiwindow/models/tests/browser_eval/rejudge_saved_run.py \\
    2026-09-29T18-44

The argument is the run's timestamp, as in its roll-up and judge results file
names (smartwindow-e2e-rollup-<run>.json), or a unique prefix of it.
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

EVAL_DIR = os.path.dirname(os.path.abspath(__file__))
TOPSRCDIR = os.path.abspath(os.path.join(EVAL_DIR, *[".."] * 6))
sys.path.insert(0, os.path.join(TOPSRCDIR, "toolkit", "components", "ml", "eval"))
import evals  # noqa: E402

AGREEMENT_GATE = 0.9
JUDGED_RESULTS = ("pass", "model")

# Builds judge payloads with the same modules the test uses. Attempts saved
# before the test recorded judgeInput are rebuilt from their fields and the
# scenario's current judge block.
NODE_BUILDER = """
const [{ SCENARIOS, plannedTabTitle }, { buildJudgePayload }] = await Promise.all([
  import(process.env.EVAL_DIR + "/scenarios.sys.mjs"),
  import(process.env.EVAL_DIR + "/prompts/judge.sys.mjs"),
]);
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}
const { items, fallbackTools } = JSON.parse(input);
const out = items.map(({ id, baseId, judge: savedJudge, instruction, attempt }) => {
  const judge = savedJudge || SCENARIOS.find(s => s.id === baseId).judge;
  let judgeInput = attempt.judgeInput;
  if (!judgeInput) {
    const titles = new Map(attempt.openTabs.map(tab => [tab.url, tab.title]));
    const titleFor = url => titles.get(url) || plannedTabTitle(url);
    judgeInput = {
      instruction,
      criteria: judge.criteria,
      dimensions: judge.dimensions,
      toolDefinitions: (fallbackTools[baseId] || []),
      stateBefore: { label: "Open tabs", data: attempt.openTabs.map(tab => tab.title) },
      urlTokens: (attempt.urlTokens || []).map(({ token, url }) => ({
        token: "§url_token: " + token + "§",
        tab: titleFor(url),
      })),
      toolCalls: attempt.toolCalls,
      stateAfter: {
        label: "Tab groups",
        data: attempt.groups.map(g => ({ label: g.label, tabs: g.urls.map(titleFor) })),
      },
    };
  }
  return { id, summary: judge.summary, dimensions: judgeInput.dimensions, ...buildJudgePayload(judgeInput) };
});
console.log(JSON.stringify(out));
"""


def base_id(report):
    """The scenario id without its mode, e.g. for a full page variant."""
    return report.get("baseId") or re.sub(r"-fullpage$", "", report["id"])


def load_results_script(path):
    text = open(path, encoding="utf-8").read()
    return json.loads(text[text.index("=") + 1 :].strip().rstrip(";"))


def agrees(result, score):
    return score >= 5 if result == "pass" else score <= 4


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("run", help="The run's timestamp, e.g. 2026-09-29T18-44-34")
    parser.add_argument("--artifacts", default=os.path.join(TOPSRCDIR, "artifacts"))
    parser.add_argument(
        "--judge-model",
        help="Judge with this MLPA model instead of LlmJudge's default, to compare judges.",
    )
    args = parser.parse_args()

    # The roll-up lists the run's scenario reports, which are named by when
    # each scenario finished rather than by the run.
    rollups = glob.glob(
        os.path.join(args.artifacts, f"smartwindow-e2e-rollup-{args.run}*.json")
    )
    if not rollups:
        sys.exit(f"No roll-up for {args.run} in {args.artifacts}")
    report_paths = [
        os.path.join(args.artifacts, name.replace(".html", ".json"))
        for name in json.load(open(rollups[0], encoding="utf-8"))["reports"]
    ]
    reports = [
        json.load(open(path, encoding="utf-8"))
        for path in report_paths
        if os.path.exists(path)
    ]
    if not reports:
        sys.exit(f"No scenario reports for {args.run} in {args.artifacts}")

    # Older runs did not save tool definitions; use the newest report that has
    # them for each scenario.
    fallback_tools = {}
    for path in sorted(
        glob.glob(os.path.join(args.artifacts, "smartwindow-e2e-*.json")),
        key=os.path.getmtime,
    ):
        report = json.load(open(path, encoding="utf-8"))
        if report.get("judgeTools"):
            fallback_tools[base_id(report)] = report["judgeTools"]

    old = {}
    for path in glob.glob(
        os.path.join(args.artifacts, f"smartwindow-e2e-judge-{args.run}*.js")
    ):
        old.update(load_results_script(path))

    items, outcomes = [], {}
    for report in reports:
        for attempt in report["attempts"]:
            if attempt["result"] not in JUDGED_RESULTS:
                continue
            key = f"{report['id']}|{attempt['modelChoice']}|{attempt['attempt']}"
            items.append({
                "id": key,
                "baseId": base_id(report),
                "judge": report.get("judge"),
                "instruction": report["instruction"],
                "attempt": attempt,
            })
            outcomes[key] = (report["id"], attempt)
    if not items:
        sys.exit(f"No judged attempts (passes or model failures) in {args.run}")
    missing_tools = {
        i["baseId"] for i in items if not i["attempt"].get("judgeInput")
    } - set(fallback_tools)
    if missing_tools:
        print(
            "Warning: no saved tool definitions for "
            + ", ".join(sorted(missing_tools))
            + "; run the test once (an offline ./mach test run is enough) to save them."
        )

    built = json.loads(
        subprocess.check_output(
            ["node", "--input-type=module", "-e", NODE_BUILDER],
            input=json.dumps({"items": items, "fallbackTools": fallback_tools}),
            text=True,
            env={**os.environ, "EVAL_DIR": EVAL_DIR},
        )
    )
    results_path = os.path.join(tempfile.mkdtemp(), "rejudge-results.js")
    payloads = [
        {
            "id": b["id"],
            "results_script": results_path,
            "messages": b["messages"],
            "response_format": b["response_format"],
        }
        for b in built
    ]
    print(f"Re-judging {len(payloads)} attempts...")
    config = {"model": args.judge_model} if args.judge_model else {}
    judge = evals.LlmJudge(lambda message: None, config)
    print(f"Judge model: {judge.model}")
    judge.run(payloads)
    new = load_results_script(results_path)
    summary_of = {b["id"]: b["summary"] for b in built}

    print("\nAgreement with the browser check (summary dimension):")
    for scenario in sorted({s for s, _ in outcomes.values()}):
        keys = [k for k, (s, _) in outcomes.items() if s == scenario and k in new]
        for label, scores in (("old", old), ("new", new)):
            judged = [k for k in keys if k in scores]
            if not judged:
                continue
            agree = sum(
                agrees(outcomes[k][1]["result"], scores[k][summary_of[k]])
                for k in judged
            )
            rate = agree / len(judged)
            flag = (
                ""
                if rate >= AGREEMENT_GATE
                else "  <- under the gate, hidden in summaries"
            )
            print(f"  {scenario:40} {label}: {agree}/{len(judged)} ({rate:.0%}){flag}")

    print("\nDisagreements with the new prompt:")
    shown = 0
    for key in sorted(new):
        result = outcomes[key][1]["result"]
        score = new[key][summary_of[key]]
        if not agrees(result, score):
            shown += 1
            print(
                f"  {key}: browser {result}, judge {summary_of[key]} {score}: {new[key]['reason']}"
            )
    if not shown:
        print("  none")

    out_of_range = [
        k
        for k, r in new.items()
        if any(not 1 <= v <= 10 for v in r.values() if isinstance(v, int))
    ]
    print(f"\nOut of range scores: {', '.join(out_of_range) or 'none'}")
    print(f"New results: {results_path}")


if __name__ == "__main__":
    main()
