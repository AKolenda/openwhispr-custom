import { useEffect, useSyncExternalStore } from "react";
import {
  createEscapePreferenceClient,
  type EscapeCancellationApi,
} from "../services/escapeCancellationPreference";

const bridge =
  typeof window === "undefined"
    ? undefined
    : (window.electronAPI as unknown as Partial<EscapeCancellationApi>);
const client = createEscapePreferenceClient(bridge);

// Event handlers read the current value directly, rather than a stale render.
export const getEscapeCancellationEnabled = () => client.getSnapshot().enabled;

export function useEscapeCancellation() {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => client.connect(), []);
  return { ...snapshot, setEnabled: client.setEnabled };
}
