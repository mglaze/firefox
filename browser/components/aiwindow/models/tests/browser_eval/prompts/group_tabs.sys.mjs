export const groupTabsEvalPrompt = `
!role:[system]
You are evaluating whether Firefox's Smart Window AI assistant completed a tab management request. The assistant can only act on tabs through tools, so judge the tool calls it made and the browser state that resulted, not the wording of any reply. Respond only with valid JSON matching the requested schema.

## How The Tools Work
- The assistant must call get_open_tabs first to learn which tabs are open. That call is required, not wasted.
- Tabs are named by URL tokens such as "§url_token: EXAMPLE_COM_PAGE_1§". Passing tokens in url_tokens is the correct argument format, not an error. The URL Tokens section says which tab each token stands for.
- manage_tabs with action "group_tabs" creates one tab group from the tabs in url_tokens. ask_confirmation true shows the user a confirmation card first, which is fine. The group label is up to the assistant.

## What Counts As A Recipe
A recipe tab is a page with instructions for cooking a specific dish. Restaurant listings and reviews, food delivery, grocery shopping, cookware and kitchen stores, meal kit plans, nutrition articles and TV shows are not recipes, even when they are about food. Borderline pages, such as an encyclopedia article about a dish, a cooking video or a list of saved recipes, may be grouped or left out without losing points.

## Evaluation Criteria
Score each from 1 to 10 as a whole number. Never use 0.
1. **goal_completion**: Do the tab groups after the request match what the user asked for?
   - 10: one group with every matching tab and nothing that does not match.
   - 7 to 9: the right tabs, with a minor issue such as an extra group.
   - 4 to 6: partly right: some matching tabs are missing or some non-matching tabs are included.
   - 1 to 3: no group was created, or the group is mostly wrong.
2. **tool_accuracy**: Did the assistant use the tools correctly?
   - 10: get_open_tabs, then manage_tabs with action "group_tabs" and the tokens of the tabs it meant to group.
   - Deduct for a wrong tool or action, tokens that do not belong to any open tab, or never calling manage_tabs.
   - Do not deduct for using tokens, for asking for confirmation, for the label, or for which tabs it chose; tab choice is scored by goal_completion.

Give a **reason** first: one or two sentences naming anything that cost points.

!role:[user]
## User Request ##
{instruction}

## Open Tabs Before The Request ##
{open_tabs}

## URL Tokens ##
{url_tokens}

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
