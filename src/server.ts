import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { MfpClient, MfpError, foodId, type FoodSpec } from "./mfp.ts";

const client = new MfpClient();
const server = new McpServer({ name: "nutripal-mcp", version: "0.1.0" }, {
  instructions: "Use search_food or list_my_foods to find a food ID before logging it. Creating a food saves it to MyFitnessPal; it does not log it unless create_and_log_food is called. Dates use YYYY-MM-DD. Nutrition values are per specified serving."
});

const date = z.iso.date().describe("Diary date in YYYY-MM-DD format");
const id = z.union([z.string().min(1), z.number().int().positive()]).transform(String);
const nonnegative = z.number().finite().nonnegative();
const positive = z.number().finite().positive();
const foodFields = {
  name: z.string().trim().min(1).max(200),
  brand: z.string().trim().max(100).optional(),
  calories: nonnegative, protein: nonnegative, carbohydrates: nonnegative, fat: nonnegative,
  serving_amount: positive.default(1), serving_unit: z.string().trim().min(1).max(50).default("serving"),
  country_code: z.string().length(2).default("US").describe("US treats carbohydrates as total carbs; some EU countries treat them as net carbs"),
  fiber: nonnegative.optional(), sugar: nonnegative.optional(), sodium: nonnegative.optional(),
  saturated_fat: nonnegative.optional(), cholesterol: nonnegative.optional(), potassium: nonnegative.optional(),
};
const meal = z.number().int().min(0).max(5).describe("Meal position: 0 breakfast, 1 lunch, 2 dinner, 3 snacks, 4/5 extra meals if configured");

function reply(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }; }
function error(value: unknown) { return { isError: true, content: [{ type: "text" as const,
  text: value instanceof MfpError ? value.message : "Unexpected error while processing MyFitnessPal data" }] }; }
function register<T extends z.ZodRawShape>(name: string, description: string, shape: T,
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>, destructive = false) {
  server.registerTool(name, { description, inputSchema: z.object(shape),
    annotations: { readOnlyHint: !destructive, destructiveHint: destructive } },
  async (args) => { try { return reply(await handler(args as z.infer<z.ZodObject<T>>)); } catch (e) { return error(e); } });
}

register("check_session", "Check whether the saved MyFitnessPal session works", {}, async () => client.account());
register("get_diary", "Read food diary entries for a date", { date }, async ({ date }) => client.diary(date));
register("get_diary_range", "Read diary data across a date range of up to 31 days", {
  from: date, to: date,
}, async ({ from, to }) => {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days = Math.round((end - start) / 86_400_000) + 1;
  if (days < 1 || days > 31) throw new MfpError("Date range must contain 1 to 31 days");
  const entries = [];
  for (let offset = 0; offset < days; offset++) {
    const current = new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
    entries.push({ date: current, diary: await client.diary(current) });
  }
  return entries;
});
register("get_daily_note", "Read the food diary note for a date", { date },
  async ({ date }) => client.get(`/api/services/diary/read_notes?date=${encodeURIComponent(date)}&note_type=food`));
register("get_nutrition_goals", "Read current account nutrition goals", {},
  async () => client.get("/api/services/nutrient-goals"));
register("search_food", "Search the MyFitnessPal food catalog and return exact IDs and serving options", {
  query: z.string().trim().min(2), page: z.number().int().min(0).max(20).default(0),
}, async ({ query, page }) => client.search(query, page));
register("get_food", "Read nutrition and serving sizes for a food ID", { food_id: id }, async ({ food_id }) => client.food(food_id));
register("list_my_foods", "List private foods you created, including foods absent from public search", {
  search: z.string().default("") }, async ({ search }) => client.ownFoods(search));
register("create_food", "Create a private custom food in your MyFitnessPal account. Nutrition is per serving.", foodFields,
  async (args) => client.createFood(args as FoodSpec), true);
register("update_my_food", "Edit a private food in My Foods by exact ID. Provide only the fields to change.", {
  food_id: id,
  name: foodFields.name.optional(), brand: foodFields.brand,
  calories: nonnegative.optional(), protein: nonnegative.optional(), carbohydrates: nonnegative.optional(), fat: nonnegative.optional(),
  serving_amount: positive.optional(), serving_unit: z.string().trim().min(1).max(50).optional(),
  country_code: z.string().length(2).optional(), fiber: nonnegative.optional(), sugar: nonnegative.optional(),
  sodium: nonnegative.optional(), saturated_fat: nonnegative.optional(), cholesterol: nonnegative.optional(), potassium: nonnegative.optional(),
}, async ({ food_id, ...changes }) => client.updateOwnFood(food_id, changes), true);

register("log_food", "Log an exact food ID and serving to the diary", {
  food_id: id, date, meal_position: meal, servings: positive.default(1), serving_unit: z.string().optional(),
}, (args) => client.logFood(args), true);

register("create_and_log_food", "Create a private custom food, then log it to the diary. If logging fails, the created food ID is returned for recovery.", {
  ...foodFields, date, meal_position: meal, servings: positive.default(1),
}, async (args) => {
  const created = await client.createFood(args as FoodSpec);
  const newId = foodId(created);
  try { return { created, diary_entry: await client.logFood({ food_id: newId, date: args.date,
    meal_position: args.meal_position, servings: args.servings }) }; }
  catch (e) { return { created, diary_error: e instanceof Error ? e.message : "Diary write failed",
    recovery: `The food was created as ID ${newId}. Use log_food with that ID; do not create it again.` }; }
}, true);

register("update_diary_entry", "Change the serving count of a diary entry by its exact ID", {
  entry_id: id, servings: positive }, async ({ entry_id, servings }) => client.updateDiaryEntry(entry_id, servings), true);
register("delete_diary_entry", "Delete a diary entry by its exact ID", { entry_id: id },
  async ({ entry_id }) => client.deleteDiaryEntry(entry_id), true);
register("delete_my_food", "Delete a custom food you own by its exact ID", { food_id: id },
  async ({ food_id }) => client.deleteOwnFood(food_id), true);
register("list_my_meals", "List meals saved in My Meals", {},
  async () => client.ownMeals());
register("delete_my_meal", "Delete a saved meal by its exact ID", { meal_id: id },
  async ({ meal_id }) => client.deleteOwnMeal(meal_id), true);
register("list_recent_foods", "List recently or frequently logged foods over a date range", {
  from: date, to: date, list: z.enum(["recent", "frequent"]).default("recent"),
}, async ({ from, to, list }) => client.topFoods(from, to, list));
register("get_food_settings", "Read food diary settings, including meal labels", {},
  async () => client.get("/api/services/account/diary_settings"));
register("get_water", "Read water logged on a date", { date },
  async ({ date }) => client.get(`/api/services/diary/read_water?date=${encodeURIComponent(date)}`));
register("log_water", "Set water intake for a date, using cups or milliliters", {
  date, value: nonnegative, units: z.enum(["cups", "milliliters"]).default("milliliters"),
}, async ({ date, value, units }) => client.post("/api/services/diary/water", { date, value, units }), true);
register("get_measurements", "Read account body measurements such as weight", {},
  async () => client.get("/api/user-measurements/measurements"));
register("log_weight", "Create or update a weight measurement for a date", {
  date, value: positive, unit: z.enum(["kg", "lbs"]).default("kg"),
}, async ({ date, value, unit }) => client.request("/api/user-measurements/measurements", {
  method: "PUT", body: JSON.stringify({ items: [{ type: "Weight", date, value, unit }] }) }, true), true);

await server.connect(new StdioServerTransport());
