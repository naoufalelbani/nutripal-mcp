import { afterEach, expect, test } from "bun:test";
import { MfpClient } from "../src/mfp.ts";

const originalFetch = globalThis.fetch;
const originalCookie = process.env.MFP_COOKIE;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCookie === undefined) delete process.env.MFP_COOKIE;
  else process.env.MFP_COOKIE = originalCookie;
});

test("custom food creation carries the CSRF cookie and reads an items envelope", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  const calls: { path: string; cookie: string; csrf: string | null; body?: any }[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const headers = new Headers(init?.headers);
    calls.push({ path, cookie: headers.get("cookie") ?? "", csrf: headers.get("x-csrf-token"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/api/auth/csrf") return new Response(JSON.stringify({ csrfToken: "csrf-test" }), {
      headers: { "content-type": "application/json", "set-cookie": "__Host-next-auth.csrf-token=csrf-cookie; Path=/; Secure" },
    });
    return new Response(JSON.stringify({ items: [{ id: "food-123", description: "Check food" }] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const food = await new MfpClient().createFood({ name: "Check food", calories: 100, protein: 4,
    carbohydrates: 20, fat: 2, serving_amount: 1, serving_unit: "serving" });
  expect(food.id).toBe("food-123");
  expect(calls.map((call) => call.path)).toEqual(["/api/auth/csrf", "/api/services/foods"]);
  expect(calls[1]?.cookie).toContain("__Host-next-auth.csrf-token=csrf-cookie");
  expect(calls[1]?.csrf).toBe("csrf-test");
  expect(calls[1]?.body.item.public).toBe(false);
});

test("an HTML challenge cannot look like a successful API response", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  globalThis.fetch = (async () => new Response("<html>challenge</html>", {
    headers: { "content-type": "text/html" },
  })) as unknown as typeof fetch;
  expect(new MfpClient().ownFoods()).rejects.toThrow("web page instead of API data");
});

test("custom food edit uses the food version and owner", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  const patchBodies: unknown[] = [];
  let patchQuery = "";
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { "content-type": "application/json" },
    });
    if (path === "/api/services/users/foods/mine") return json({ items: [{ id: "42", description: "Owned" }] });
    if (path === "/api/services/foods/42" && init?.method === "PATCH") {
      patchBodies.push(JSON.parse(String(init.body)));
      patchQuery = url.search;
      return json({ id: "42" });
    }
    if (path === "/api/services/foods/42") return json({ item: { id: "42", description: "Owned",
      user_id: "user-1", version: "v2",
      nutritional_contents: { energy: { unit: "calories", value: patchBodies.length ? 120 : 100 }, protein: 2 },
      serving_sizes: [{ value: 1, unit: "serving" }] } });
    if (path === "/api/auth/csrf") return json({ csrfToken: "csrf-test" });
    throw new Error(`Unexpected path ${path}`);
  }) as typeof fetch;

  const result = await new MfpClient().updateOwnFood("42", { calories: 120 });
  expect(result.updated).toBe(true);
  expect(patchBodies).toHaveLength(1);
  expect(patchQuery).toBe("?version=v2");
  expect((patchBodies[0] as any).item.user_id).toBe("user-1");
  expect((patchBodies[0] as any).item.nutritional_contents.protein).toBe(2);
  expect((patchBodies[0] as any).item.nutritional_contents.energy.value).toBe(120);
});

test("diary logging sends the exact serving without extra catalog fields", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  let submitted: any;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const json = (value: unknown) => new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
    if (path === "/api/services/foods/42") return json({ item: { id: "42", serving_sizes: [
      { unit: "g", value: 100, nutrition_multiplier: 1, id: "extra", gram_weight: 100 },
    ] } });
    if (path === "/api/auth/csrf") return json({ csrfToken: "csrf-test" });
    if (path === "/api/services/diary") {
      submitted = JSON.parse(String(init?.body));
      return json({ items: [{ id: "entry-1" }] });
    }
    throw new Error(`Unexpected path ${path}`);
  }) as typeof fetch;
  await new MfpClient().logFood({ food_id: "42", date: "2026-10-11", meal_position: 0, servings: 2 });
  expect(submitted.items[0].food).toEqual({ id: "42", version: "42" });
  expect(submitted.items[0].serving_size).toEqual({ unit: "g", value: 100, nutrition_multiplier: 1 });
});

test("food search reads results embedded in the current search page", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  const paths: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      buildId: "test-build", props: { pageProps: { dehydratedState: { queries: [{
        state: { data: { items: [{ item: { id: "banana-1", description: "Banana", brand_name: "Generic" } }] } },
      }] } } },
    })}</script>`, { headers: { "content-type": "text/html" } });
  }) as typeof fetch;

  const foods = await new MfpClient().search("banana");
  expect(foods[0]).toMatchObject({ id: "banana-1", name: "Banana" });
  expect(paths).toEqual(["/food/calorie-chart-nutrition-facts/banana/0"]);
});

test("diary edit sends the minimal PUT item", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  let body: any;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/auth/csrf") return Response.json({ csrfToken: "csrf-test" });
    if (path === "/api/services/diary/entry-1") {
      body = JSON.parse(String(init?.body));
      return Response.json({ items: [{ id: "entry-1", servings: 2 }] });
    }
    throw new Error(`Unexpected path ${path}`);
  }) as typeof fetch;
  await new MfpClient().updateDiaryEntry("entry-1", 2);
  expect(body).toEqual({ item: { id: "entry-1", servings: 2 } });
});

test("diary read requests both meal totals and food entries", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  let path = "";
  globalThis.fetch = (async (input) => {
    path = new URL(String(input)).pathname + new URL(String(input)).search;
    return Response.json([]);
  }) as typeof fetch;
  await new MfpClient().diary("2026-10-11");
  expect(path).toBe("/api/services/diary/read_diary?date=2026-10-11&types=diary_meal%2Cfood_entry%2Cexercise_entry");
});

test("nutrition goal update preserves other fields and verifies saved targets", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const initialGoal = (day_of_week: string) => ({ day_of_week, group_id: 0,
    energy: { value: "1790", unit: "calories" }, protein: 89, carbohydrates: 200, fat: 60,
    assign_exercise_energy: "nutrient_goal" });
  let saved: any;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const json = (value: unknown) => Response.json(value);
    if (path === "/api/auth/csrf") return json({ csrfToken: "csrf-test" });
    if (path === "/api/services/nutrient-goals" && init?.method === "POST") {
      saved = JSON.parse(String(init.body)).item;
      return json({ item: saved });
    }
    if (path === "/api/services/nutrient-goals") {
      return json({ item: saved ?? { valid_from: "2026-01-01",
        daily_goals: weekdays.map(initialGoal), default_goal: initialGoal("default") } });
    }
    throw new Error(`Unexpected path ${path}`);
  }) as typeof fetch;

  const result = await new MfpClient().updateNutritionGoals({ calories: 1450, protein: 130 });
  expect(saved.daily_goals).toHaveLength(7);
  expect(saved.daily_goals[0]).toMatchObject({ energy: { value: "1450", unit: "calories" }, protein: 130,
    carbohydrates: 200, fat: 60, assign_exercise_energy: "nutrient_goal" });
  expect(result.updated).toBe(true);
  expect(result.daily_goals.every((goal: any) => goal.energy.value === "1450" && goal.protein === 130)).toBe(true);
});

test("timezone update preserves profile fields and verifies the saved timezone", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  let profile: any = { id: "user-1", username: "sample", location_preferences: { time_zone: "UTC", country_code: "MA" },
    unit_preferences: { weight: "kilograms" }, profiles: [{ type: "user" }] };
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/auth/csrf") return Response.json({ csrfToken: "csrf-test" });
    if (path === "/api/services/users" && init?.method === "PATCH") {
      const changes = JSON.parse(String(init.body)).item;
      profile = { ...profile, ...changes };
      return Response.json({ item: profile });
    }
    if (path === "/api/services/diary/profile") return Response.json(profile);
    throw new Error(`Unexpected path ${path}`);
  }) as typeof fetch;

  const result = await new MfpClient().updateAccountProfile({ timezone: "Africa/Casablanca" });
  expect(profile.location_preferences).toEqual({ time_zone: "Africa/Casablanca", country_code: "MA" });
  expect(result.updated).toBe(true);
});

test("recent foods are derived from diary entries", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  globalThis.fetch = (async () => Response.json([
    { type: "diary_meal", diary_meal: "Snacks" },
    { type: "food_entry", food: { id: "banana-1", description: "Banana" }, logged_at: "2026-10-11T12:00:00Z" },
    { type: "food_entry", food: { id: "banana-1", description: "Banana" }, logged_at: "2026-10-11T13:00:00Z" },
  ])) as unknown as typeof fetch;
  const result = await new MfpClient().topFoods("2026-10-11", "2026-10-11", "frequent");
  expect(result.items).toMatchObject([{ food_id: "banana-1", logs: 2 }]);
});
