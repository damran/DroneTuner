import { create } from "zustand";
import type { ProfileSettings } from "@dronetuner/shared";
import { partitionCliOnly } from "@dronetuner/shared/tuning";

/** One side of an in-flight A/B test: a full settings set for one PID profile slot. */
export interface AbVariantPayload {
  side: "A" | "B";
  /** e.g. "A · Crisp" */
  label: string;
  /** 0-based PID profile (kind "pid") or rate profile (kind "rate") slot to write into */
  profile: number;
  settings: ProfileSettings;
  cliOnlyStripped?: string[];
}

export interface ApplyPayload {
  droneId: number;
  profileId?: number;
  profileName?: string;
  settings?: ProfileSettings;
  /** CLI-only keys removed from `settings` (not MSP-writable on BF 4.4/4.5) —
   *  shown in the confirm dialog so the diff matches what will be written. */
  cliOnlyStripped?: string[];
  /**
   * A/B mode: write each variant into its own PID profile (snapshot each
   * slot first), then leave profile A active. Mutually exclusive with `settings`.
   */
  ab?: AbVariantPayload[];
  /** Which profile slots the A/B switches: PID profiles (default) or rate profiles. */
  abKind?: "pid" | "rate";
  /** Wizard pair that produced the A/B (shared/src/tuning/pairs.ts), recorded with the test. */
  abPairId?: string;
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
    if (payload.ab) {
      const ab = payload.ab.map((v) => {
        const { msp, stripped } = partitionCliOnly(v.settings);
        return { ...v, settings: msp, cliOnlyStripped: stripped };
      });
      set({ payload: { ...payload, ab }, open: true });
      return;
    }
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
