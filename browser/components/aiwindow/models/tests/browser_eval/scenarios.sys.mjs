/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Scenarios for the Smart Window E2E evals. No Firefox dependencies, so
 * rejudge_saved_run.py can load them with Node too.
 *
 * A scenario:
 * - id, title, instruction: what the test sends from the sidebar.
 * - tier: "basic" runs first as the smoke check; "advanced" runs only for
 *   models that pass it.
 * - tabs: URLs opened in order; the last one is selected.
 * - expectedUrls, optionalUrls (and required/optional catalog ids for catalog
 *   scenarios): what the browser check accepts.
 * - judge: how the LLM judge scores it.
 *   - criteria: plain-language rules for which items the request covers.
 *   - dimensions: keys of JUDGE_DIMENSIONS in prompts/judge.sys.mjs.
 *   - summary: the dimension shown in report summaries.
 *   - tools: names of the Smart Window tools the scenario uses, whose
 *     definitions the judge sees.
 */

import { TAB_CATALOG, catalogIdForUrl } from "./data/tab_catalog.sys.mjs";

const E2E_PAGES =
  "https://example.com/browser/browser/components/tabbrowser/test/browser/smarttabgrouping/performance/data/e2e/";
const EVAL_PAGES =
  "https://example.com/browser/browser/components/aiwindow/models/tests/browser_eval/pages/";
const LASAGNA = E2E_PAGES + "lasagna.html";
const COOKIES = EVAL_PAGES + "cookie_recipe.html";
const FLIGHTS = E2E_PAGES + "flights.html";

const RECIPE_CRITERIA =
  "A recipe tab is a page with instructions for cooking a specific dish. " +
  "Restaurant listings and reviews, food delivery, grocery shopping, cookware " +
  "and kitchen stores, meal kit plans, nutrition articles and TV shows are " +
  "not recipes, even when they are about food. Borderline pages, such as an " +
  "encyclopedia article about a dish, a cooking video or a list of saved " +
  "recipes, may be grouped or left out.";

const GROUP_RECIPES_JUDGE = {
  criteria: RECIPE_CRITERIA,
  dimensions: ["goal_completion", "tool_accuracy"],
  summary: "goal_completion",
  tools: ["get_open_tabs", "manage_tabs"],
};

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
 * @param {string} id - A key of TAB_CATALOG.
 * @returns {string} URL of a page titled with the catalog title. Everything
 *   the model could use as a hint is in the query string, which Smart Window
 *   leaves out of URL tokens.
 */
function catalogTabUrl(id) {
  const encode = text =>
    encodeURIComponent(text).replace(
      /[!'()*]/g,
      char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
  return `${EVAL_PAGES}tab.sjs?id=${encode(id)}&title=${encode(TAB_CATALOG[id].title)}`;
}

/**
 * @param {string} url
 * @returns {string} The catalog title for catalog URLs, else the file name.
 */
export function plannedTabTitle(url) {
  const entry = TAB_CATALOG[catalogIdForUrl(url)];
  return entry ? entry.title : url.split("/").at(-1);
}

/**
 * Builds a scenario from catalog ids. Tabs are shuffled with a fixed seed so
 * the order looks realistic but is the same on every run; `selected` is
 * opened last so it is the selected tab.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {string} options.title
 * @param {string} options.instruction
 * @param {number} options.seed
 * @param {string[]} options.required - Catalog ids that must be grouped.
 * @param {string[]} options.optional - Catalog ids that may be grouped.
 * @param {string[]} options.distractors - Catalog ids that must not be grouped.
 * @param {string} options.selected - A distractor id to select.
 * @param {object} options.judge - See the scenario description above.
 * @returns {object} A scenario.
 */
function catalogScenario({
  id,
  title,
  instruction,
  seed,
  required,
  optional,
  distractors,
  selected,
  judge,
}) {
  const others = [...required, ...optional, ...distractors].filter(
    tabId => tabId !== selected
  );
  const order = [...seededShuffle(others, seed), selected];
  return {
    id,
    title,
    instruction,
    tier: "advanced",
    tabs: order.map(catalogTabUrl),
    required,
    optional,
    expectedUrls: required.map(catalogTabUrl),
    optionalUrls: optional.map(catalogTabUrl),
    judge,
  };
}

/**
 * Basic scenarios pass when exactly one group holds exactly `expectedUrls`;
 * catalog scenarios pass when one group holds every `required` tab and
 * nothing outside `required` and `optional`.
 */
export const SCENARIOS = [
  {
    id: "group-tabs-basic",
    tier: "basic",
    title: "Smart Window AI Quality: group recipe tabs",
    instruction: "Group my recipe tabs",
    tabs: [LASAGNA, COOKIES, FLIGHTS],
    expectedUrls: [LASAGNA, COOKIES],
    judge: GROUP_RECIPES_JUDGE,
  },
  {
    // Food and cooking pages that are not recipes, mixed in between the
    // recipes, so the model has to tell "recipe" apart from "food-related".
    id: "group-tabs-near-miss",
    tier: "advanced",
    title: "Smart Window AI Quality: group recipe tabs among food-related tabs",
    instruction: "Group my food related recipe tabs",
    tabs: [
      LASAGNA,
      EVAL_PAGES + "pizza_restaurants.html",
      COOKIES,
      EVAL_PAGES + "cookware_shop.html",
      FLIGHTS,
    ],
    expectedUrls: [LASAGNA, COOKIES],
    judge: GROUP_RECIPES_JUDGE,
  },
  catalogScenario({
    id: "group-tabs-made-up-brands",
    title: "Smart Window AI Quality: group recipe tabs, all made-up brands",
    instruction: "Group my recipe tabs",
    seed: 101,
    required: ["rec-f01", "rec-f03", "rec-f07"],
    optional: ["amb-f01"],
    distractors: [
      "nm-f01",
      "nm-f02",
      "nm-f03",
      "nm-f04",
      "trv-f01",
      "wrk-f01",
      "dev-f01",
      "fin-f01",
    ],
    selected: "wrk-f01",
    judge: GROUP_RECIPES_JUDGE,
  }),
  catalogScenario({
    // The only made-up brand is a required recipe, to see whether the model
    // leans on recognizing brands.
    id: "group-tabs-real-brands-one-made-up",
    title:
      "Smart Window AI Quality: group recipe tabs, real brands and one made-up",
    instruction: "Group my recipe tabs",
    seed: 202,
    required: ["rec-r01", "rec-r03", "rec-f05"],
    optional: ["amb-r02"],
    distractors: [
      "nm-r01",
      "nm-r02",
      "nm-r04",
      "nm-r07",
      "trv-r01",
      "wrk-r02",
      "shp-r01",
      "spt-r01",
    ],
    selected: "trv-r01",
    judge: GROUP_RECIPES_JUDGE,
  }),
  catalogScenario({
    id: "group-tabs-mixed-unrelated",
    title: "Smart Window AI Quality: group recipe tabs among unrelated tabs",
    instruction: "Group my recipe tabs",
    seed: 303,
    required: ["rec-r02", "rec-f02", "rec-r06"],
    optional: [],
    distractors: [
      "trv-r02",
      "trv-f03",
      "shp-f01",
      "wrk-r01",
      "wrk-r03",
      "dev-r02",
      "nws-r02",
      "spt-f01",
      "ent-r01",
    ],
    selected: "wrk-r01",
    judge: GROUP_RECIPES_JUDGE,
  }),
];
