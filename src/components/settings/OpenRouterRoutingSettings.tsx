import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui/button";
import {
  applyOpenRouterRouting,
  defaultRouting,
  endpointCatalogUrl,
  parseEndpoints,
  providerPreference,
  readRouting,
  resetAllRouting,
  resetRouting,
  writeRouting,
  type RoutingPreferences,
  type RoutingSort,
  type UpstreamEndpoint,
} from "../../services/ai/openRouterRouting";

interface Props {
  model: string;
  apiKey: string;
  disableThinking: boolean;
}
const money = (value: number | null) => (value === null ? "—" : `$${value.toFixed(3)}`);
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Routing request failed.";
const fieldClass =
  "min-h-11 w-full rounded-md border border-border bg-background p-2 text-xs text-foreground";

/** Custom-build panel. Preferences apply to this OpenRouter model across LLM tabs. */
export default function OpenRouterRoutingSettings({ model, apiKey, disableThinking }: Props) {
  const id = useId();
  const [prefs, setPrefs] = useState<RoutingPreferences>(defaultRouting);
  const [inputCap, setInputCap] = useState("");
  const [outputCap, setOutputCap] = useState("");
  const [endpoints, setEndpoints] = useState<UpstreamEndpoint[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [testing, setTesting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const testController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      testController.current?.abort();
    };
  }, []);

  useEffect(() => {
    try {
      const saved = readRouting(model);
      setPrefs(saved);
      setInputCap(saved.maxInputPrice === null ? "" : String(saved.maxInputPrice));
      setOutputCap(saved.maxOutputPrice === null ? "" : String(saved.maxOutputPrice));
      setStorageError("");
      setDirty(false);
    } catch (error) {
      setStorageError(message(error));
    }
  }, [model]);

  useEffect(() => {
    const controller = new AbortController();
    let timedOut = false;
    let disposed = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12000);
    setLoading(true);
    setCatalogError("");
    setEndpoints([]);
    void (async () => {
      try {
        const response = await fetch(endpointCatalogUrl(model), {
          signal: controller.signal,
          headers: apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {},
          credentials: "omit",
          redirect: "error",
        });
        if (!response.ok) throw new Error(`Could not load providers (HTTP ${response.status}).`);
        const available = parseEndpoints(await response.json());
        if (disposed) return;
        setEndpoints(available);
        if (!available.length)
          setCatalogError("No provider routing tags were returned for this model.");
      } catch (error) {
        if (disposed) return;
        setCatalogError(
          timedOut ? "Provider lookup timed out. Use Refresh to retry." : message(error)
        );
      } finally {
        clearTimeout(timeout);
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [model, apiKey, revision]);

  const update = (patch: Partial<RoutingPreferences>) => {
    setPrefs((previous) => ({ ...previous, ...patch }));
    setDirty(true);
    setFeedback("");
  };
  const save = () => {
    try {
      const next = {
        ...prefs,
        maxInputPrice: inputCap.trim() === "" ? null : Number(inputCap),
        maxOutputPrice: outputCap.trim() === "" ? null : Number(outputCap),
      };
      writeRouting(model, next);
      setPrefs(next);
      setDirty(false);
      setStorageError("");
      setFeedback("Saved. Applies to future requests for this model; no API keys were changed.");
    } catch (error) {
      setStorageError(message(error));
    }
  };
  const reset = () => {
    try {
      resetRouting(model);
      setPrefs(defaultRouting());
      setInputCap("");
      setOutputCap("");
      setDirty(false);
      setStorageError("");
      setFeedback("Restored OpenRouter default routing for this model.");
    } catch (error) {
      setStorageError(message(error));
    }
  };
  const testRoute = async () => {
    if (!apiKey.trim() || dirty || testController.current || storageError) return;
    setTesting(true);
    setFeedback("");
    const controller = new AbortController();
    testController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    const start = performance.now();
    try {
      const body: Record<string, unknown> = {
        model,
        messages: [
          {
            role: "system",
            content:
              "Clean up the user's dictation. Preserve its meaning. Return only the cleaned text.",
          },
          { role: "user", content: "um send it on Tuesday actually Wednesday at nine thanks" },
        ],
        max_tokens: 512,
        ...(disableThinking ? { reasoning: { enabled: false } } : {}),
      };
      applyOpenRouterRouting(body, "openrouter", "https://openrouter.ai/api/v1/chat/completions");
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(
          `Route test failed (HTTP ${response.status}). Check provider availability, price limits and OpenRouter Activity.`
        );
      const result = await response.json();
      const duration = ((performance.now() - start) / 1000).toFixed(2);
      const upstream = typeof result.provider === "string" ? result.provider : "not reported";
      const text = result.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim())
        throw new Error(
          "The route returned no visible cleanup text. Check model reasoning support or token limits."
        );
      if (!mounted.current) return;
      setFeedback(
        `Provider: ${upstream}. Complete response: ${duration}s. Output: ${text.trim().slice(0, 500)}`
      );
    } catch (error) {
      if (!mounted.current) return;
      setFeedback(
        controller.signal.aborted ? "Route test timed out after 30 seconds." : message(error)
      );
    } finally {
      clearTimeout(timeout);
      testController.current = null;
      if (mounted.current) setTesting(false);
    }
  };
  const selected = endpoints.find((endpoint) => endpoint.tag === prefs.upstream);
  let preview = "";
  try {
    preview = JSON.stringify(
      providerPreference({
        ...prefs,
        maxInputPrice: inputCap.trim() === "" ? null : Number(inputCap),
        maxOutputPrice: outputCap.trim() === "" ? null : Number(outputCap),
      }) ?? {},
      null,
      2
    );
  } catch {
    /* Form displays validation on Save. */
  }

  return (
    <section
      className="space-y-3 rounded-lg border border-border p-3"
      aria-labelledby={`${id}-title`}
    >
      <div className="flex items-center justify-between gap-3">
        <h4 id={`${id}-title`} className="text-sm font-semibold">
          OpenRouter upstream routing
        </h4>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={loading}
          onClick={() => setRevision((n) => n + 1)}
        >
          {loading ? "Loading…" : "Refresh providers"}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs" htmlFor={`${id}-priority`}>
          <span>Routing priority</span>
          <select
            id={`${id}-priority`}
            className={fieldClass}
            value={prefs.sort}
            onChange={(e) => update({ sort: e.target.value as RoutingSort })}
          >
            <option value="default">OpenRouter default</option>
            <option value="latency">Lowest latency (first token)</option>
            <option value="throughput">Highest output speed</option>
            <option value="price">Lowest price</option>
          </select>
        </label>
        <label className="space-y-1 text-xs" htmlFor={`${id}-upstream`}>
          <span>Upstream provider</span>
          <select
            id={`${id}-upstream`}
            className={fieldClass}
            value={prefs.upstream}
            onChange={(e) => update({ upstream: e.target.value, allowFallbacks: false })}
          >
            <option value="">Any available provider</option>
            {prefs.upstream && !selected && (
              <option value={prefs.upstream}>{prefs.upstream} (saved; not in current list)</option>
            )}
            {endpoints.map((endpoint) => (
              <option key={endpoint.tag} value={endpoint.tag}>
                {endpoint.name} — {endpoint.tag}
              </option>
            ))}
          </select>
        </label>
      </div>
      {catalogError && (
        <p className="text-xs text-destructive" role="alert">
          {catalogError} Saved routing is not removed by a lookup failure.
        </p>
      )}
      {prefs.upstream && (
        <label className="flex min-h-11 items-center gap-2 text-xs">
          <input
            className="h-5 w-5"
            type="checkbox"
            checked={prefs.allowFallbacks}
            onChange={(e) => update({ allowFallbacks: e.target.checked })}
          />
          <span>
            Allow other providers if this provider is unavailable. This can change cost and latency.
          </span>
        </label>
      )}
      {prefs.upstream && !prefs.allowFallbacks && (
        <p className="text-xs text-muted-foreground">
          Strict selection: the request fails rather than switching to a different provider.
          OpenWhispr may paste the raw transcript if cleanup fails.
        </p>
      )}
      {selected && (
        <p className="text-xs text-muted-foreground">
          Listed rate: {money(selected.inputPerMillion)} input / {money(selected.outputPerMillion)}{" "}
          output per million tokens. Recent median:{" "}
          {selected.latencySeconds === null ? "—" : `${selected.latencySeconds.toFixed(2)}s`}{" "}
          first-token latency;{" "}
          {selected.tokensPerSecond === null ? "—" : selected.tokensPerSecond.toFixed(0)} tokens/s.
        </p>
      )}
      {endpoints.length > 0 && (
        <details className="text-xs">
          <summary className="flex min-h-11 cursor-pointer items-center">
            Compare available providers
          </summary>
          <div className="mt-2 max-h-48 overflow-auto">
            <table className="w-full min-w-[32rem] table-fixed text-left text-xs">
              <caption className="sr-only">
                Provider rates in USD per million tokens and recent median performance
              </caption>
              <colgroup>
                <col className="w-[36%]" />
                <col className="w-[16%]" />
                <col className="w-[16%]" />
                <col className="w-[16%]" />
                <col className="w-[16%]" />
              </colgroup>
              <thead>
                <tr>
                  <th className="p-1">Provider</th>
                  <th className="p-1 text-right">Input</th>
                  <th className="p-1 text-right">Output</th>
                  <th className="p-1 text-right">Latency</th>
                  <th className="p-1 text-right">Tokens/s</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((endpoint) => (
                  <tr key={endpoint.tag} className="border-t border-border">
                    <td className="truncate p-1" title={`${endpoint.name} (${endpoint.tag})`}>
                      {endpoint.name}
                    </td>
                    <td className="p-1 text-right tabular-nums">
                      {money(endpoint.inputPerMillion)}
                    </td>
                    <td className="p-1 text-right tabular-nums">
                      {money(endpoint.outputPerMillion)}
                    </td>
                    <td className="p-1 text-right tabular-nums">
                      {endpoint.latencySeconds === null
                        ? "—"
                        : `${endpoint.latencySeconds.toFixed(2)}s`}
                    </td>
                    <td className="p-1 text-right tabular-nums">
                      {endpoint.tokensPerSecond?.toFixed(0) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <details className="space-y-2 text-xs">
        <summary className="flex min-h-11 cursor-pointer items-center">
          Optional price ceilings
        </summary>
        <div className="grid grid-cols-2 gap-3 pt-2">
          <label className="space-y-1" htmlFor={`${id}-input-cap`}>
            <span>Max input USD / million</span>
            <input
              id={`${id}-input-cap`}
              className={fieldClass}
              type="number"
              min="0"
              step="any"
              placeholder="No ceiling"
              value={inputCap}
              onChange={(e) => {
                setInputCap(e.target.value);
                setDirty(true);
              }}
            />
          </label>
          <label className="space-y-1" htmlFor={`${id}-output-cap`}>
            <span>Max output USD / million</span>
            <input
              id={`${id}-output-cap`}
              className={fieldClass}
              type="number"
              min="0"
              step="any"
              placeholder="No ceiling"
              value={outputCap}
              onChange={(e) => {
                setOutputCap(e.target.value);
                setDirty(true);
              }}
            />
          </label>
        </div>
        <p className="text-muted-foreground">
          These are rate ceilings, not a spending budget. Requests fail when no eligible route meets
          them. Blank means no limit.
        </p>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" className="min-h-11" onClick={save}>
          Save routing
        </Button>
        <Button type="button" size="sm" className="min-h-11" variant="outline" onClick={reset}>
          Reset this model
        </Button>
        <Button
          type="button"
          size="sm"
          className="min-h-11"
          variant="outline"
          disabled={!apiKey.trim() || dirty || testing || !!storageError}
          onClick={() => void testRoute()}
        >
          {testing ? "Testing…" : "Test route (billable)"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        First-token latency is not the entire cleanup delay. The test measures the complete response
        using synthetic text. No real dictation is sent by this test.
      </p>
      {dirty && (
        <p className="text-xs text-muted-foreground">
          Unsaved changes — click Save routing before testing.
        </p>
      )}
      {storageError && (
        <div className="space-y-2 text-xs text-destructive" role="alert">
          <p>{storageError}</p>
          <button
            type="button"
            className="underline"
            onClick={() => {
              if (
                !window.confirm(
                  "Reset all OpenRouter routing preferences? Your API keys and other settings will not be changed."
                )
              )
                return;
              try {
                resetAllRouting();
                setStorageError("");
                setPrefs(defaultRouting());
                setInputCap("");
                setOutputCap("");
                setDirty(false);
              } catch (error) {
                setStorageError(message(error));
              }
            }}
          >
            Reset only the added routing preferences
          </button>
        </div>
      )}
      {feedback && (
        <p className="break-words text-xs" role="status">
          {feedback}
        </p>
      )}
      <details className="text-xs">
        <summary className="flex min-h-11 cursor-pointer items-center">
          Request routing preview
        </summary>
        <pre className="mt-2 overflow-auto rounded bg-muted p-2">{preview}</pre>
      </details>
    </section>
  );
}
