/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * The LLM judge for the Smart Window E2E evals, shared by every scenario.
 * Scenarios supply their own criteria and pick dimensions; the scale is the
 * same everywhere, so a browser-check failure lands at 4 or under. No Firefox
 * dependencies, so rejudge_saved_run.py can build the same prompt with Node.
 */

/**
 * Scores a scenario can ask the judge for. `label` and `description` are also
 * shown in the reports.
 */
export const JUDGE_DIMENSIONS = {
  goal_completion: {
    label: "Goal completion",
    description:
      "Did the end state match the request: every requested item handled and nothing else touched?",
    anchors: [
      "9 to 10: every requested item was handled and nothing else was touched.",
      "5 to 8: the right items, with a minor issue that does not change which items were affected, such as an extra step or an odd label.",
      "1 to 4: a requested item was missed, an item that should not be touched was affected, or nothing was done.",
    ],
  },
  tool_accuracy: {
    label: "Tool accuracy",
    description:
      "Did the assistant use the tools correctly: the right tools in a sensible order, with arguments valid per the tool definitions? Which items it chose is scored by goal completion.",
    anchors: [
      "9 to 10: the right tools in a sensible order, with arguments valid per the tool definitions.",
      "5 to 8: the right tools, with redundant or extra calls.",
      "1 to 4: a wrong tool or action, invalid arguments such as tokens that match no item, or a needed tool never called.",
    ],
  },
};

const json = value => JSON.stringify(value, null, 2);

/**
 * @param {object} input
 * @param {string} input.instruction - What the user asked.
 * @param {string} input.criteria - The scenario's success rules.
 * @param {string[]} input.dimensions - Keys of JUDGE_DIMENSIONS.
 * @param {object[]} input.toolDefinitions - Smart Window tool definitions,
 *   as in toolsConfig.
 * @param {{label: string, data: *}} input.stateBefore
 * @param {Array<{token: string, tab: string}>} input.urlTokens - What each URL
 *   token stands for.
 * @param {object[]} input.toolCalls - The assistant's tool calls.
 * @param {{label: string, data: *}} input.stateAfter
 * @returns {{messages: object[], response_format: object}}
 */
export function buildJudgePayload(input) {
  const scores = input.dimensions
    .map(key => {
      const { label, description, anchors } = JUDGE_DIMENSIONS[key];
      return [
        `**${key}** (${label}): ${description}`,
        ...anchors.map(anchor => `- ${anchor}`),
      ].join("\n");
    })
    .join("\n\n");
  const system = `You are evaluating whether Firefox's Smart Window AI assistant completed a user's request. The assistant can only act through tools, so judge the tool calls it made and the state that resulted, not the wording of any reply. Respond only with valid JSON matching the requested schema.

## Tools The Assistant Had
${json(input.toolDefinitions)}

Items such as tabs are named by URL tokens like "§url_token: EXAMPLE_COM_PAGE_1§". Passing tokens is the correct way to name them. The URL Tokens section says which item each token stands for.

## Success Criteria
${input.criteria}

## Scores
Score each from 1 to 10 as a whole number. Never use 0.

${scores}

Give a **reason** first: one or two sentences naming anything that cost points.`;
  const user = `## User Request
${input.instruction}

## Before The Request: ${input.stateBefore.label}
${json(input.stateBefore.data)}

## URL Tokens
${json(input.urlTokens)}

## Assistant Tool Calls
${json(input.toolCalls)}

## After The Request: ${input.stateAfter.label}
${json(input.stateAfter.data)}`;

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "smartwindow_e2e_judge",
        strict: true,
        schema: {
          type: "object",
          properties: {
            reason: { type: "string" },
            ...Object.fromEntries(
              input.dimensions.map(key => [key, { type: "integer" }])
            ),
          },
          required: ["reason", ...input.dimensions],
          additionalProperties: false,
        },
      },
    },
  };
}

/**
 * @param {string[]} dimensions
 * @returns {object} The eval_config for LlmJudge: informational, no alerts.
 */
export function judgeConfig(dimensions) {
  return Object.fromEntries(
    dimensions.map(key => [key, { shouldAlert: false }])
  );
}
