/**
 * OpenRouter routing preferences, shared by raw Chat Completions and the AI SDK.
 * No API keys, transcript text, or user profile data are stored by this module.
 * Provider prices in API preferences are USD per MILLION tokens, not per token.
 */
export const ROUTING_STORAGE_KEY = "openwhispr.openrouter.routing.v1";
export const ROUTING_CHANGED_EVENT = "openwhispr:openrouter-routing-changed";

export type RoutingSort = "default" | "latency" | "throughput" | "price";
export interface RoutingPreferences {
  sort: RoutingSort;
  upstream: string;
  allowFallbacks: boolean;
  maxInputPrice: number | null;
  maxOutputPrice: number | null;
}
export interface RoutingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface RoutingDocument {
  version: 1;
  routes: Record<string, RoutingPreferences>;
}
export interface ProviderPreference {
  sort?: Exclude<RoutingSort, "default">;
  order?: string[];
  only?: string[];
  allow_fallbacks?: boolean;
  max_price?: { prompt?: number; completion?: number; [key: string]: unknown };
  [key: string]: unknown;
}
export interface UpstreamEndpoint {
  tag: string;
  name: string;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  latencySeconds: number | null;
  tokensPerSecond: number | null;
  status: number | null;
}

export const defaultRouting = (): RoutingPreferences => ({
  sort: "default",
  upstream: "",
  allowFallbacks: false,
  maxInputPrice: null,
  maxOutputPrice: null,
});

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function price(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = numberOrNull(value);
  if (parsed === null) throw new Error("Price ceilings must be finite, non-negative numbers.");
  return parsed;
}
export function validateRouting(value: unknown): RoutingPreferences {
  if (!object(value)) throw new Error("Invalid OpenRouter routing preferences.");
  const sort = value.sort ?? "default";
  if (typeof sort !== "string" || !["default", "latency", "throughput", "price"].includes(sort)) {
    throw new Error("Invalid OpenRouter routing priority.");
  }
  if (value.upstream !== undefined && typeof value.upstream !== "string") {
    throw new Error("Invalid OpenRouter provider slug.");
  }
  if (value.allowFallbacks !== undefined && typeof value.allowFallbacks !== "boolean") {
    throw new Error("Invalid OpenRouter fallback preference.");
  }
  const upstream = typeof value.upstream === "string" ? value.upstream.trim() : "";
  // Slugs come from OpenRouter's endpoint `tag`; never manufacture them from names.
  if (upstream && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(upstream)) {
    throw new Error("Invalid OpenRouter provider slug.");
  }
  return {
    sort: sort as RoutingSort,
    upstream,
    allowFallbacks: value.allowFallbacks === true,
    maxInputPrice: price(value.maxInputPrice),
    maxOutputPrice: price(value.maxOutputPrice),
  };
}
function browserStorage(): RoutingStorage | undefined {
  if (typeof window === "undefined") return undefined;
  // Access errors must not silently discard a user's pinned-provider restriction.
  return window.localStorage;
}
function readDocument(storage?: RoutingStorage): RoutingDocument {
  if (!storage) return { version: 1, routes: Object.create(null) };
  const raw = storage.getItem(ROUTING_STORAGE_KEY);
  if (!raw) return { version: 1, routes: Object.create(null) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Saved OpenRouter routing is unreadable. Reset it in routing settings.");
  }
  if (!object(parsed) || parsed.version !== 1 || !object(parsed.routes)) {
    throw new Error("Saved OpenRouter routing has an unsupported format. Reset it in settings.");
  }
  const routes: Record<string, RoutingPreferences> = Object.create(null);
  for (const [model, prefs] of Object.entries(parsed.routes)) {
    routes[model] = validateRouting(prefs);
  }
  return { version: 1, routes };
}
export function readRouting(model: string, storage = browserStorage()): RoutingPreferences {
  return readDocument(storage).routes[model] ?? defaultRouting();
}
function announce(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ROUTING_CHANGED_EVENT));
}
export function writeRouting(
  model: string,
  prefs: RoutingPreferences,
  storage = browserStorage()
): void {
  if (!model.trim()) throw new Error("Select a model before saving its upstream provider.");
  if (!storage) throw new Error("Routing preferences cannot be saved in this window.");
  const document = readDocument(storage);
  document.routes[model] = validateRouting(prefs);
  storage.setItem(ROUTING_STORAGE_KEY, JSON.stringify(document));
  announce();
}
export function resetRouting(model: string, storage = browserStorage()): void {
  if (!storage) throw new Error("Routing preferences cannot be saved in this window.");
  const document = readDocument(storage);
  delete document.routes[model];
  storage.setItem(ROUTING_STORAGE_KEY, JSON.stringify(document));
  announce();
}
export function resetAllRouting(storage = browserStorage()): void {
  if (!storage) throw new Error("Routing preferences cannot be saved in this window.");
  // Only our new key. Never localStorage.clear(), secrets, or any other settings.
  storage.removeItem(ROUTING_STORAGE_KEY);
  announce();
}
export function isOpenRouterEndpoint(endpoint?: string | null): boolean {
  if (!endpoint) return false;
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      url.hostname === "openrouter.ai" &&
      (!url.port || url.port === "443") &&
      !url.username &&
      !url.password &&
      /^\/api\/v1(?:\/|$)/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
export function endpointCatalogUrl(model: string): string {
  // :nitro and :floor change routing, not the catalog entry. :free is a real variant.
  const id = model.replace(/:(?:nitro|floor)$/, "");
  const pieces = id.split("/");
  if (pieces.length !== 2 || pieces.some((part) => !part || part === "." || part === "..")) {
    throw new Error("This model does not have a standard OpenRouter endpoint catalog.");
  }
  return `https://openrouter.ai/api/v1/models/${pieces.map(encodeURIComponent).join("/")}/endpoints`;
}
export function parseEndpoints(payload: unknown): UpstreamEndpoint[] {
  if (!object(payload) || !object(payload.data) || !Array.isArray(payload.data.endpoints)) {
    throw new Error("OpenRouter returned an invalid provider catalog.");
  }
  const result = new Map<string, UpstreamEndpoint>();
  for (const item of payload.data.endpoints) {
    if (!object(item) || typeof item.tag !== "string" || !item.tag.trim()) continue;
    const tag = validateRouting({ upstream: item.tag }).upstream;
    const pricing = object(item.pricing) ? item.pricing : {};
    const latency = object(item.latency_last_30m) ? item.latency_last_30m : {};
    const throughput = object(item.throughput_last_30m) ? item.throughput_last_30m : {};
    const input = numberOrNull(pricing.prompt);
    const output = numberOrNull(pricing.completion);
    const endpoint: UpstreamEndpoint = {
      tag,
      name: typeof item.provider_name === "string" ? item.provider_name : tag,
      inputPerMillion: input === null ? null : input * 1_000_000,
      outputPerMillion: output === null ? null : output * 1_000_000,
      latencySeconds: numberOrNull(latency.p50),
      tokensPerSecond: numberOrNull(throughput.p50),
      status: numberOrNull(item.status),
    };
    // An identical routing tag cannot distinguish two entries. Keep the first entry.
    if (!result.has(tag)) result.set(tag, endpoint);
  }
  return [...result.values()].sort(
    (a, b) =>
      (a.latencySeconds ?? Infinity) - (b.latencySeconds ?? Infinity) || a.tag.localeCompare(b.tag)
  );
}
export function providerPreference(prefs: RoutingPreferences): ProviderPreference | undefined {
  const checked = validateRouting(prefs);
  const provider: ProviderPreference = {};
  if (checked.sort !== "default") provider.sort = checked.sort;
  if (checked.upstream) {
    if (checked.allowFallbacks) {
      provider.order = [checked.upstream];
      provider.allow_fallbacks = true;
    } else {
      provider.only = [checked.upstream];
      provider.allow_fallbacks = false;
    }
  }
  if (checked.maxInputPrice !== null || checked.maxOutputPrice !== null) {
    provider.max_price = {
      ...(checked.maxInputPrice === null ? {} : { prompt: checked.maxInputPrice }),
      ...(checked.maxOutputPrice === null ? {} : { completion: checked.maxOutputPrice }),
    };
  }
  return Object.keys(provider).length ? provider : undefined;
}
function moreSpecific(a: string, b: string): string | null {
  if (a === b || a.startsWith(`${b}/`)) return a;
  if (b.startsWith(`${a}/`)) return b;
  return null;
}
/** Preserve existing privacy restrictions and never silently broaden an existing allowlist. */
export function mergeProviderPreferences(
  existing: unknown,
  desired: ProviderPreference
): ProviderPreference {
  const old = object(existing) ? (existing as ProviderPreference) : {};
  for (const restriction of [old.only, old.order, desired.only, desired.order]) {
    if (
      restriction !== undefined &&
      (!Array.isArray(restriction) || restriction.some((tag) => typeof tag !== "string"))
    ) {
      throw new Error("Invalid existing OpenRouter provider restriction.");
    }
  }
  const combined: ProviderPreference = { ...old, ...desired };
  if (Array.isArray(old.only) && Array.isArray(desired.only)) {
    combined.only = [
      ...new Set(
        old.only.flatMap((a) =>
          desired.only!.map((b) => moreSpecific(a, b)).filter((v): v is string => v !== null)
        )
      ),
    ];
    if (!combined.only.length)
      throw new Error("Selected upstream conflicts with an existing provider restriction.");
  }
  if (
    Array.isArray(old.only) &&
    desired.order?.some((tag) => !old.only!.some((allowed) => moreSpecific(tag, allowed) !== null))
  )
    throw new Error("Selected upstream is excluded by an existing provider restriction.");
  if (old.allow_fallbacks === false) combined.allow_fallbacks = false;
  if (old.max_price || desired.max_price) {
    combined.max_price = { ...old.max_price, ...desired.max_price };
    for (const key of ["prompt", "completion"] as const) {
      const a = numberOrNull(old.max_price?.[key]);
      const b = numberOrNull(desired.max_price?.[key]);
      if (a !== null && b !== null) combined.max_price[key] = Math.min(a, b);
    }
  }
  return combined;
}
export function applyOpenRouterRouting(
  body: Record<string, unknown>,
  provider: string,
  endpoint?: string | null,
  storage?: RoutingStorage
): void {
  const isOpenRouter =
    isOpenRouterEndpoint(endpoint) || (provider.toLowerCase() === "openrouter" && !endpoint);
  if (!isOpenRouter || typeof body.model !== "string") return;
  const desired = providerPreference(readRouting(body.model, storage ?? browserStorage()));
  if (desired) body.provider = mergeProviderPreferences(body.provider, desired);
}
/** AI SDK requests take this path; raw Chat Completions use applyOpenRouterRouting above. */
export function createOpenRouterRoutingFetch(
  next: typeof fetch,
  disableReasoning = false,
  storage?: RoutingStorage
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const method = init?.method ?? request?.method ?? "GET";
    if (!isOpenRouterEndpoint(url) || method.toUpperCase() !== "POST") return next(input, init);
    const raw =
      typeof init?.body === "string"
        ? init.body
        : !init?.body && request
          ? await request.clone().text()
          : null;
    if (raw === null) return next(input, init);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return next(input, init);
    }
    if (!object(body)) return next(input, init);
    applyOpenRouterRouting(body, "openrouter", url, storage ?? browserStorage());
    if (disableReasoning) body.reasoning = { enabled: false };
    return next(input, { ...init, body: JSON.stringify(body) });
  };
}
