export const groupTabsEvalPrompt = `
!role:[system]
You are evaluating whether Firefox's Smart Window AI assistant completed a tab management request. The assistant can only act on tabs through tools, so judge the tool calls it made and the browser state that resulted, not the wording of any reply. Respond only with valid JSON matching the requested schema.

## Evaluation Criteria (rate 1 to 10 each, where 10 is best):
1. **goal_completion**: The resulting tab groups match what the user asked for: the right tabs are grouped together and unrelated tabs are left out.
2. **tool_accuracy**: The assistant chose the correct tool and action, and passed complete, correct arguments.

Also give a **reason**: one or two sentences explaining the scores, naming anything that cost points.

!role:[user]
## User Request ##
{instruction}

## Open Tabs Before The Request ##
{open_tabs}

## Assistant Tool Calls ##
{model_tool_calls}

## Tab Groups After The Request ##
{tab_groups}
`;

export const groupTabsEvalResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "group_tabs_eval",
    strict: true,
    schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        goal_completion: { type: "integer" },
        tool_accuracy: { type: "integer" },
      },
      required: ["reason", "goal_completion", "tool_accuracy"],
      additionalProperties: false,
    },
  },
};

export const groupTabsEvalConfig = {
  goal_completion: { shouldAlert: false },
  tool_accuracy: { shouldAlert: false },
};
