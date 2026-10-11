import { MfpClient, foodId, unwrapFood } from "./mfp.ts";

// Run on a machine that can reach MyFitnessPal. No session value is printed.
const client = new MfpClient();
const results: Record<string, string> = {};
const run = async (name: string, action: () => Promise<unknown>) => {
  try { await action(); results[name] = "ok"; }
  catch (error) { results[name] = error instanceof Error ? error.message : "failed"; }
};

await run("session", () => client.account());
if (results.session !== "ok") {
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
await run("my_foods", () => client.ownFoods());
await run("diary", () => client.diary(today));
await run("food_search", async () => {
  const foods = await client.search("banana");
  if (!foods.length) throw new Error("Food search returned no results for banana");
  await client.food(String(foods[0]!.id));
  results.get_food = "ok";
});
await run("my_meals", () => client.get("/api/services/users/meals/mine"));
await run("food_settings", () => client.get("/api/services/account/diary_settings"));
await run("daily_note", () => client.get(`/api/services/diary/read_notes?date=${today}&note_type=food`));
await run("nutrition_goals", () => client.get("/api/services/nutrient-goals"));
await run("recent_foods", () => client.topFoods(today, today, "recent"));
await run("frequent_foods", () => client.topFoods(today, today, "frequent"));
await run("water", () => client.get(`/api/services/diary/read_water?date=${today}`));
await run("measurements", () => client.get("/api/user-measurements/measurements"));

if (process.argv.includes("--write")) {
  const name = `NutriPal temporary check ${crypto.randomUUID()}`;
  let createdId: string | undefined;
  let entryId: string | undefined;
  let entryMayExist = false;
  try {
    const created = await client.createFood({ name, calories: 123, protein: 4,
      carbohydrates: 20, fat: 3, serving_amount: 1, serving_unit: "serving" });
    createdId = foodId(created);
    results.create_food = "ok";
    const own = await client.ownFoods(name);
    if (!own.some((food: any) => String(food?.id) === createdId)) throw new Error("Created food did not appear in My Foods");
    results.verify_my_foods = "ok";
    await run("update_my_food", async () => {
      const changedName = `${name} edited`;
      const updated = await client.updateOwnFood(createdId!, { name: changedName, calories: 124,
        protein: 5, serving_amount: 2, serving_unit: "g" });
      const food = updated.food as any;
      if (food.description !== changedName || Number(food.nutritional_contents?.energy?.value) !== 124
        || Number(food.nutritional_contents?.protein) !== 5
        || Number(food.serving_sizes?.[0]?.value) !== 2 || food.serving_sizes?.[0]?.unit !== "g") {
        throw new Error("Food edit was accepted but one or more fields did not change");
      }
    });
    try {
      const logged = await client.logFood({ food_id: createdId, date: today, meal_position: 0, servings: 1 });
      entryMayExist = true;
      const first = Array.isArray(logged) ? logged[0] : (logged as any)?.items?.[0] ?? (logged as any)?.item ?? logged;
      if (first?.id) entryId = String(first.id);
      if (!entryId) throw new Error("Diary entry was created but returned no ID; check today's diary for the temporary food");
      const saved = unwrapFood(await client.get(`/api/services/diary/${encodeURIComponent(entryId)}`));
      if (String((saved.food as any)?.id) !== createdId || Number(saved.servings) !== 1) {
        throw new Error("Diary entry was returned but could not be verified");
      }
      results.log_food = "ok";
      await run("update_diary_entry", async () => {
        await client.updateDiaryEntry(entryId!, 2);
        const updated = unwrapFood(await client.get(`/api/services/diary/${encodeURIComponent(entryId!)}`));
        if (Number(updated.servings) !== 2) throw new Error("Diary edit was accepted but servings did not change");
      });
    } catch (error) {
      results.log_food = error instanceof Error ? error.message : "failed";
    }
  } catch (error) {
    results.write_check = error instanceof Error ? error.message : "failed";
    if (!createdId) {
      try {
        const matches = await client.ownFoods(name);
        const exact = matches.find((food: any) => food?.description === name);
        if (exact?.id) createdId = String(exact.id);
      } catch { /* Keep the original failure and report the name below. */ }
    }
  } finally {
    if (entryId) {
      try { await client.deleteDiaryEntry(entryId); results.diary_cleanup = "ok"; entryMayExist = false; }
      catch (error) {
        results.diary_cleanup = `failed for entry ID ${entryId}: ${error instanceof Error ? error.message : "unknown error"}`;
      }
    }
    if (entryMayExist) {
      results.cleanup = `Diary entry may remain on ${today}. Search for '${name}' and remove it before deleting the food.`;
    } else if (createdId) {
      try { await client.deleteOwnFood(createdId); results.cleanup = "ok"; }
      catch (error) {
        results.cleanup = `failed for food ID ${createdId}: ${error instanceof Error ? error.message : "unknown error"}`;
      }
    } else {
      results.cleanup = `No food ID returned; search My Foods for '${name}' before retrying`;
    }
  }
}

console.log(JSON.stringify(results, null, 2));
if (Object.values(results).some((value) => value !== "ok")) process.exitCode = 1;
