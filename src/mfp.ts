import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "https://www.myfitnesspal.com";
const TOKEN_NAME = "__Secure-next-auth.session-token";
const dataDir = process.env.MFP_DATA_DIR || join(homedir(), ".config", "nutripal-mcp");

export class MfpError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export async function saveSession(value: string) {
  const cookie = normalizeCookie(value);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const file = join(dataDir, "session");
  await writeFile(file, cookie, { mode: 0o600 });
  await chmod(file, 0o600);
}

function normalizeCookie(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) throw new MfpError("Session cookie is empty or malformed");
  if (trimmed.startsWith(`${TOKEN_NAME}=`) || trimmed.includes(";")) return trimmed;
  return `${TOKEN_NAME}=${trimmed}`;
}

async function sessionCookie() {
  const fromEnv = process.env.MFP_COOKIE;
  if (fromEnv) return normalizeCookie(fromEnv);
  try { return normalizeCookie(await readFile(join(dataDir, "session"), "utf8")); }
  catch { throw new MfpError("No session. Set MFP_COOKIE or run `bun run auth`."); }
}

function safeError(body: unknown) {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  const found: string[] = [];
  const collect = (value: unknown, depth: number) => {
    if (depth > 3 || found.length >= 3) return;
    if (typeof value === "string" && value.trim() && !/eyJ[A-Za-z0-9_-]{40,}|__Secure-next-auth|Bearer\s/i.test(value)) {
      found.push(value.slice(0, 200));
    } else if (Array.isArray(value)) value.slice(0, 3).forEach((entry) => collect(entry, depth + 1));
    else if (value && typeof value === "object") {
      for (const entry of Object.values(value).slice(0, 8)) collect(entry, depth + 1);
    }
  };
  collect(b.error_details, 0);
  const generic = b.error_description ?? b.error ?? b.message;
  if (!found.length && b.error_details && typeof b.error_details === "object") {
    const keys = Object.keys(b.error_details).slice(0, 8);
    if (keys.length) found.push(`validation detail keys: ${keys.join(", ")}`);
  }
  if (!found.length && typeof generic === "string") found.push(generic.slice(0, 300));
  return found.join("; ");
}

export class MfpClient {
  private csrf?: string;
  private cookies = new Map<string, string>();
  constructor(private readonly providedCookie?: string) {}

  private async cookieHeader() {
    const base = this.providedCookie ? normalizeCookie(this.providedCookie) : await sessionCookie();
    return [base, ...[...this.cookies].map(([key, value]) => `${key}=${value}`)].join("; ");
  }

  private rememberCookies(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (separator > 0) this.cookies.set(pair!.slice(0, separator), pair!.slice(separator + 1));
    }
  }

  async request(path: string, init: RequestInit = {}, csrf = false): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new MfpError("Invalid API path");
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("user-agent", "NutriPal-MCP/0.1");
    if (init.body) headers.set("content-type", "application/json");
    if (csrf) headers.set("x-csrf-token", await this.csrfToken());
    headers.set("cookie", await this.cookieHeader());
    let response: Response;
    try {
      response = await fetch(BASE + path, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30000) });
    } catch { throw new MfpError("MyFitnessPal request failed. Check your network connection."); }
    this.rememberCookies(response);
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
      throw new MfpError("MyFitnessPal rejected the session or challenged this client. Refresh the browser session, then run `bun run auth` again.", response.status);
    }
    const contentType = response.headers.get("content-type") || "";
    if (response.ok && contentType.includes("html")) {
      throw new MfpError("MyFitnessPal returned a web page instead of API data. Your session may need a browser challenge.", response.status);
    }
    let body: unknown = null;
    if (contentType.includes("json")) {
      try { body = await response.json(); }
      catch { throw new MfpError("MyFitnessPal returned invalid JSON", response.status); }
    }
    if (!response.ok) throw new MfpError(`MyFitnessPal returned HTTP ${response.status}${safeError(body) ? `: ${safeError(body)}` : ""}`, response.status);
    return body;
  }

  private async csrfToken() {
    if (!this.csrf) {
      const result = await this.request("/api/auth/csrf") as { csrfToken?: string };
      if (!result?.csrfToken) throw new MfpError("MyFitnessPal did not provide a CSRF token");
      this.csrf = result.csrfToken;
    }
    return this.csrf;
  }

  get(path: string) { return this.request(path); }
  post(path: string, body: unknown) { return this.request(path, { method: "POST", body: JSON.stringify(body) }, true); }
  patch(path: string, body: unknown) { return this.request(path, { method: "PATCH", body: JSON.stringify(body) }, true); }
  put(path: string, body: unknown) { return this.request(path, { method: "PUT", body: JSON.stringify(body) }, true); }
  delete(path: string) { return this.request(path, { method: "DELETE" }, true); }

  async account() {
    const account = await this.get("/api/auth/session");
    if (!account || typeof account !== "object" || !Object.keys(account).length || (account as any).user === null) {
      throw new MfpError("MyFitnessPal session is empty or expired");
    }
    return { authenticated: true };
  }
  async diary(date: string) { return this.get(`/api/services/diary/read_diary?date=${encodeURIComponent(date)}&types=diary_meal%2Cfood_entry`); }
  async topFoods(from: string, to: string, list: "recent" | "frequent") {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    const days = Math.round((end - start) / 86_400_000) + 1;
    if (days < 1 || days > 31) throw new MfpError("Recent food range must contain 1 to 31 days");
    const byFood = new Map<string, { food_id: string; name: string; brand?: string;
      logs: number; last_logged_at: string; serving_sizes?: unknown }>();
    for (let offset = 0; offset < days; offset++) {
      const date = new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
      const entries = await this.diary(date);
      if (!Array.isArray(entries)) throw new MfpError("MyFitnessPal changed its diary response");
      for (const entry of entries) {
        if (entry?.type !== "food_entry" || !entry.food?.id) continue;
        const id = String(entry.food.id);
        const seen = byFood.get(id);
        const loggedAt = String(entry.logged_at ?? `${date}T00:00:00Z`);
        if (seen) {
          seen.logs++;
          if (loggedAt > seen.last_logged_at) seen.last_logged_at = loggedAt;
        } else {
          byFood.set(id, { food_id: id, name: String(entry.food.description ?? ""),
            brand: entry.food.brand_name, logs: 1, last_logged_at: loggedAt,
            serving_sizes: entry.food.serving_sizes });
        }
      }
    }
    const items = [...byFood.values()];
    items.sort(list === "recent"
      ? (a, b) => b.last_logged_at.localeCompare(a.last_logged_at)
      : (a, b) => b.logs - a.logs || b.last_logged_at.localeCompare(a.last_logged_at));
    return { from, to, list, items };
  }
  async logFood(args: { food_id: string; date: string; meal_position: number; servings: number; serving_unit?: string }) {
    const food = unwrapFood(await this.food(args.food_id));
    const sizes = food.serving_sizes;
    if (!Array.isArray(sizes) || !sizes.length) throw new MfpError("This food has no serving sizes");
    const chosen = args.serving_unit
      ? sizes.find((size: any) => String(size.unit).toLowerCase() === args.serving_unit!.toLowerCase())
      : sizes[0];
    if (!chosen) throw new MfpError(`Serving unit '${args.serving_unit}' was not found`);
    return this.post("/api/services/diary", { items: [{ type: "food_entry", date: args.date,
      food: { id: args.food_id, version: String(food.version ?? args.food_id) }, servings: args.servings,
      meal_position: args.meal_position,
      serving_size: { unit: chosen.unit, value: chosen.value, nutrition_multiplier: chosen.nutrition_multiplier } }] });
  }
  async updateDiaryEntry(id: string, servings: number) {
    const path = `/api/services/diary/${encodeURIComponent(id)}`;
    return this.put(path, { item: { id, servings } });
  }
  async deleteDiaryEntry(id: string) {
    return this.delete(`/api/services/diary/${encodeURIComponent(id)}`);
  }
  async ownFoods(search = "") {
    const response = await this.get(`/api/services/users/foods/mine?search=${encodeURIComponent(search)}`);
    const items = Array.isArray(response) ? response : (response as any)?.items ?? [];
    if (!Array.isArray(items)) throw new MfpError("MyFitnessPal changed the My Foods response");
    const foods = items.map((entry: any) => entry?.item ?? entry);
    return search ? foods.filter((food: any) => String(food?.description ?? "").toLowerCase().includes(search.toLowerCase())) : foods;
  }
  async food(id: string) { return this.get(`/api/services/foods/${encodeURIComponent(id)}`); }
  async ownMeals() {
    const response = await this.get("/api/services/users/meals/mine");
    const items = Array.isArray(response) ? response : (response as any)?.items ?? [];
    if (!Array.isArray(items)) throw new MfpError("MyFitnessPal changed the My Meals response");
    return items.map((entry: any) => entry?.item ?? entry);
  }
  async deleteOwnMeal(id: string) {
    const meals = await this.ownMeals();
    if (!meals.some((meal: any) => String(meal?.id) === id)) throw new MfpError("Meal ID is not in My Meals");
    await this.delete(`/api/services/users/meals/delete/${encodeURIComponent(id)}`);
    return { deleted: true, meal_id: id };
  }

  private async requireOwnFood(id: string) {
    const mine = await this.ownFoods();
    if (!mine.some((food: any) => String(food?.id) === id)) {
      throw new MfpError("Food ID is not in My Foods. Only private foods you own can be edited or deleted.");
    }
    const food = unwrapFood(await this.food(id));
    if (food.public === true) throw new MfpError("Shared public foods cannot be edited or deleted");
    return food;
  }

  async deleteOwnFood(id: string) {
    await this.requireOwnFood(id);
    await this.delete(`/api/services/foods/${encodeURIComponent(id)}`);
    return { deleted: true, food_id: id };
  }

  async updateOwnFood(id: string, changes: Partial<FoodSpec>) {
    const current = await this.requireOwnFood(id);
    const updates: Record<string, unknown> = {};
    if (changes.name !== undefined) updates.description = changes.name;
    if (changes.brand !== undefined) updates.brand_name = changes.brand;
    if (changes.country_code !== undefined) updates.country_code = changes.country_code;
    const originalNutrition = current.nutritional_contents;
    const nutrition = originalNutrition && typeof originalNutrition === "object"
      ? { ...(originalNutrition as Record<string, unknown>) } : {} as Record<string, unknown>;
    let nutritionChanged = false;
    if (changes.calories !== undefined) {
      nutrition.energy = { unit: "calories", value: changes.calories };
      nutritionChanged = true;
    }
    for (const key of ["protein", "carbohydrates", "fat", "fiber", "sugar", "sodium", "saturated_fat", "cholesterol", "potassium"] as const) {
      if (changes[key] !== undefined) { nutrition[key] = changes[key]; nutritionChanged = true; }
    }
    if (nutritionChanged) updates.nutritional_contents = nutrition;
    if (changes.serving_amount !== undefined || changes.serving_unit !== undefined) {
      const sizes = Array.isArray(current.serving_sizes) ? [...current.serving_sizes] as Record<string, unknown>[] : [];
      const first = sizes[0] || {};
      const value = changes.serving_amount ?? Number(first.value ?? 1);
      const unit = changes.serving_unit ?? String(first.unit ?? "serving");
      sizes[0] = { ...first, value, unit, nutrition_multiplier: first.nutrition_multiplier ?? 1 };
      if (sizes[1] && String(sizes[1].unit ?? "").startsWith("container (")) {
        sizes[1] = { ...sizes[1], unit: `container (${value} ${unit} ea.)` };
      }
      updates.serving_sizes = sizes;
    }
    if (!Object.keys(updates).length) throw new MfpError("Provide at least one food field to edit");
    if (current.version === undefined || current.user_id === undefined) {
      throw new MfpError("MyFitnessPal did not return the version and owner needed to edit this food");
    }
    const path = `/api/services/foods/${encodeURIComponent(id)}?version=${encodeURIComponent(String(current.version))}`;
    const editable = {
      type: current.type ?? "food",
      description: updates.description ?? current.description,
      brand_name: updates.brand_name ?? current.brand_name,
      public: false,
      country_code: updates.country_code ?? current.country_code,
      user_id: current.user_id,
      nutritional_contents: updates.nutritional_contents ?? current.nutritional_contents,
      serving_sizes: updates.serving_sizes ?? current.serving_sizes,
    };
    await this.patch(path, { item: editable });
    const food = unwrapFood(await this.food(id));
    if (changes.calories !== undefined && Number((food.nutritional_contents as any)?.energy?.value) !== changes.calories) {
      throw new MfpError("MyFitnessPal accepted the food edit but did not save the new calories");
    }
    return { updated: true, food_id: id, food };
  }

  async createFood(spec: FoodSpec) {
    const nutrients: Record<string, unknown> = {
      energy: { unit: "calories", value: spec.calories }, grams: 1,
      fat: spec.fat, carbohydrates: spec.carbohydrates, protein: spec.protein,
    };
    for (const key of ["fiber", "sugar", "sodium", "saturated_fat", "cholesterol", "potassium"] as const) {
      if (spec[key] !== undefined) nutrients[key] = spec[key];
    }
    const item = {
      type: "food", description: spec.name, brand_name: spec.brand || "Generic", public: false,
      country_code: spec.country_code || "US", nutritional_contents: nutrients,
      serving_sizes: [
        { value: spec.serving_amount, unit: spec.serving_unit, nutrition_multiplier: 1,
          gram_weight: spec.serving_unit === "g" ? spec.serving_amount : 1, fraction: false, index: 0 },
        { value: 1, unit: `container (${spec.serving_amount} ${spec.serving_unit} ea.)`, nutrition_multiplier: 1,
          gram_weight: 1, fraction: false, index: 1 },
      ],
    };
    let result: unknown;
    try { result = await this.post("/api/services/foods", { item }); }
    catch (error) {
      if (!(error instanceof MfpError) || (error.status !== 400 && error.status !== 422)) throw error;
      result = await this.post("/api/services/foods", { items: [item] });
    }
    const parsed = result === null ? null : unwrapFood(result);
    if (parsed?.id !== undefined) return parsed;
    const exact = (await this.ownFoods(spec.name)).filter((food: any) => food?.description === spec.name);
    if (exact.length === 1) return exact[0];
    throw new MfpError("Food creation returned no ID. Check My Foods before retrying to avoid a duplicate.");
  }

  async search(query: string, page = 0) {
    const searchSegments = `${encodeURIComponent(query)}/${page}`;
    // The rendered search page can contain results directly. Prefer that data because
    // a valid build ID does not guarantee that the old _next/data route still exists.
    const searchPath = `/food/calorie-chart-nutrition-facts/${searchSegments}`;
    const loadPage = async (path: string) => {
      const headers = new Headers({ cookie: await this.cookieHeader(), accept: "text/html" });
      let response: Response;
      try { response = await fetch(BASE + path, { headers, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(30000) }); }
      catch { throw new MfpError("Could not reach the MyFitnessPal food search page"); }
      this.rememberCookies(response);
      if (response.status >= 300 && response.status < 400) throw new MfpError("MyFitnessPal redirected food search. Refresh the browser session.", response.status);
      if (!response.ok) throw new MfpError(`Food search page returned HTTP ${response.status}`, response.status);
      const html = await response.text();
      const nextData = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
      let data: any;
      if (nextData) {
        try { data = JSON.parse(nextData); }
        catch { throw new MfpError("MyFitnessPal returned invalid food search page data"); }
      }
      const buildId = data?.buildId ?? html.match(/"buildId"\s*:\s*"([^"\\]+)"/)?.[1];
      return { data, buildId };
    };
    const parseItems = (data: any) => {
      const queries = data?.props?.pageProps?.dehydratedState?.queries ?? data?.pageProps?.dehydratedState?.queries;
      if (!Array.isArray(queries)) return undefined;
      const items = queries.flatMap((q: any) => Array.isArray(q?.state?.data?.items) ? q.state.data.items : []);
      return items.map((entry: any) => entry?.item ?? entry)
        .filter((item: any) => item?.id !== undefined && typeof item?.description === "string")
        .map((item: any) => ({ id: item.id, name: item.description, brand: item.brand_name,
          verified: item.verified, nutrition: item.nutritional_contents, servings: item.serving_sizes }));
    };
    let pageData: any;
    try { pageData = await loadPage(searchPath); }
    catch (error) {
      if (!(error instanceof MfpError) || error.status !== 404) throw error;
      pageData = await loadPage("/");
    }
    const fromPage = parseItems(pageData.data);
    if (fromPage?.length) return fromPage;
    const id = pageData.buildId ?? (await loadPage("/")).buildId;
    if (!id) throw new MfpError("Could not find the current MyFitnessPal search build ID");
    try {
      const fromData = parseItems(await this.get(`/_next/data/${encodeURIComponent(id)}/food/calorie-chart-nutrition-facts/${searchSegments}.json`));
      if (fromData) return fromData;
      throw new MfpError("MyFitnessPal changed its food search response");
    } catch (error) {
      if (error instanceof MfpError && error.status === 404) {
        throw new MfpError("MyFitnessPal removed the food search data route (HTTP 404); no results can be trusted until a current endpoint is identified", 404);
      }
      throw error;
    }
  }

  async diagnoseSearch() {
    const paths = [
      "/food/calorie-chart-nutrition-facts/banana/0",
      "/food/calorie-chart-nutrition-facts/banana",
      "/food/calorie-chart-nutrition-facts?search=banana",
      "/food/search?search=banana",
      "/api/services/foods?search=banana",
      "/api/services/foods/search?search=banana",
      "/api/services/search/nutrition?query=banana",
    ];
    const results = [];
    for (const path of paths) {
      const response = await fetch(BASE + path, {
        headers: { cookie: await this.cookieHeader(), accept: "text/html, application/json" },
        redirect: "manual", signal: AbortSignal.timeout(30000),
      });
      this.rememberCookies(response);
      const type = response.headers.get("content-type") ?? "";
      const result: Record<string, unknown> = { path, status: response.status, content_type: type.split(";", 1)[0] };
      if (type.includes("json")) {
        try {
          const data = await response.json() as any;
          result.keys = data && typeof data === "object" ? Object.keys(data).slice(0, 12) : [];
          result.items_count = Array.isArray(data?.items) ? data.items.length : undefined;
        } catch { result.invalid_json = true; }
      } else if (type.includes("html")) {
        const html = await response.text();
        const raw = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
        if (raw) {
          try {
            const data = JSON.parse(raw);
            result.next_page = data?.page;
            result.page_props_keys = Object.keys(data?.props?.pageProps ?? {}).slice(0, 12);
            result.query_keys = (data?.props?.pageProps?.dehydratedState?.queries ?? [])
              .slice(0, 10).map((entry: any) => entry?.queryKey);
            const foodQueries = (data?.props?.pageProps?.dehydratedState?.queries ?? [])
              .filter((entry: any) => entry?.queryKey?.[0] === "food");
            result.food_item_counts = foodQueries.map((entry: any) => entry?.state?.data?.items?.length ?? 0);
            result.food_samples = foodQueries.flatMap((entry: any) => entry?.state?.data?.items ?? [])
              .slice(0, 3).map((entry: any) => (entry?.item ?? entry)?.description ?? null);
          } catch { result.invalid_next_data = true; }
        }
        result.has_search_result_markup = /matched-food|search-result|food-result/i.test(html);
      }
      results.push(result);
    }
    const session = await this.get("/api/auth/session") as any;
    return { endpoints: results, session_keys: Object.keys(session ?? {}).slice(0, 20),
      user_keys: Object.keys(session?.user ?? {}).slice(0, 20) };
  }
}

export interface FoodSpec {
  name: string; brand?: string; calories: number; protein: number; carbohydrates: number; fat: number;
  serving_amount: number; serving_unit: string; country_code?: string;
  fiber?: number; sugar?: number; sodium?: number; saturated_fat?: number; cholesterol?: number; potassium?: number;
}

export function unwrapFood(result: unknown): Record<string, unknown> {
  const first = Array.isArray(result) ? result[0] : (result as any)?.items?.[0] ?? result;
  const value = (first as any)?.item ?? first;
  if (!value || typeof value !== "object") {
    throw new MfpError("MyFitnessPal accepted the food request but returned no food object. Check list_my_foods before retrying to avoid a duplicate.");
  }
  return value as Record<string, unknown>;
}

export function foodId(result: Record<string, unknown>) {
  const id = result.id;
  if (typeof id !== "string" && typeof id !== "number") throw new MfpError("Created food has no id; check My Foods before retrying to avoid a duplicate");
  return String(id);
}
