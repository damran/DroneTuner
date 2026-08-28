import { create } from "zustand";
import type { ProfileSettings } from "@dronetuner/shared";
import { partitionCliOnly } from "@dronetuner/shared/tuning";

export interface ApplyPayload {
  droneId: number;
  profileId?: number;
  profileName?: string;
  settings?: ProfileSettings;
  /** CLI-only keys removed from `settings` (not MSP-writable on BF 4.4/4.5) —
   *  shown in the confirm dialog so the diff matches what will be written. */
  cliOnlyStripped?: string[];
}

interface ApplyState {
  payload: ApplyPayload | null;
  open: boolean;
  start: (payload: ApplyPayload) => void;
  close: () => void;
}

export const useApplyStore = create<ApplyState>((set) => ({
  payload: null,
  open: false,
  start: (payload) => {
    // Single choke point: CLI-only keys never reach the MSP write path, no
    // matter which UI (wizard, chat card, baseline panel) started the flow.
    if (payload.settings) {
      const { msp, stripped } = partitionCliOnly(payload.settings);
      if (stripped.length > 0) {
        set({ payload: { ...payload, settings: msp, cliOnlyStripped: stripped }, open: true });
        return;
      }
    }
    set({ payload, open: true });
  },
  close: () => set({ payload: null, open: false }),
}));
