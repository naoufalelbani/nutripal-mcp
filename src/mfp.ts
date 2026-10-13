import { readFile, writeFile, mkdir, chmod, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";

const BASE = "https://www.myfitnesspal.com";
const TOKEN_NAME = "__Secure-next-auth.session-token";
const dataDir = () => process.env.MFP_DATA_DIR || join(homedir(), ".config", "nutripal-mcp");

export class MfpError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(message: string, readonly status?: number, code?: string, hint?: string) {
    super(message);
    this.code = code ?? (status === 404 ? "NOT_FOUND" : status === 429 ? "RATE_LIMITED" : "UPSTREAM_ERROR");
    this.hint = hint;
  }
}

export function activeProfile() { return validateProfile(process.env.MFP_PROFILE || "default"); }
export function validateProfile(profile: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile)) throw new MfpError("Invalid profile name");
  return profile;
}
const sessionPath = (profile: string) => join(dataDir(), "sessions", validateProfile(profile));
const verifiedPath = (profile: string) => join(dataDir(), "sessions", `${validateProfile(profile)}.verified.json`);
const foodBasisPath = (profile: string, id: string) => join(dataDir(), "food-basis", validateProfile(profile), `${encodeURIComponent(id)}.json`);
async function writePrivateFile(file: string, value: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally { await rm(temporary, { force: true }); }
}
type CarbBasis = "total" | "net";
async function readFoodBasis(profile: string, id: string): Promise<{ basis: CarbBasis; total: number; net: number; fiber: number } | null> {
  try {
    const value = JSON.parse(await readFile(foodBasisPath(profile, id), "utf8"));
    if ((value.basis !== "total" && value.basis !== "net") ||
      ![value.total, value.net, value.fiber].every((number) => typeof number === "number" && Number.isFinite(number)) ||
      Math.abs(value.total - value.net - value.fiber) > 0.001) return null;
    return value;
  } catch { return null; }
}
async function saveFoodBasis(profile: string, id: string, basis: CarbBasis, total: number, fiber: number) {
  const dir = join(dataDir(), "food-basis", validateProfile(profile));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writePrivateFile(foodBasisPath(profile, id), JSON.stringify({ basis, total, net: total - fiber, fiber }));
}

export async function withProfileWriteLock<T>(profile: string, action: () => Promise<T>): Promise<T> {
  const target = join(dataDir(), "write-locks", validateProfile(profile));
  await mkdir(target, { recursive: true, mode: 0o700 });
  let compromised: Error | undefined;
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(target, { stale: 120_000, update: 30_000,
      retries: { retries: 120, factor: 1, minTimeout: 500, maxTimeout: 500 },
      onCompromised: (error) => { compromised = error; } });
  } catch (error) {
    throw new MfpError(`Could not acquire the write lock for profile ${profile}: ${error instanceof Error ? error.message : "unknown error"}`,
      undefined, "PROFILE_BUSY");
  }
  try {
    const result = await action();
    if (compromised) throw new MfpError(`Write lock for profile ${profile} was lost; reconcile the account before retrying`,
      undefined, "WRITE_LOCK_LOST");
    return result;
  } finally {
    try { await release(); }
    catch { throw new MfpError(`Write lock for profile ${profile} could not be released; reconcile the account before retrying`,
      undefined, "WRITE_LOCK_LOST"); }
  }
}

export async function saveSession(value: string, profile = "default") {
  const cookie = normalizeCookie(value);
  const dir = join(dataDir(), "sessions");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dataDir(), 0o700);
  await chmod(dir, 0o700);
  const file = sessionPath(profile);
  await writePrivateFile(file, cookie);
  await markVerified(profile);
}

async function markVerified(profile: string) {
  const dir = join(dataDir(), "sessions");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writePrivateFile(verifiedPath(profile), JSON.stringify({ last_verified: new Date().toISOString() }));
}

export async function listProfiles() {
  let names: string[] = [];
  try { names = (await readdir(join(dataDir(), "sessions"))).filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)); }
  catch { /* No named sessions yet. */ }
  try { await readFile(join(dataDir(), "session")); if (!names.includes("default")) names.push("default"); }
  catch { /* No legacy session. */ }
  if (process.env.MFP_COOKIE && !names.includes(activeProfile())) names.push(activeProfile());
  return Promise.all(names.sort().map(async (profile) => {
    let last_verified: string | null = null;
    try { last_verified = JSON.parse(await readFile(verifiedPath(profile), "utf8")).last_verified ?? null; }
    catch { /* Never verified. */ }
    let valid = false;
    try { await new MfpClient(undefined, profile, profile === activeProfile()).account();
      valid = true; last_verified = new Date().toISOString(); }
    catch { /* Preserve the prior verification timestamp. */ }
    return { profile, valid, last_verified };
  }));
}

function normalizeCookie(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) throw new MfpError("Session cookie is empty or malformed");
  if (trimmed.startsWith(`${TOKEN_NAME}=`) || trimmed.includes(";")) return trimmed;
  // People often copy the cookie name and value as two space-separated columns
  // from a cookie viewer. Convert that pair to a valid Cookie header.
  if (trimmed.startsWith(`${TOKEN_NAME} `)) return `${TOKEN_NAME}=${trimmed.slice(TOKEN_NAME.length + 1)}`;
  return `${TOKEN_NAME}=${trimmed}`;
}

async function sessionCookie(profile: string, useEnvCookie: boolean) {
  const fromEnv = useEnvCookie ? process.env.MFP_COOKIE : undefined;
  if (fromEnv) return normalizeCookie(fromEnv);
  try { return normalizeCookie(await readFile(sessionPath(profile), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (profile === "default") {
      try { return normalizeCookie(await readFile(join(dataDir(), "session"), "utf8")); }
      catch { /* No legacy session. */ }
    }
    throw new MfpError(`No session for profile ${profile}. Re-run auth for profile ${profile}.`, undefined,
      "MFP_SESSION_STALE", `re-run auth for profile ${profile}`);
  }
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

function diaryRows(value: unknown): any[] {
  const rows = Array.isArray(value) ? value : (value as any)?.items;
  if (!Array.isArray(rows)) throw new MfpError("MyFitnessPal returned an unsupported diary response");
  return rows.map((row: any) => {
    const item = row?.item ?? row;
    if (!item || typeof item !== "object")
      throw new MfpError("MyFitnessPal returned an unsupported diary row");
    return item;
  });
}
function verifiableDiaryRows(value: unknown): any[] {
  const rows = diaryRows(value);
  if (rows.some((item) => item.type !== "diary_meal" && item.id === undefined))
    throw new MfpError("MyFitnessPal returned a diary row without an ID; persistence cannot be verified");
  return rows;
}

export class MfpClient {
  private csrf?: string;
  private csrfPromise?: Promise<string>;
  private cookies = new Map<string, string>();
  constructor(private readonly providedCookie?: string, readonly profile = activeProfile(),
    private readonly useEnvCookie = profile === activeProfile()) { validateProfile(profile); }

  private async cookieHeader() {
    const base = this.providedCookie ? normalizeCookie(this.providedCookie) : await sessionCookie(this.profile, this.useEnvCookie);
    return [base, ...[...this.cookies].map(([key, value]) => `${key}=${value}`)].join("; ");
  }

  private rememberCookies(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (separator <= 0) continue;
      const name = pair!.slice(0, separator);
      const value = pair!.slice(separator + 1);
      if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(line)) {
        this.cookies.delete(name);
        continue;
      }
      this.cookies.set(name, value);
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
    } catch { throw new MfpError("MyFitnessPal request failed. Check your network connection.", undefined, "UPSTREAM_ERROR"); }
    if (response.status >= 300 && response.status < 400 || response.status === 401 || response.status === 403)
      throw new MfpError(`MyFitnessPal session for profile ${this.profile} is stale`, response.status,
        "MFP_SESSION_STALE", `re-run auth for profile ${this.profile}`);
    if (response.ok) this.rememberCookies(response);
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
    if (this.csrf) return this.csrf;
    this.csrfPromise ??= (async () => {
      const result = await this.request("/api/auth/csrf") as { csrfToken?: string };
      if (!result?.csrfToken) throw new MfpError("MyFitnessPal did not provide a CSRF token");
      this.csrf = result.csrfToken;
      return this.csrf;
    })().finally(() => { this.csrfPromise = undefined; });
    return this.csrfPromise;
  }

  get(path: string) { return this.request(path); }
  post(path: string, body: unknown) { return this.request(path, { method: "POST", body: JSON.stringify(body) }, true); }
  patch(path: string, body: unknown) { return this.request(path, { method: "PATCH", body: JSON.stringify(body) }, true); }
  put(path: string, body: unknown) { return this.request(path, { method: "PUT", body: JSON.stringify(body) }, true); }
  delete(path: string) { return this.request(path, { method: "DELETE" }, true); }

  async account() {
    const account = await this.get("/api/services/users") as any;
    if (!account || typeof account !== "object" || account.id === undefined) {
      throw new MfpError("MyFitnessPal session is empty or expired");
    }
    if (!this.providedCookie && (!this.useEnvCookie || !process.env.MFP_COOKIE)) {
      try { await markVerified(this.profile); } catch { /* A metadata write must not invalidate a working session. */ }
    }
    return { authenticated: true, profile: this.profile };
  }
  async myProfile() {
    const profile = await this.get("/api/services/diary/profile") as any;
    const personal = profile?.profiles?.find((entry: any) => entry?.type === "user") ?? {};
    const birthdate = typeof personal.birthdate === "string" ? new Date(`${personal.birthdate}T00:00:00Z`) : undefined;
    const now = new Date();
    const age = birthdate && !Number.isNaN(birthdate.valueOf())
      ? now.getUTCFullYear() - birthdate.getUTCFullYear() -
        ((now.getUTCMonth() < birthdate.getUTCMonth() ||
          (now.getUTCMonth() === birthdate.getUTCMonth() && now.getUTCDate() < birthdate.getUTCDate())) ? 1 : 0)
      : undefined;
    return {
      username: profile?.username,
      profile_image_url: personal.main_image_url,
      age,
      sex: personal.sex,
      member_since: profile?.created_at,
      about_me: personal.about || "I haven't filled this out yet.",
      why_i_want_to_get_in_shape: personal.why || "I haven't filled this out yet.",
      inspirations: personal.inspirations?.length ? personal.inspirations : "I haven't filled this out yet.",
      friends_count: profile?.friends_count ?? profile?.friends?.length ?? 0,
      friends: profile?.friends ?? [],
    };
  }
  async myFriends() {
    const profile = await this.get("/api/services/diary/profile") as any;
    if (!Array.isArray(profile?.friends)) throw new MfpError("MyFitnessPal did not return your friends list");
    return { friends_count: profile.friends_count ?? profile.friends.length, friends: profile.friends };
  }
  async accountSettings() {
    const [account, profile, diary, goals] = await Promise.all([
      this.get("/api/services/users"),
      this.get("/api/services/diary/profile"),
      this.get("/api/services/account/diary_settings"),
      this.get("/api/services/nutrient-goals"),
    ]);
    return { account, profile, diary_settings: diary, nutrition_goals: goals };
  }
  async updatePrivacyPreferences(changes: { friend_visibility?: boolean; diary_visibility?: string;
    profile_visibility?: string; yir_visibility?: string; age_visibility?: string }) {
    if (!Object.keys(changes).length) throw new MfpError("Provide at least one privacy preference to change");
    const current = await this.get("/api/services/diary/profile") as any;
    const existing = current?.privacy_preferences;
    if (!existing || typeof existing !== "object") throw new MfpError("MyFitnessPal returned unsupported privacy settings");
    const updated = { ...existing, ...changes };
    await this.patch("/api/services/users", { item: { privacy_preferences: updated } });
    const verified = await this.get("/api/services/diary/profile") as any;
    if (!verified?.privacy_preferences || Object.entries(changes).some(([key, value]) => verified.privacy_preferences[key] !== value)) {
      throw new MfpError("MyFitnessPal accepted the privacy update but did not save every requested setting");
    }
    return { updated: true, privacy_preferences: verified.privacy_preferences };
  }
  async updateNutritionGoals(changes: { calories?: number; protein?: number; carbohydrates?: number; fat?: number;
    fiber?: number; sugar?: number; sodium?: number; saturated_fat?: number; cholesterol?: number;
    potassium?: number; vitamin_a?: number; vitamin_c?: number; calcium?: number; iron?: number }) {
    const nutrients = Object.fromEntries(Object.entries(changes).filter(([key, value]) => key !== "calories" && value !== undefined));
    if (changes.calories === undefined && !Object.keys(nutrients).length) {
      throw new MfpError("Provide at least one calorie or nutrient target to update");
    }
    const current = await this.get("/api/services/nutrient-goals") as any;
    // The API currently returns an array of goal groups, while older responses
    // used an { item } envelope. Keep the original wire shape for the update.
    const wrapped = !Array.isArray(current) && Array.isArray(current?.item);
    const groups = Array.isArray(current) ? current : Array.isArray(current?.item) ? current.item
      : current?.item && typeof current.item === "object" ? [current.item]
      : current && typeof current === "object" ? [current] : [];
    if (!groups.length || groups.some((group: any) => !Array.isArray(group?.daily_goals) || !group?.default_goal)) {
      throw new MfpError("MyFitnessPal returned an unsupported nutrition goals response");
    }
    const updateGoal = (goal: any) => ({
      ...goal,
      ...(changes.calories !== undefined ? { energy: { ...(goal.energy ?? {}), value: String(changes.calories), unit: goal.energy?.unit ?? "calories" } } : {}),
      ...nutrients,
    });
    const updateGroup = (group: any) => ({
      ...group,
      daily_goals: group.daily_goals.map(updateGoal),
      default_goal: updateGoal(group.default_goal),
    });
    const updatedGroups = groups.map(updateGroup);
    const updated = Array.isArray(current) ? updatedGroups : wrapped ? { item: updatedGroups }
      : current?.item && typeof current.item === "object" ? { item: updateGroup(current.item) }
      : updateGroup(current);
    await this.post("/api/services/nutrient-goals", updated);
    const verifiedResponse = await this.get("/api/services/nutrient-goals") as any;
    const verifiedGroups = Array.isArray(verifiedResponse) ? verifiedResponse
      : Array.isArray(verifiedResponse?.item) ? verifiedResponse.item
      : [verifiedResponse?.item ?? verifiedResponse];
    const goals = verifiedGroups.flatMap((group: any) => [...(group?.daily_goals ?? []), group?.default_goal].filter(Boolean));
    if (!goals.length || goals.some((goal: any) =>
      (changes.calories !== undefined && Number(goal.energy?.value) !== changes.calories) ||
      Object.entries(nutrients).some(([key, value]) => Number(goal[key]) !== value))) {
      throw new MfpError("MyFitnessPal accepted the goal update but did not save all requested targets");
    }
    return { updated: true, changes,
      daily_goals: verifiedGroups.flatMap((group: any) => group?.daily_goals ?? []),
      default_goal: verifiedGroups.map((group: any) => group?.default_goal).filter(Boolean) };
  }
  async updateAccountProfile(changes: {
    username?: string; timezone?: string; language?: string;
    location?: { country_code?: string; state?: string | null; city?: string | null; postal_code?: string | null };
    units?: { energy?: string; weight?: string; distance?: string; height?: string; water?: string };
    profile?: { birthdate?: string; sex?: string; height?: { value: number; unit: string }; activity_factor?: string;
      headline?: string | null; about?: string | null; why?: string | null; inspirations?: string[] };
  }) {
    const current = await this.get("/api/services/diary/profile") as any;
    if (!current || typeof current !== "object") throw new MfpError("MyFitnessPal returned an unsupported profile response");
    const updated = structuredClone(current);
    if (changes.timezone !== undefined) updated.location_preferences.time_zone = changes.timezone;
    if (changes.language !== undefined) updated.location_preferences.locale = changes.language;
    if (changes.location) updated.location_preferences = { ...updated.location_preferences, ...changes.location };
    if (changes.units) updated.unit_preferences = { ...updated.unit_preferences, ...changes.units };
    if (changes.profile) {
      const index = Array.isArray(updated.profiles) ? updated.profiles.findIndex((entry: any) => entry.type === "user") : -1;
      if (index < 0) throw new MfpError("MyFitnessPal did not return an editable user profile");
      updated.profiles[index] = { ...updated.profiles[index], ...changes.profile };
    }
    const userUpdate: Record<string, unknown> = {};
    if (changes.username !== undefined) userUpdate.username = changes.username;
    if (changes.timezone !== undefined || changes.language !== undefined || changes.location) userUpdate.location_preferences = updated.location_preferences;
    if (changes.units) userUpdate.unit_preferences = updated.unit_preferences;
    if (changes.profile) userUpdate.profiles = updated.profiles;
    await this.patch("/api/services/users", { item: userUpdate });
    const verified = await this.get("/api/services/diary/profile") as any;
    const expected: Record<string, unknown> = {};
    if (changes.username !== undefined) expected.username = changes.username;
    if (changes.timezone !== undefined) expected.time_zone = changes.timezone;
    if (changes.language !== undefined) expected.locale = changes.language;
    if (changes.location) expected.location = changes.location;
    if (changes.units) expected.units = changes.units;
    for (const [key, value] of Object.entries(expected)) {
      const actual = key === "username" ? verified.username
        : key === "time_zone" || key === "locale" ? verified.location_preferences?.[key]
        : key === "location" ? verified.location_preferences
        : verified.unit_preferences;
      const matches = key === "units"
        ? Object.entries(value as Record<string, string>).every(([unit, setting]) => actual?.[unit] === setting)
        : key === "location"
        ? Object.entries(value as Record<string, unknown>).every(([field, setting]) => actual?.[field] === setting)
        : actual === value;
      if (!matches) throw new MfpError(`MyFitnessPal accepted the profile update but did not save ${key}`);
    }
    if (changes.profile) {
      const savedProfile = verified.profiles?.find((entry: any) => entry.type === "user");
      if (!savedProfile || Object.entries(changes.profile).some(([key, value]) => JSON.stringify(savedProfile[key]) !== JSON.stringify(value))) {
        throw new MfpError("MyFitnessPal accepted the profile update but did not save all requested diet/fitness fields");
      }
    }
    return { updated: true, username: verified.username, location_preferences: verified.location_preferences,
      unit_preferences: verified.unit_preferences, profile: verified.profiles?.find((entry: any) => entry.type === "user") };
  }
  async updateDiarySettings(changes: { meal_names?: string[]; tracked_nutrients?: string[]; preference?: Record<string, unknown> }) {
    if (!changes.meal_names && !changes.tracked_nutrients && !changes.preference) throw new MfpError("Provide at least one diary setting to change");
    const current = await this.get("/api/services/account/diary_settings") as any;
    if (!current || typeof current !== "object") throw new MfpError("MyFitnessPal returned unsupported diary settings");
    const updated = {
      ...current,
      ...(changes.meal_names ? { meal_names: changes.meal_names.map((description, index) => ({ position: index + 1, description })) } : {}),
      ...(changes.tracked_nutrients ? { tracked_nutrients: changes.tracked_nutrients.map((field_name, index) => {
        const existing = current.tracked_nutrients?.find((entry: any) => entry.field_name === field_name);
        if (!existing) throw new MfpError(`Nutrient '${field_name}' is not available in the current diary settings`);
        return { ...existing, position: index + 1 };
      }) } : {}),
      ...(changes.preference ? { preference: { ...current.preference, ...changes.preference } } : {}),
    };
    await this.post("/api/services/account/diary_settings", updated);
    const verified = await this.get("/api/services/account/diary_settings") as any;
    if (changes.meal_names && JSON.stringify(verified.meal_names?.map((entry: any) => entry.description)) !== JSON.stringify(changes.meal_names)) {
      throw new MfpError("MyFitnessPal accepted the diary settings update but did not save meal names");
    }
    if (changes.tracked_nutrients && JSON.stringify(verified.tracked_nutrients?.map((entry: any) => entry.field_name)) !== JSON.stringify(changes.tracked_nutrients)) {
      throw new MfpError("MyFitnessPal accepted the diary settings update but did not save tracked nutrients");
    }
    if (changes.preference && Object.entries(changes.preference).some(([key, value]) => verified.preference?.[key] !== value)) {
      throw new MfpError("MyFitnessPal accepted the diary settings update but did not save all requested preferences");
    }
    return { updated: true, settings: verified };
  }
  async diary(date: string) {
    return diaryRows(await this.get(`/api/services/diary/read_diary?date=${encodeURIComponent(date)}&types=diary_meal%2Cfood_entry%2Cexercise_entry`));
  }
  async exerciseDiary(date: string) {
    const entries = await this.get(`/api/services/diary/read_diary?date=${encodeURIComponent(date)}&types=exercise_entry`);
    if (!Array.isArray(entries)) throw new MfpError("MyFitnessPal changed its exercise diary response");
    return entries;
  }
  async liveDigest(from: string, to: string) {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    const days = Math.round((end - start) / 86_400_000) + 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || days < 1 || days > 31) {
      throw new MfpError("Summary range must contain 1 to 31 days");
    }
    return this.get(`/api/services/live-digest?from-date=${encodeURIComponent(from)}&to-date=${encodeURIComponent(to)}`);
  }
  async searchExercises(query: string) {
    const response = await this.get(`/api/services/exercises/search?search=${encodeURIComponent(query)}`) as any;
    if (!Array.isArray(response?.exercises)) throw new MfpError("MyFitnessPal changed its exercise search response");
    return response.exercises;
  }
  async exercises() {
    const response = await this.get("/api/services/exercises/lookup") as any;
    if (!Array.isArray(response?.exercises)) throw new MfpError("MyFitnessPal changed its exercise catalog response");
    return response.exercises;
  }
  async exercise(id: string) { return this.get(`/api/services/exercises/lookup/${encodeURIComponent(id)}`); }
  async ownExercises() {
    const response = await this.get("/api/services/exercises/lookup_private");
    if (!Array.isArray(response)) throw new MfpError("MyFitnessPal changed its private exercises response");
    return response;
  }
  async measurementTypes() {
    const response = await this.get("/api/user-measurements/measurements/types");
    if (!Array.isArray(response)) throw new MfpError("MyFitnessPal changed its measurement types response");
    return response;
  }
  async deleteMeasurement(id: string) {
    await this.delete(`/api/user-measurements/measurements/${encodeURIComponent(id)}`);
    return { deleted: true, measurement_id: id };
  }
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
  async logFood(args: { food_id: string; date: string; meal_position: number; servings: number;
    serving_size_id?: string; serving_value?: number; serving_unit?: string }) {
    const food = unwrapFood(await this.food(args.food_id));
    const sizes = food.serving_sizes;
    if (!Array.isArray(sizes) || !sizes.length) throw new MfpError("This food has no serving sizes");
    const options = sizes.map((size: any) => ({ id: size.id ?? null, value: Number(size.value), unit: String(size.unit) }));
    const normalize = (value: unknown) => String(value).trim().replace(/\s+/g, " ").toLowerCase();
    const matches = args.serving_size_id !== undefined
      ? sizes.filter((size: any) => String(size.id) === args.serving_size_id)
      : args.serving_value !== undefined
        ? sizes.filter((size: any) => Number(size.value) === args.serving_value && normalize(size.unit) === normalize(args.serving_unit))
        : args.serving_unit !== undefined
          ? sizes.filter((size: any) => normalize(size.unit) === normalize(args.serving_unit)
            || normalize(`${size.value} ${size.unit}`) === normalize(args.serving_unit))
          : [sizes[0]];
    if (matches.length !== 1) throw new MfpError(`Serving selection ${matches.length ? "is ambiguous" : "was not found"}. Valid options: ${JSON.stringify(options)}`,
      undefined, "INVALID_SERVING");
    const chosen = matches[0];
    const submitted = await this.post("/api/services/diary", { items: [{ type: "food_entry", date: args.date,
      food: { id: args.food_id, version: String(food.version ?? args.food_id) }, servings: args.servings,
      meal_position: args.meal_position,
      serving_size: { unit: chosen.unit, value: chosen.value,
        nutrition_multiplier: chosen.nutrition_multiplier } }] });
    const first = Array.isArray(submitted) ? submitted[0] : (submitted as any)?.items?.[0] ?? submitted;
    const returned = first?.item ?? first;
    const entryId = returned?.id === undefined ? null : String(returned.id);
    let rows: any[];
    try { rows = verifiableDiaryRows(await this.diary(args.date)); }
    catch (error) {
      return { persisted: false, entry: null, diary_entry_id: entryId,
        reason: `Diary read-back failed: ${error instanceof Error ? error.message : "unknown error"}`,
        code: error instanceof MfpError ? error.code : "UPSTREAM_ERROR",
        hint: error instanceof MfpError ? error.hint : undefined,
        serving: { id: chosen.id ?? null, value: chosen.value, unit: chosen.unit, servings: args.servings } };
    }
    // Without the created ID an older identical row cannot prove this write persisted.
    const entry = entryId === null ? null : rows.find((row: any) => row?.type === "food_entry"
      && String(row.id) === entryId) ?? null;
    const sameNumber = (left: unknown, right: number) => Number.isFinite(Number(left)) &&
      Math.abs(Number(left) - right) < 0.000001;
    const persisted = Boolean(entry && String(entry.food?.id) === args.food_id &&
      String(entry.date).slice(0, 10) === args.date && Number(entry.meal_position) === args.meal_position &&
      sameNumber(entry.servings, args.servings) && sameNumber(entry.serving_size?.value, Number(chosen.value)) &&
      normalize(entry.serving_size?.unit) === normalize(chosen.unit) &&
      (chosen.id === undefined || chosen.id === null || String(entry.serving_size?.id) === String(chosen.id)));
    return { persisted, entry, diary_entry_id: entryId,
      reason: persisted ? null : entry ? "Diary read-back row did not match the submitted food, date, meal, or serving; reconcile before retrying"
        : entryId === null
        ? "MyFitnessPal returned no diary entry ID; an identical row cannot confirm this write. Reconcile before retrying"
        : "Diary read-back did not contain the submitted entry; reconcile before retrying",
      serving: { id: chosen.id ?? null, value: chosen.value, unit: chosen.unit, servings: args.servings } };
  }
  async updateDiaryEntry(id: string, servings: number, meal?: number) {
    const path = `/api/services/diary/${encodeURIComponent(id)}`;
    const current = unwrapFood(await this.get(path));
    const preserved = meal ?? (typeof current.meal_position === "number" ? current.meal_position : undefined);
    if (preserved === undefined) throw new MfpError("Diary entry has no meal position to preserve; provide meal explicitly", undefined, "MEAL_UNKNOWN");
    await this.put(path, { item: { id, servings, meal_position: preserved } });
    const entry = unwrapFood(await this.get(path));
    if (Number(entry.meal_position) !== preserved) throw new MfpError("Diary entry meal changed unexpectedly", undefined, "UPSTREAM_ERROR");
    return { updated: true, entry, meal: preserved };
  }
  async deleteDiaryEntry(id: string) {
    const path = `/api/services/diary/${encodeURIComponent(id)}`;
    const existing = unwrapFood(await this.get(path));
    const date = typeof existing.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(existing.date)
      ? existing.date : null;
    if (!date) throw new MfpError("Diary entry has no explicit date for deletion verification", undefined, "UPSTREAM_ERROR");
    await this.delete(path);
    let rows: any[];
    try { rows = verifiableDiaryRows(await this.diary(date)); }
    catch (error) {
      return { persisted: false, entry: null, diary_entry_id: id,
        reason: `Diary read-back failed: ${error instanceof Error ? error.message : "unknown error"}`,
        code: error instanceof MfpError ? error.code : "UPSTREAM_ERROR",
        hint: error instanceof MfpError ? error.hint : undefined };
    }
    const entry = rows.find((row: any) => String(row.id) === id) ?? null;
    return { persisted: entry === null, entry, diary_entry_id: id,
      reason: entry === null ? null : "Diary read-back still contains the deleted entry" };
  }
  async ownFoods(search = "") {
    const response = await this.get(`/api/services/users/foods/mine?search=${encodeURIComponent(search)}`);
    const items = Array.isArray(response) ? response : (response as any)?.items ?? [];
    if (!Array.isArray(items)) throw new MfpError("MyFitnessPal changed the My Foods response");
    const foods = items.map((entry: any) => entry?.item ?? entry);
    return search ? foods.filter((food: any) => String(food?.description ?? "").toLowerCase().includes(search.toLowerCase())) : foods;
  }
  async food(id: string) { return this.get(`/api/services/foods/${encodeURIComponent(id)}`); }
  async foodDetails(id: string) {
    const food = unwrapFood(await this.food(id));
    const nutrition = food.nutritional_contents as any;
    const numberOrNull = (value: unknown) => value === null || value === undefined || value === ""
      ? null : Number.isFinite(Number(value)) ? Number(value) : null;
    const raw = numberOrNull(nutrition?.carbohydrates);
    const upstreamFiber = numberOrNull(nutrition?.fiber);
    const saved = await readFoodBasis(this.profile, id);
    // Sidecar metadata can become stale when the food is changed outside NutriPal.
    const stored = saved && raw !== null && Math.abs(saved.total - raw) < 0.001 &&
      (upstreamFiber === null ? saved.fiber === 0 : Math.abs(saved.fiber - upstreamFiber) < 0.001)
      ? saved : null;
    const fiber = stored?.fiber ?? upstreamFiber;
    const basis = stored?.basis ?? (nutrition?.carbohydrate_basis === "total" || nutrition?.carbohydrate_basis === "net"
      ? nutrition.carbohydrate_basis as CarbBasis : "unknown");
    const total = stored?.total ?? (basis === "total" ? raw
      : basis === "net" && raw !== null && fiber !== null ? raw + fiber : null);
    const net = stored?.net ?? (total !== null && fiber !== null ? total - fiber : null);
    return { ...food, carbohydrates: total, net_carbs: net,
      fiber, carbohydrate_basis: basis,
      raw_carbohydrates: nutrition?.carbohydrates ?? null };
  }
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
    for (const key of ["protein", "fat", "fiber", "sugar", "sodium", "saturated_fat", "cholesterol", "potassium"] as const) {
      if (changes[key] !== undefined) { nutrition[key] = changes[key]; nutritionChanged = true; }
    }
    if (changes.carbohydrates !== undefined) {
      const fiber = changes.fiber ?? Number(nutrition.fiber ?? 0);
      const basis = changes.carbohydrate_basis ?? "total";
      nutrition.carbohydrates = basis === "net" ? changes.carbohydrates + fiber : changes.carbohydrates;
      nutritionChanged = true;
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
    if (changes.carbohydrates !== undefined) {
      const fiber = changes.fiber ?? Number((food.nutritional_contents as any)?.fiber ?? 0);
      const total = changes.carbohydrate_basis === "net" ? changes.carbohydrates + fiber : changes.carbohydrates;
      if (Number((food.nutritional_contents as any)?.carbohydrates) !== total)
        throw new MfpError("MyFitnessPal accepted the food edit but did not save the requested carbohydrates");
      if (changes.fiber !== undefined && Number((food.nutritional_contents as any)?.fiber) !== changes.fiber)
        throw new MfpError("MyFitnessPal accepted the food edit but did not save the requested fiber");
      try { await saveFoodBasis(this.profile, id, changes.carbohydrate_basis ?? "total", total, fiber); }
      catch { throw new MfpError(`Food ${id} was updated but its carbohydrate basis could not be saved locally. Check the food before retrying.`,
        undefined, "FOOD_UNVERIFIED"); }
    } else if (changes.fiber !== undefined) {
      const prior = await readFoodBasis(this.profile, id);
      if (Number((food.nutritional_contents as any)?.fiber) !== changes.fiber)
        throw new MfpError("MyFitnessPal accepted the food edit but did not save the requested fiber");
      if (prior && Number((food.nutritional_contents as any)?.carbohydrates) === prior.total) {
        try { await saveFoodBasis(this.profile, id, prior.basis, prior.total, changes.fiber); }
        catch { throw new MfpError(`Food ${id} was updated but its carbohydrate basis could not be saved locally. Check the food before retrying.`,
          undefined, "FOOD_UNVERIFIED"); }
      }
    }
    if (changes.calories !== undefined && Number((food.nutritional_contents as any)?.energy?.value) !== changes.calories) {
      throw new MfpError("MyFitnessPal accepted the food edit but did not save the new calories");
    }
    return { updated: true, food_id: id, food };
  }

  async createFood(spec: FoodSpec) {
    const fiber = spec.fiber ?? 0;
    const basis = spec.carbohydrate_basis ?? "total";
    const totalCarbs = basis === "net" ? spec.carbohydrates + fiber : spec.carbohydrates;
    const nutrients: Record<string, unknown> = {
      energy: { unit: "calories", value: spec.calories }, grams: 1,
      fat: spec.fat, carbohydrates: totalCarbs, protein: spec.protein,
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
    // A rejected response cannot prove the first write failed; do not retry a create blindly.
    const result = await this.post("/api/services/foods", { item });
    const parsed = result === null ? null : unwrapFood(result);
    if (parsed?.id === undefined) throw new MfpError(
      "Food creation returned no ID. Check My Foods before retrying to avoid a duplicate.", undefined, "FOOD_ID_UNKNOWN");
    const createdId = String(parsed.id);
    let verified: Record<string, unknown>;
    try { verified = unwrapFood(await this.food(createdId)); }
    catch (error) { throw new MfpError(
      `Food ${createdId} was submitted but its read-back failed: ${error instanceof Error ? error.message : "unknown error"}. Check My Foods before retrying.`,
      error instanceof MfpError ? error.status : undefined,
      error instanceof MfpError && error.code === "MFP_SESSION_STALE" ? error.code : "FOOD_UNVERIFIED",
      error instanceof MfpError ? error.hint : undefined); }
    if (Number((verified.nutritional_contents as any)?.carbohydrates) !== totalCarbs ||
      (spec.fiber !== undefined && Number((verified.nutritional_contents as any)?.fiber) !== fiber))
      throw new MfpError(`Food ${createdId} was created but its carbohydrates or fiber differed on read-back. Check My Foods before retrying.`,
        undefined, "FOOD_UNVERIFIED");
    try { await saveFoodBasis(this.profile, createdId, basis, totalCarbs, fiber); }
    catch { throw new MfpError(`Food ${createdId} was created but its carbohydrate basis could not be saved locally. Check My Foods before retrying.`,
      undefined, "FOOD_UNVERIFIED"); }
    return verified;
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
      if (response.status >= 300 && response.status < 400 || response.status === 401 || response.status === 403)
        throw new MfpError(`MyFitnessPal session for profile ${this.profile} is stale`,
        response.status, "MFP_SESSION_STALE", `re-run auth for profile ${this.profile}`);
      if (!response.ok) throw new MfpError(`Food search page returned HTTP ${response.status}`, response.status);
      this.rememberCookies(response);
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
      if (response.status >= 300 && response.status < 400 || response.status === 401 || response.status === 403)
        throw new MfpError(`MyFitnessPal session for profile ${this.profile} is stale`, response.status,
          "MFP_SESSION_STALE", `re-run auth for profile ${this.profile}`);
      if (response.ok) this.rememberCookies(response);
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
  carbohydrate_basis?: CarbBasis;
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
