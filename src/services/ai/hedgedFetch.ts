/**
 * A dictation cleanup is waited on: the text isn't pasted until it answers. One
 * OpenRouter host can stall on a request it normally answers in half a second
 * (ModelRun took 35 s once), so a cleanup that hasn't answered after
 * HEDGE_DELAY_MS is sent again to the fastest other host, and whichever answers
 * first is used. The other request is aborted. A stall then costs about a
 * second instead of the whole client deadline, for one extra cleanup's tokens.
 */
export const HEDGE_DELAY_MS = 1200;

type Body = Record<string, unknown>;

/**
 * The same request, sent to the highest-throughput host other than the ones it pinned. Every other provider
 * preference (price ceilings, data policy, quantizations) is kept, so the hedge never goes where the first request
 * wasn't allowed to.
 */
export function hedgeOpenRouterBody(body: Body): Body {
  const provider = (
    body.provider && typeof body.provider === "object" ? body.provider : {}
  ) as Body;
  const { order, only, allow_fallbacks: _fallbacks, sort: _sort, ignore, ...kept } = provider;
  const pinned = [order, only]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((slug): slug is string => typeof slug === "string" && slug.length > 0);
  const ignored = [...(Array.isArray(ignore) ? ignore : []), ...pinned];
  const hedge: Body = { ...kept, sort: "throughput" };
  if (ignored.length) hedge.ignore = [...new Set(ignored)];
  return { ...body, provider: hedge };
}

interface Outcome {
  ok: boolean;
  response: Response;
}

/**
 * Sends [body] with [send], and after [delayMs] without a successful answer
 * sends the hedged body too. Resolves with the first 2xx answer (its body already
 * read, so a host that sends headers early and stalls doesn't win), or, when both
 * fail, with the first request's answer so the caller's error handling sees it.
 * Aborting [signal] aborts both.
 */
export async function hedgedFetch(
  send: (body: string, signal: AbortSignal) => Promise<Response>,
  body: Body,
  signal: AbortSignal,
  delayMs = HEDGE_DELAY_MS
): Promise<Response> {
  const controllers = [new AbortController(), new AbortController()];
  const abortAll = () => controllers.forEach((c) => c.abort());
  if (signal.aborted) abortAll();
  else signal.addEventListener("abort", abortAll, { once: true });

  const attempt = async (payload: Body, controller: AbortController): Promise<Outcome> => {
    const res = await send(JSON.stringify(payload), controller.signal);
    const text = await res.text();
    const response = new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
    return { ok: res.ok, response };
  };

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let primary: Outcome | Error | null = null;
    let hedgeDone = false;
    let hedgeStarted = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (winner: number, response: Response) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abortAll);
      controllers.forEach((c, i) => i !== winner && c.abort());
      resolve(response);
    };
    const fail = () => {
      if (settled) return;
      // Both have answered without success: hand back the primary's answer or error.
      if (primary instanceof Error) {
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", abortAll);
        reject(primary);
      } else if (primary) {
        finish(0, primary.response);
      }
    };
    const startHedge = () => {
      if (settled || hedgeStarted) return;
      hedgeStarted = true;
      attempt(hedgeOpenRouterBody(body), controllers[1]).then(
        (outcome) => {
          hedgeDone = true;
          if (outcome.ok) finish(1, outcome.response);
          else if (primary) fail();
        },
        () => {
          hedgeDone = true;
          if (primary) fail();
        }
      );
    };

    attempt(body, controllers[0]).then(
      (outcome) => {
        primary = outcome;
        if (outcome.ok) finish(0, outcome.response);
        else if (!hedgeStarted) startHedge();
        else if (hedgeDone) fail();
      },
      (error: Error) => {
        primary = error;
        if (signal.aborted) {
          settled = true;
          if (timer) clearTimeout(timer);
          reject(error);
        } else if (!hedgeStarted) startHedge();
        else if (hedgeDone) fail();
      }
    );
    timer = setTimeout(startHedge, delayMs);
  });
}
