import { useId } from "react";
import { useEscapeCancellation } from "../../hooks/useEscapeCancellation";

export default function EscapeCancellationSettings() {
  const { enabled, ready, saving, error, setEnabled } = useEscapeCancellation();
  const labelId = useId();
  const helpId = useId();
  return (
    <section className="rounded-lg border border-border/70 bg-card/50 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 id={labelId} className="text-sm font-medium text-foreground">
            Escape cancels dictation
          </h3>
          <p id={helpId} className="mt-1 text-xs leading-relaxed text-muted-foreground">
            When off, Escape will not discard a recording or cancel transcription or text cleanup.
            Your dictation hotkey still stops and submits audio; the on-screen Cancel button still
            cancels it.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby={labelId}
          aria-describedby={helpId}
          disabled={!ready || saving}
          onClick={() => void setEnabled(!enabled)}
          className={`inline-flex min-h-11 min-w-14 shrink-0 items-center justify-center rounded-md border px-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${enabled ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted text-foreground"}`}
        >
          {saving ? "Saving…" : enabled ? "On" : "Off"}
        </button>
      </div>
      {!ready && !error && (
        <p className="mt-2 text-xs text-muted-foreground">Loading saved preference…</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
