/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tabs the E2E evals can open. The model only sees a tab's title (and an
 * opaque URL token), so the title is the whole test signal.
 *
 * brand: "real" follows a real site's title format, "made-up" is fictional.
 * role, for the recipe grouping task: "recipe" should be grouped, "near-miss"
 * is food-related but must not be grouped, "ambiguous" may go either way and
 * "unrelated" must not be grouped.
 */
export const TAB_CATALOG = {
  // Recipes
  "rec-r01": {
    title: "Classic Beef Lasagna Recipe | Allrecipes",
    brand: "real",
    role: "recipe",
  },
  "rec-r02": {
    title: "The Best Chocolate Chip Cookies Recipe | Serious Eats",
    brand: "real",
    role: "recipe",
  },
  "rec-r03": {
    title: "Chicken Tikka Masala Recipe - NYT Cooking",
    brand: "real",
    role: "recipe",
  },
  "rec-r04": {
    title: "Easy Banana Bread Recipe - Food Network",
    brand: "real",
    role: "recipe",
  },
  "rec-r05": {
    title: "One-Pot Creamy Tuscan Chicken | Delish",
    brand: "real",
    role: "recipe",
  },
  "rec-r06": {
    title: "Vegetable Pad Thai Recipe - BBC Good Food",
    brand: "real",
    role: "recipe",
  },
  "rec-r07": {
    title: "Homemade Pizza Dough Recipe | King Arthur Baking",
    brand: "real",
    role: "recipe",
  },
  "rec-r08": {
    title: "Shakshuka Recipe - Bon Appétit",
    brand: "real",
    role: "recipe",
  },
  "rec-f01": {
    title: "Weeknight Garlic Butter Shrimp Pasta - CookHub",
    brand: "made-up",
    role: "recipe",
  },
  "rec-f02": {
    title: "Grandma's Apple Crumble | SimmerDaily Recipes",
    brand: "made-up",
    role: "recipe",
  },
  "rec-f03": {
    title: "Slow Cooker Beef Chili Recipe - PlatePath",
    brand: "made-up",
    role: "recipe",
  },
  "rec-f04": {
    title: "Crispy Baked Falafel with Tahini Sauce | The Hungry Ledger",
    brand: "made-up",
    role: "recipe",
  },
  "rec-f05": {
    title: "15-Minute Miso Ramen - Bowlful Kitchen",
    brand: "made-up",
    role: "recipe",
  },
  "rec-f06": {
    title: "Lemon Blueberry Muffins · Crumb & Co.",
    brand: "made-up",
    role: "recipe",
  },
  "rec-f07": {
    title: "Sheet-Pan Honey Mustard Salmon | Forkcast",
    brand: "made-up",
    role: "recipe",
  },
  "rec-f08": {
    title: "Mushroom Risotto (Step-by-Step) - Stove Notes",
    brand: "made-up",
    role: "recipe",
  },

  // Food-related, not recipes
  "nm-r01": {
    title: "Joe's Pizza - Greenwich Village - New York, NY - Yelp",
    brand: "real",
    role: "near-miss",
  },
  "nm-r02": {
    title:
      "Instant Pot Duo 7-in-1 Electric Pressure Cooker : Amazon.com: Home & Kitchen",
    brand: "real",
    role: "near-miss",
  },
  "nm-r03": {
    title: "Order Groceries Online for Delivery | Instacart",
    brand: "real",
    role: "near-miss",
  },
  "nm-r04": {
    title: "The 25 Best Restaurants in Chicago Right Now - Eater Chicago",
    brand: "real",
    role: "near-miss",
  },
  "nm-r05": {
    title: "Le Creuset Signature Round Dutch Oven | Williams Sonoma",
    brand: "real",
    role: "near-miss",
  },
  "nm-r06": {
    title: "Thai Food Delivery Near Me | DoorDash",
    brand: "real",
    role: "near-miss",
  },
  "nm-r07": {
    title: "The Bear (TV Series 2022– ) - IMDb",
    brand: "real",
    role: "near-miss",
  },
  "nm-f01": {
    title: "Best Brunch Spots in Austin, TX - TableScout Reviews",
    brand: "made-up",
    role: "near-miss",
  },
  "nm-f02": {
    title: "Chef's Knife Sets and Cookware - PanPantry Store",
    brand: "made-up",
    role: "near-miss",
  },
  "nm-f03": {
    title: "Weekly Meal Kit Plans & Pricing | FreshCrate",
    brand: "made-up",
    role: "near-miss",
  },
  "nm-f04": {
    title: "Is Olive Oil Healthy? What the Research Says - NutriLens",
    brand: "made-up",
    role: "near-miss",
  },
  "nm-f05": {
    title: "Tonight's Tasting Menu Reservations - SeatSaver",
    brand: "made-up",
    role: "near-miss",
  },
  "nm-f06": {
    title: "Top 10 Food Trucks in Portland - Street Bites Guide",
    brand: "made-up",
    role: "near-miss",
  },

  // Ambiguous
  "amb-r01": { title: "Lasagna - Wikipedia", brand: "real", role: "ambiguous" },
  "amb-r02": {
    title: "How to Make Perfect Lasagna Every Time - YouTube",
    brand: "real",
    role: "ambiguous",
  },
  "amb-r03": {
    title: "Easy Weeknight Dinner Ideas | Pinterest",
    brand: "real",
    role: "ambiguous",
  },
  "amb-f01": {
    title: "My Saved Recipes (24) - CookHub",
    brand: "made-up",
    role: "ambiguous",
  },
  "amb-f02": {
    title: "Knife Skills 101: Online Cooking Class - Kitchen Academy",
    brand: "made-up",
    role: "ambiguous",
  },

  // Travel
  "trv-r01": {
    title: "Cheap Flights from New York to Lisbon | Google Flights",
    brand: "real",
    role: "unrelated",
  },
  "trv-r02": {
    title: "Hotel Avenida Palace, Lisbon, Portugal - Booking.com",
    brand: "real",
    role: "unrelated",
  },
  "trv-r03": {
    title: "THE 15 BEST Things to Do in Lisbon (2026) - Tripadvisor",
    brand: "real",
    role: "unrelated",
  },
  "trv-r04": {
    title: "Lisbon Travel Guide - Lonely Planet",
    brand: "real",
    role: "unrelated",
  },
  "trv-r05": {
    title: "Cheap Car Rentals in Lisbon from $19/day - KAYAK",
    brand: "real",
    role: "unrelated",
  },
  "trv-f01": {
    title: "Round-trip Flights to Tokyo from $689 - FareFinch",
    brand: "made-up",
    role: "unrelated",
  },
  "trv-f02": {
    title: "Cozy Loft near Shibuya Station - StayNest",
    brand: "made-up",
    role: "unrelated",
  },
  "trv-f03": {
    title: "Kyoto in 3 Days: A First-Timer's Itinerary | Wanderly",
    brand: "made-up",
    role: "unrelated",
  },
  "trv-f04": {
    title: "Japan Rail Pass: Is It Worth It? - RailRoam",
    brand: "made-up",
    role: "unrelated",
  },

  // Shopping
  "shp-r01": {
    title: "Sony WH-1000XM5 Wireless Noise Canceling Headphones - Best Buy",
    brand: "real",
    role: "unrelated",
  },
  "shp-r02": {
    title: "Men's Trail Running Shoes | REI Co-op",
    brand: "real",
    role: "unrelated",
  },
  "shp-r03": {
    title: "Amazon.com: Kindle Paperwhite (16 GB)",
    brand: "real",
    role: "unrelated",
  },
  "shp-r04": {
    title: "KALLAX Shelf Unit, White - IKEA",
    brand: "real",
    role: "unrelated",
  },
  "shp-f01": {
    title: "Cart (3 items) - ShopCrate",
    brand: "made-up",
    role: "unrelated",
  },
  "shp-f02": {
    title: "Ergonomic Mesh Office Chair - DeskNest",
    brand: "made-up",
    role: "unrelated",
  },
  "shp-f03": {
    title: "Deals of the Day: Up to 60% Off Laptops | TechTote",
    brand: "made-up",
    role: "unrelated",
  },

  // Work
  "wrk-r01": {
    title: "Inbox (12) - alex@company.com - Gmail",
    brand: "real",
    role: "unrelated",
  },
  "wrk-r02": {
    title: "Q4 Planning - Google Docs",
    brand: "real",
    role: "unrelated",
  },
  "wrk-r03": {
    title: "PROJ-142: Fix login redirect loop - Jira",
    brand: "real",
    role: "unrelated",
  },
  "wrk-r04": {
    title: "Calendar - Week of October 5, 2026 - Outlook",
    brand: "real",
    role: "unrelated",
  },
  "wrk-r05": {
    title: "#eng-frontend | Acme Corp - Slack",
    brand: "real",
    role: "unrelated",
  },
  "wrk-f01": {
    title: "Sprint 42 Board - TaskForge",
    brand: "made-up",
    role: "unrelated",
  },
  "wrk-f02": {
    title: "OKRs 2026 H2 (Draft) - DocuLoom",
    brand: "made-up",
    role: "unrelated",
  },

  // Developer
  "dev-r01": {
    title: "Array.prototype.map() - JavaScript | MDN",
    brand: "real",
    role: "unrelated",
  },
  "dev-r02": {
    title:
      "How do I undo the most recent local commits in Git? - Stack Overflow",
    brand: "real",
    role: "unrelated",
  },
  "dev-r03": {
    title:
      "Add retry to fetch client by alexdev · Pull Request #1823 · acme/web-app · GitHub",
    brand: "real",
    role: "unrelated",
  },
  "dev-f01": {
    title: "Understanding React Server Components | DevNotes",
    brand: "made-up",
    role: "unrelated",
  },
  "dev-f02": {
    title: "Async Runtimes Compared - Stackhaven Forum",
    brand: "made-up",
    role: "unrelated",
  },

  // News, sports, entertainment, finance, health
  "nws-r01": {
    title: "Stocks Rise as Inflation Cools - Reuters",
    brand: "real",
    role: "unrelated",
  },
  "nws-r02": {
    title: "Local Elections 2026: What to Know - NPR",
    brand: "real",
    role: "unrelated",
  },
  "nws-f01": {
    title: "City Council Approves New Bike Lanes | The Daily Ledger",
    brand: "made-up",
    role: "unrelated",
  },
  "spt-r01": {
    title: "NBA Scores, Standings & Schedule - ESPN",
    brand: "real",
    role: "unrelated",
  },
  "spt-r02": {
    title: "Premier League Table 2026/27 - BBC Sport",
    brand: "real",
    role: "unrelated",
  },
  "spt-f01": {
    title: "Fantasy Football Week 5 Rankings - GridironPulse",
    brand: "made-up",
    role: "unrelated",
  },
  "ent-r01": {
    title: "Stranger Things | Netflix Official Site",
    brand: "real",
    role: "unrelated",
  },
  "ent-r02": {
    title: "lofi hip hop radio - beats to relax/study to - YouTube",
    brand: "real",
    role: "unrelated",
  },
  "ent-f01": {
    title: "Top 50 Indie Albums of the Year - SoundScope",
    brand: "made-up",
    role: "unrelated",
  },
  "fin-r01": {
    title: "Account Summary - Chase",
    brand: "real",
    role: "unrelated",
  },
  "fin-r02": {
    title: "Tesla, Inc. (TSLA) Stock Price, News & Quote - Yahoo Finance",
    brand: "real",
    role: "unrelated",
  },
  "fin-f01": {
    title: "Monthly Budget Planner - PennyPath",
    brand: "made-up",
    role: "unrelated",
  },
  "hlt-r01": {
    title: "Vitamin D Deficiency - Symptoms & Causes - Mayo Clinic",
    brand: "real",
    role: "unrelated",
  },
  "hlt-f01": {
    title: "5 Stretches for Lower Back Pain - FitLoop",
    brand: "made-up",
    role: "unrelated",
  },
};

/**
 * @param {string} url
 * @returns {string} The catalog id carried in the URL's `id` query parameter,
 *   or the URL itself for tabs that are not from the catalog.
 */
export function catalogIdForUrl(url) {
  return URL.parse(url)?.searchParams.get("id") ?? url;
}
