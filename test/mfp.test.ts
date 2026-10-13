import { afterAll, afterEach, expect, test } from "bun:test";
import { MfpClient, MfpError, saveSession, listProfiles } from "../src/mfp.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
const originalCookie = process.env.MFP_COOKIE;
const originalProfile = process.env.MFP_PROFILE;
const originalDataDir = process.env.MFP_DATA_DIR;
const testDataDir = await mkdtemp(join(tmpdir(), "nutripal-test-"));
process.env.MFP_DATA_DIR = testDataDir;

afterAll(async () => {
  await rm(testDataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.MFP_DATA_DIR;
  else process.env.MFP_DATA_DIR = originalDataDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCookie === undefined) delete process.env.MFP_COOKIE;
  else process.env.MFP_COOKIE = originalCookie;
  if (originalProfile === undefined) delete process.env.MFP_PROFILE;
  else process.env.MFP_PROFILE = originalProfile;
  process.env.MFP_DATA_DIR = testDataDir;
});

test("named sessions stay isolated and list_profiles never returns cookies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nutripal-profiles-"));
  try {
    process.env.MFP_DATA_DIR = dir;
    process.env.MFP_PROFILE = "home";
    process.env.MFP_COOKIE = "env-home";
    await saveSession("disk-home", "home");
    await saveSession("disk-work", "work");
    const cookies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      cookies.push(new Headers(init?.headers).get("cookie") ?? "");
      return Response.json({ id: "user" });
    }) as typeof fetch;
    await Promise.all([new MfpClient().account(), new MfpClient(undefined, "work").account()]);
    expect(cookies).toContain("__Secure-next-auth.session-token=env-home");
    expect(cookies).toContain("__Secure-next-auth.session-token=disk-work");
    const profiles = await listProfiles();
    expect(profiles.map((entry) => entry.profile)).toEqual(["home", "work"]);
    expect(profiles.every((entry) => entry.valid && entry.last_verified)).toBe(true);
    expect(JSON.stringify(profiles)).not.toContain("disk-work");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("legacy session is the default only when no named default exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nutripal-legacy-"));
  try {
    process.env.MFP_DATA_DIR = dir;
    delete process.env.MFP_COOKIE;
    await writeFile(join(dir, "session"), "legacy-token");
    const cookies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      cookies.push(new Headers(init?.headers).get("cookie") ?? "");
      return Response.json({ id: "user" });
    }) as typeof fetch;
    await new MfpClient(undefined, "default").account();
    await saveSession("new-token", "default");
    await new MfpClient(undefined, "default").account();
    expect(cookies).toEqual(["__Secure-next-auth.session-token=legacy-token",
      "__Secure-next-auth.session-token=new-token"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
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
    if (path === "/api/services/foods/food-123") return Response.json({ item: { id: "food-123",
      description: "Check food", nutritional_contents: { carbohydrates: 20 } } });
    return new Response(JSON.stringify({ items: [{ id: "food-123", description: "Check food" }] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const food = await new MfpClient().createFood({ name: "Check food", calories: 100, protein: 4,
    carbohydrates: 20, fat: 2, serving_amount: 1, serving_unit: "serving" });
  expect(food.id).toBe("food-123");
  expect(calls.map((call) => call.path)).toEqual(["/api/auth/csrf", "/api/services/foods", "/api/services/foods/food-123"]);
  expect(calls[1]?.cookie).toContain("__Host-next-auth.csrf-token=csrf-cookie");
  expect(calls[1]?.csrf).toBe("csrf-test");
  expect(calls[1]?.body.item.public).toBe(false);
});

test("parallel writes share the initial CSRF token and cookie", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  let csrfCalls = 0;
  const writes: { csrf: string | null; cookie: string | null }[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/auth/csrf") {
      csrfCalls++;
      return new Response(JSON.stringify({ csrfToken: "csrf-test" }), {
        headers: { "content-type": "application/json", "set-cookie": "__Host-next-auth.csrf-token=csrf-cookie; Path=/; Secure" },
      });
    }
    const headers = new Headers(init?.headers);
    writes.push({ csrf: headers.get("x-csrf-token"), cookie: headers.get("cookie") });
    return Response.json({ ok: true });
  }) as typeof fetch;

  const client = new MfpClient();
  await Promise.all([client.delete("/api/first"), client.delete("/api/second")]);
  expect(csrfCalls).toBe(1);
  expect(writes).toHaveLength(2);
  for (const write of writes) {
    expect(write.csrf).toBe("csrf-test");
    expect(write.cookie).toContain("__Host-next-auth.csrf-token=csrf-cookie");
  }
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
    if (path === "/api/services/diary/read_diary") return json([{
      id: "entry-1", type: "food_entry", date: "2026-10-11", food: { id: "42" }, meal_position: 0,
      servings: 2, serving_size: { id: "extra", value: 100, unit: "g" },
    }]);
    throw new Error(`Unexpected path ${path}`);
  }) as typeof fetch;
  const result = await new MfpClient().logFood({ food_id: "42", date: "2026-10-11", meal_position: 0, servings: 2 });
  expect(result.persisted).toBe(true);
  expect(submitted.items[0].food).toEqual({ id: "42", version: "42" });
  expect(submitted.items[0].serving_size).toEqual({ unit: "g", value: 100, nutrition_multiplier: 1 });
});

test("serving labels match normalized value and unit, and an unknown amount lists all options", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  let submitted: any;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/services/foods/42") return Response.json({ item: { id: "42", serving_sizes: [
      { id: "small", value: 100, unit: "ml", nutrition_multiplier: 1 },
      { id: "large", value: 250, unit: "ml", nutrition_multiplier: 2.5 },
    ] } });
    if (path === "/api/auth/csrf") return Response.json({ csrfToken: "csrf-test" });
    if (path === "/api/services/diary") { submitted = JSON.parse(String(init?.body)); return Response.json({ items: [{ id: "entry-1" }] }); }
    if (path === "/api/services/diary/read_diary") return Response.json([]);
    throw new Error(`Unexpected ${path}`);
  }) as typeof fetch;
  const client = new MfpClient();
  const result = await client.logFood({ food_id: "42", date: "2026-10-11", meal_position: 0,
    servings: 1, serving_unit: " 100   ML " });
  expect(result.serving).toEqual({ id: "small", value: 100, unit: "ml", servings: 1 });
  expect(result).toMatchObject({ persisted: false, diary_entry_id: "entry-1" });
  expect(submitted.items[0].serving_size.value).toBe(100);
  await expect(client.logFood({ food_id: "42", date: "2026-10-11", meal_position: 0,
    servings: 1, serving_value: 200, serving_unit: "ml" })).rejects.toThrow('"id":"small","value":100,"unit":"ml"');
  await expect(client.logFood({ food_id: "42", date: "2026-10-11", meal_position: 0,
    servings: 1, serving_unit: "ml" })).rejects.toThrow("ambiguous");
});

test("net carbohydrate input is converted to explicit total and net output", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  let nutrition: any;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/auth/csrf") return Response.json({ csrfToken: "csrf-test" });
    if (path === "/api/services/foods" && init?.method === "POST") {
      nutrition = JSON.parse(String(init.body)).item.nutritional_contents;
      return Response.json({ item: { id: "food-net" } });
    }
    if (path === "/api/services/foods/food-net") return Response.json({ item: { id: "food-net", nutritional_contents: nutrition } });
    throw new Error(`Unexpected ${path}`);
  }) as typeof fetch;
  const client = new MfpClient();
  await client.createFood({ name: "Net food", calories: 100, protein: 1, carbohydrates: 32,
    carbohydrate_basis: "net", fiber: 9, fat: 1, serving_amount: 1, serving_unit: "serving" });
  expect(nutrition.carbohydrates).toBe(41);
  expect(await client.foodDetails("food-net")).toMatchObject({ carbohydrates: 41, net_carbs: 32,
    fiber: 9, carbohydrate_basis: "net" });
});

test("diary deletion reads back the affected date", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  let deleted = false;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/auth/csrf") return Response.json({ csrfToken: "csrf-test" });
    if (path === "/api/services/diary/entry-1" && init?.method === "DELETE") { deleted = true; return Response.json({}); }
    if (path === "/api/services/diary/entry-1") return Response.json({ item: { id: "entry-1", date: "2026-10-11" } });
    if (path === "/api/services/diary/read_diary") return Response.json(deleted ? [] : [{ id: "entry-1" }]);
    throw new Error(`Unexpected ${path}`);
  }) as typeof fetch;
  expect(await new MfpClient().deleteDiaryEntry("entry-1")).toMatchObject({ persisted: true,
    entry: null, diary_entry_id: "entry-1" });
});

test("failed diary read-back retains the ID returned by logging", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/services/foods/42") return Response.json({ item: { id: "42",
      serving_sizes: [{ value: 1, unit: "serving", nutrition_multiplier: 1 }] } });
    if (path === "/api/auth/csrf") return Response.json({ csrfToken: "csrf-test" });
    if (path === "/api/services/diary") return Response.json({ items: [{ id: "entry-1" }] });
    if (path === "/api/services/diary/read_diary") return new Response(null, { status: 503 });
    throw new Error(`Unexpected ${path}`);
  }) as typeof fetch;
  const result = await new MfpClient().logFood({ food_id: "42", date: "2026-10-11", meal_position: 0, servings: 1 });
  expect(result).toMatchObject({ persisted: false, diary_entry_id: "entry-1", code: "UPSTREAM_ERROR" });
});

test("authenticated redirects have a stale-session code and profile hint", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: "/login" } })) as unknown as typeof fetch;
  try { await new MfpClient(undefined, "work", true).food("42"); throw new Error("Expected a redirect error"); }
  catch (error) {
    expect(error).toBeInstanceOf(MfpError);
    expect((error as MfpError).code).toBe("MFP_SESSION_STALE");
    expect((error as MfpError).hint).toBe("re-run auth for profile work");
  }
});

test("food search uses the Next.js data route and encoded params", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    if (url.pathname === "/") {
      expect(new Headers(init?.headers).get("cookie")).toBeNull();
      return new Response('<script id="__NEXT_DATA__">{"buildId":"test-build"}</script>');
    }
    expect(url.pathname).toBe("/_next/data/test-build/food/calorie-chart-nutrition-facts.json");
    expect(JSON.parse(url.searchParams.get("params")!)).toEqual(["banana & pear", 2]);
    expect(new Headers(init?.headers).get("cookie")).toContain("synthetic-session");
    return Response.json({ pageProps: { dehydratedState: { queries: [{
      queryKey: ["food", "banana & pear", 2],
      state: { data: { items: [{ item: { id: "banana-1", description: "Banana", brand_name: "Generic" } }] } },
    }] } } });
  }) as typeof fetch;

  const foods = await new MfpClient().search("banana & pear", 2);
  expect(foods[0]).toMatchObject({ id: "banana-1", name: "Banana" });
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe("/");
});

test("food search reports a redirected data request as a stale website session", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  globalThis.fetch = (async (input) => new URL(String(input)).pathname === "/"
    ? new Response('"buildId":"test-build"')
    : new Response(null, { status: 302, headers: { location: "/account/logout" } })) as typeof fetch;
  await expect(new MfpClient(undefined, "work", true).search("banana")).rejects.toMatchObject({
    code: "MFP_SESSION_STALE", hint: "re-run auth for profile work",
  });
});

test("food search reports a Next.js redirect embedded in a 200 response as a stale session", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  globalThis.fetch = (async (input) => new URL(String(input)).pathname === "/"
    ? new Response('"buildId":"test-build"')
    : Response.json({ pageProps: { __N_REDIRECT: "/account/logout", __N_REDIRECT_STATUS: 307 } })) as typeof fetch;
  await expect(new MfpClient().search("banana")).rejects.toMatchObject({
    code: "MFP_SESSION_STALE", status: 307, hint: "re-run auth for profile default",
  });
});

test("food search rejects generic chart data instead of reporting no matches", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  globalThis.fetch = (async (input) => new URL(String(input)).pathname === "/"
    ? new Response('"buildId":"test-build"')
    : Response.json({ pageProps: { dehydratedState: { queries: [] } } })) as typeof fetch;
  await expect(new MfpClient().search("banana")).rejects.toThrow("changed its food search response");
});

test("diary edit preserves the existing meal and returns the updated entry", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  let body: any;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/auth/csrf") return Response.json({ csrfToken: "csrf-test" });
    if (path === "/api/services/diary/entry-1") {
      if (init?.method === "PUT") { body = JSON.parse(String(init?.body)); return Response.json({ items: [{ id: "entry-1" }] }); }
      return Response.json({ item: { id: "entry-1", servings: body ? 2 : 1, meal_position: 0 } });
    }
    throw new Error(`Unexpected path ${path}`);
  }) as typeof fetch;
  const result = await new MfpClient().updateDiaryEntry("entry-1", 2);
  expect(body).toEqual({ item: { id: "entry-1", servings: 2, meal_position: 0 } });
  expect(result.entry).toMatchObject({ id: "entry-1", meal_position: 0, servings: 2 });
});

test("diary edit refuses to move an entry when its meal is unknown", async () => {
  process.env.MFP_COOKIE = "synthetic-session";
  let writes = 0;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "PUT") writes++;
    return Response.json({ item: { id: "entry-1", servings: 1 } });
  }) as typeof fetch;
  await expect(new MfpClient().updateDiaryEntry("entry-1", 2)).rejects.toThrow("meal position to preserve");
  expect(writes).toBe(0);
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
