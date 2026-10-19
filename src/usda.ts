import { MfpClient, MfpError, type FoodSpec } from "./mfp.ts";

const FDC_BASE = process.env.USDA_FDC_API_BASE || "https://api.nal.usda.gov/fdc/v1";
const SEARCH_PAGE_SIZE = 20;
const SOURCE = "USDA FoodData Central";
const nutrientIds = {
  calories: [2048, 2047, 1008], protein: [1003], fat: [1004], carbohydrates: [1005],
  fiber: [1079], sugar: [2000], sodium: [1093], potassium: [1092],
} as const;

function nutrient(rows: any[], ids: readonly number[], detailed = false): number | undefined {
  for (const id of ids) {
    const row = rows.find((entry: any) => Number(detailed ? entry?.nutrient?.id : entry?.nutrientId) === id);
    const value = Number(detailed ? row?.amount : row?.value);
    if (row && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

async function fdc(path: string) {
  const base = FDC_BASE.endsWith("/") ? FDC_BASE : `${FDC_BASE}/`;
  const url = new URL(path.replace(/^\//, ""), base);
  url.searchParams.set("api_key", process.env.USDA_API_KEY || "DEMO_KEY");
  let response: Response;
  try { response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) }); }
  catch { throw new MfpError("USDA FoodData Central request failed", undefined, "USDA_UNAVAILABLE"); }
  if (!response.ok) throw new MfpError(`USDA FoodData Central returned HTTP ${response.status}`,
    response.status, "USDA_UNAVAILABLE", response.status === 429 ? "Set USDA_API_KEY to a personal data.gov API key" : undefined);
  try { return await response.json() as any; }
  catch { throw new MfpError("USDA FoodData Central returned invalid JSON", undefined, "USDA_UNAVAILABLE"); }
}

export async function searchFood(client: MfpClient, query: string, page = 0) {
  let existing: Awaited<ReturnType<MfpClient["search"]>> = [];
  try { existing = await client.search(query, page); }
  catch (error) {
    if (!(error instanceof MfpError) || error.code !== "SEARCH_UNAVAILABLE") throw error;
  }
  if (existing.length && existing[0]?.source === "myfitnesspal_catalog") return existing;
  const path = `foods/search?${new URLSearchParams({ query, pageNumber: String(page + 1),
    pageSize: String(SEARCH_PAGE_SIZE) })}`;
  let result: any;
  try { result = await fdc(path); }
  catch (error) { if (existing.length) return existing; throw error; }
  if (!Array.isArray(result?.foods)) throw new MfpError("USDA FoodData Central changed its search response",
    undefined, "USDA_UNAVAILABLE");
  const usda = result.foods.flatMap((food: any) => {
    if (!Number.isInteger(food?.fdcId) || typeof food?.description !== "string") return [];
    const rows = Array.isArray(food.foodNutrients) ? food.foodNutrients : [];
    const calories = nutrient(rows, nutrientIds.calories);
    const protein = nutrient(rows, nutrientIds.protein);
    const fat = nutrient(rows, nutrientIds.fat);
    const carbohydrates = nutrient(rows, nutrientIds.carbohydrates);
    if ([calories, protein, fat, carbohydrates].some((value) => value === undefined)) return [];
    return [{ id: `usda:${food.fdcId}`, name: food.description,
      brand: food.brandName || food.brandOwner || SOURCE, verified: false,
      nutrition: { energy: { unit: "calories", value: calories }, protein, fat, carbohydrates,
        fiber: nutrient(rows, nutrientIds.fiber), sugar: nutrient(rows, nutrientIds.sugar),
        sodium: nutrient(rows, nutrientIds.sodium), potassium: nutrient(rows, nutrientIds.potassium) },
      servings: [{ value: 100, unit: "g", nutrition_multiplier: 1, gram_weight: 100 }],
      source: "usda_fdc" as const, source_url: `https://fdc.nal.usda.gov/food-details/${food.fdcId}/nutrients`,
      data_type: food.dataType, import_required: true }];
  });
  const q = query.trim().toLowerCase();
  usda.sort((a: any, b: any) => {
    const score = (food: any) => (food.name.toLowerCase() === q ? 20 : food.name.toLowerCase().startsWith(q) ? 10 : 0)
      + (/raw/i.test(food.name) && !/raw/i.test(q) ? 5 : 0)
      + (food.data_type === "Branded" ? 0 : 8);
    return score(b) - score(a);
  });
  return [...existing, ...usda];
}

export async function importUsdaFood(client: MfpClient, fdcId: number) {
  if (!Number.isSafeInteger(fdcId) || fdcId <= 0) throw new MfpError("USDA FDC ID must be a positive integer");
  const data = await fdc(`food/${fdcId}`);
  if (data?.fdcId !== fdcId || typeof data.description !== "string" || !Array.isArray(data.foodNutrients))
    throw new MfpError("USDA FoodData Central returned an invalid food record", undefined, "USDA_UNAVAILABLE");
  const rows = data.foodNutrients;
  const calories = nutrient(rows, nutrientIds.calories, true);
  const protein = nutrient(rows, nutrientIds.protein, true);
  const fat = nutrient(rows, nutrientIds.fat, true);
  const carbohydrates = nutrient(rows, nutrientIds.carbohydrates, true);
  if ([calories, protein, fat, carbohydrates].some((value) => value === undefined))
    throw new MfpError("USDA food lacks complete calories and macronutrients per 100 g", undefined, "USDA_INCOMPLETE");
  const name = `${data.description} (USDA FDC ${fdcId})`;
  const existing = (await client.ownFoods(name)).find((food: any) =>
    food?.description === name && food?.brand_name === SOURCE);
  if (existing?.id !== undefined) return { food: existing, created: false, source_url: `https://fdc.nal.usda.gov/food-details/${fdcId}/nutrients` };
  const optional = (key: "fiber" | "sugar" | "sodium" | "potassium") => nutrient(rows, nutrientIds[key], true);
  const spec: FoodSpec = { name, brand: SOURCE, calories: calories!, protein: protein!, fat: fat!,
    carbohydrates: carbohydrates!, serving_amount: 100, serving_unit: "g",
    ...(optional("fiber") !== undefined ? { fiber: optional("fiber") } : {}),
    ...(optional("sugar") !== undefined ? { sugar: optional("sugar") } : {}),
    ...(optional("sodium") !== undefined ? { sodium: optional("sodium") } : {}),
    ...(optional("potassium") !== undefined ? { potassium: optional("potassium") } : {}) };
  return { food: await client.createFood(spec), created: true,
    source_url: `https://fdc.nal.usda.gov/food-details/${fdcId}/nutrients` };
}
