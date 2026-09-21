/** Typed preload contract kept local to this additive community feature. */
export interface EscapeCancellationApi {
  getEscapeCancelsDictation: () => Promise<boolean>;
  setEscapeCancelsDictation: (enabled: boolean) => Promise<{
    success: boolean;
    enabled: boolean;
    error?: string;
    shortcutActive?: boolean;
  }>;
  onEscapeCancelsDictationChanged: (callback: (enabled: boolean) => void) => () => void;
}

export interface EscapePreferenceSnapshot {
  enabled: boolean;
  ready: boolean;
  saving: boolean;
  error: string | null;
}

export interface DictationActivity {
  isRecording?: boolean;
  isPreparing?: boolean;
  isProcessing?: boolean;
  isStopping?: boolean;
}

export function shouldProtectDictationFromEscape(
  enabled: boolean,
  activity: DictationActivity
): boolean {
  return (
    !enabled &&
    !!(activity.isRecording || activity.isPreparing || activity.isProcessing || activity.isStopping)
  );
}

/** One synchronous snapshot shared by all consumers in a renderer. */
export function createEscapePreferenceClient(api: Partial<EscapeCancellationApi> | undefined) {
  let snapshot: EscapePreferenceSnapshot = {
    enabled: false,
    ready: false,
    saving: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  let connections = 0;
  let session = 0;
  let revision = 0;
  let unsubscribe: (() => void) | undefined;
  function update(patch: Partial<EscapePreferenceSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }
  const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : "Could not update Escape preference.";

  const client = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect() {
      connections += 1;
      if (connections === 1) {
        const token = ++session;
        // Until the persisted preference is known, protect the recording.
        update({ enabled: false, ready: false, error: null });
        const startRevision = revision;
        if (!api?.getEscapeCancelsDictation || !api.onEscapeCancelsDictationChanged) {
          update({ ready: false, error: "This build's Escape preference bridge is unavailable." });
        } else {
          try {
            unsubscribe = api.onEscapeCancelsDictationChanged((value) => {
              if (token !== session || typeof value !== "boolean") return;
              revision += 1;
              update({ enabled: value, ready: true, error: null });
            });
            void api
              .getEscapeCancelsDictation()
              .then((value) => {
                if (token !== session || revision !== startRevision) return;
                if (typeof value !== "boolean")
                  throw new Error("Invalid Escape preference response.");
                update({ enabled: value, ready: true });
              })
              .catch((error: unknown) => {
                if (token === session && revision === startRevision)
                  update({ error: errorMessage(error) });
              });
          } catch (error) {
            update({ error: errorMessage(error) });
          }
        }
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        connections -= 1;
        if (connections === 0) {
          session += 1;
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },
    async setEnabled(value: boolean) {
      if (snapshot.saving) return;
      if (typeof value !== "boolean" || !api?.setEscapeCancelsDictation) {
        update({ error: "Cannot save Escape preference in this build." });
        return;
      }
      const startRevision = revision;
      update({ saving: true, error: null });
      try {
        const result = await api.setEscapeCancelsDictation(value);
        if (revision === startRevision && typeof result.enabled === "boolean") {
          revision += 1;
          update({ enabled: result.enabled, ready: true });
        }
        if (!result.success) throw new Error(result.error || "Could not apply Escape preference.");
      } catch (error) {
        update({ error: errorMessage(error) });
      } finally {
        update({ saving: false });
      }
    },
  };
  return client;
}
