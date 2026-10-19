import { afterEach, expect, test } from "bun:test";
import { MfpClient, type FoodSpec } from "../src/mfp.ts";
import { searchFood, importUsdaFood } from "../src/usda.ts";

const originalFetch = globalThis.fetch;
const originalCookie = process.env.MFP_COOKIE;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCookie === undefined) delete process.env.MFP_COOKIE;
  else process.env.MFP_COOKIE = originalCookie;
});

test("catalog failure searches USDA and returns source IDs and per-100-g nutrients", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.hostname === "api.nal.usda.gov") {
      expect(url.pathname).toBe("/fdc/v1/foods/search");
      expect(url.searchParams.get("query")).toBe("banana");
      return Response.json({ foods: [{ fdcId: 2709224, description: "Banana, raw",
        dataType: "Survey (FNDDS)", foodNutrients: [
          { nutrientId: 1008, value: 97 }, { nutrientId: 1003, value: 0.74 },
          { nutrientId: 1004, value: 0.28 }, { nutrientId: 1005, value: 22.7 },
        ] }] });
    }
    if (url.pathname === "/api/nutrition") return Response.json({ items: [] }, { status: 404 });
    if (url.pathname === "/api/services/users/foods/mine") return Response.json({ items: [] });
    throw new Error(`Unexpected path ${url.pathname}`);
  }) as typeof fetch;
  const foods = await searchFood(new MfpClient(), "banana");
  expect(foods).toMatchObject([{ id: "usda:2709224", name: "Banana, raw", source: "usda_fdc",
    import_required: true, nutrition: { energy: { value: 97 }, protein: 0.74 },
    servings: [{ unit: "g", value: 100 }] }]);
});

test("USDA import maps per-100-g nutrients to a private food and reuses an exact match", async () => {
  let created: FoodSpec | undefined;
  let existing: any[] = [];
  const client = { ownFoods: async () => existing,
    createFood: async (spec: FoodSpec) => { created = spec; return { id: "mfp-banana", description: spec.name }; } } as unknown as MfpClient;
  globalThis.fetch = (async () => Response.json({ fdcId: 2709224, description: "Banana, raw",
    foodNutrients: [
      { nutrient: { id: 1008 }, amount: 97 }, { nutrient: { id: 1003 }, amount: 0.74 },
      { nutrient: { id: 1004 }, amount: 0.28 }, { nutrient: { id: 1005 }, amount: 22.7 },
      { nutrient: { id: 1079 }, amount: 1.7 },
    ] })) as unknown as typeof fetch;
  const first = await importUsdaFood(client, 2709224);
  expect(first.created).toBe(true);
  expect(created).toMatchObject({ name: "Banana, raw (USDA FDC 2709224)", calories: 97,
    carbohydrates: 22.7, fiber: 1.7, serving_amount: 100, serving_unit: "g" });
  existing = [{ id: "mfp-banana", description: created!.name, brand_name: "USDA FoodData Central" }];
  created = undefined;
  const second = await importUsdaFood(client, 2709224);
  expect(second.created).toBe(false);
  expect(created).toBeUndefined();
});

test("USDA import refuses incomplete nutrition", async () => {
  const client = {} as MfpClient;
  globalThis.fetch = (async () => Response.json({ fdcId: 1, description: "Incomplete",
    foodNutrients: [{ nutrient: { id: 1008 }, amount: 10 }] })) as unknown as typeof fetch;
  await expect(importUsdaFood(client, 1)).rejects.toMatchObject({ code: "USDA_INCOMPLETE" });
});
