import { createInterface } from "node:readline/promises";
import { MfpClient, unwrapFood } from "./mfp.ts";

const args = process.argv.slice(2);
const query = args[0];
const grams = Number(args[1]);
const dateFlag = args.indexOf("--date");
const mealFlag = args.indexOf("--meal");
const date = dateFlag >= 0 ? args[dateFlag + 1] : localDate();
const meal = mealFlag >= 0 ? args[mealFlag + 1]?.toLowerCase() : "snacks";
const positions: Record<string, number> = { breakfast: 0, lunch: 1, dinner: 2, snacks: 3, snack: 3 };

if (!query || !Number.isFinite(grams) || grams <= 0 || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !meal || positions[meal] === undefined) {
  console.error("Usage: bun run log-by-weight -- <food name> <grams> [--date YYYY-MM-DD] [--meal breakfast|lunch|dinner|snacks]");
  process.exit(2);
}

const client = new MfpClient();
await client.account();
let matches = await client.search(query);
if (!matches.length) {
  const mine = await client.ownFoods(query);
  matches = mine.map((food: any) => ({ id: food.id, name: food.description, brand: food.brand_name,
    verified: food.verified, servings: food.serving_sizes, nutrition: food.nutritional_contents }));
}
if (!matches.length) throw new Error(`No foods found for '${query}'`);

const normalizedQuery = query.toLowerCase();
const score = (food: typeof matches[number]) => {
  const name = food.name.toLowerCase();
  const brand = (food.brand ?? "").toLowerCase();
  const gramSize = food.servings?.some((size: any) => /^(g|gram|grams)$/i.test(String(size.unit)));
  return (name === normalizedQuery ? 100 : name.startsWith(normalizedQuery) ? 20 : 0)
    + (!brand || brand === "generic" ? 20 : 0)
    + ("verified" in food && food.verified ? 10 : 0)
    + (gramSize ? 5 : 0);
};
const choices = matches.map((food, index) => ({ food, index }))
  .sort((a, b) => score(b.food) - score(a.food) || a.index - b.index)
  .slice(0, 20).map(({ food }) => food);
console.log(`Choose the food to log (${grams} g on ${date}, ${meal}):`);
choices.forEach((food, index) => {
  const baseGrams = Number((food.nutrition as any)?.grams);
  const energy = Number((food.nutrition as any)?.energy?.value);
  const calories = baseGrams > 0 && Number.isFinite(energy) ? `, ${(energy / baseGrams * 100).toFixed(0)} kcal/100 g` : "";
  console.log(`${index + 1}. ${food.name} — ${food.brand || "Generic"}${calories} [${food.id}]`);
});
if (!process.stdin.isTTY) throw new Error("Food selection requires an interactive terminal");
const terminal = createInterface({ input: process.stdin, output: process.stdout });
let selection: number;
try { selection = Number(await terminal.question("Food number: ")); }
finally { terminal.close(); }
if (!Number.isInteger(selection) || selection < 1 || selection > choices.length) throw new Error("Invalid food number; nothing was logged");

const chosen = choices[selection - 1]!;
const details = unwrapFood(await client.food(String(chosen.id)));
const sizes = Array.isArray(details.serving_sizes) ? details.serving_sizes : [];
const gramSize = sizes.find((size: any) => /^(g|gram|grams)$/i.test(String(size.unit)) && Number(size.value) > 0);
if (!gramSize) throw new Error("This food has no gram serving size; nothing was logged. Choose another result.");
const servings = grams / Number(gramSize.value);
const result = await client.logFood({ food_id: String(chosen.id), date, meal_position: positions[meal]!,
  servings, serving_unit: String(gramSize.unit) });
const entry = Array.isArray(result) ? result[0] : (result as any)?.items?.[0] ?? (result as any)?.item ?? result;
console.log(JSON.stringify({ logged: true, date, meal, food: chosen.name, grams, servings,
  food_id: chosen.id, entry_id: entry?.id ?? null }, null, 2));

function localDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
