import { create } from "zustand";
import type { ProfileSettings } from "@dronetuner/shared";

export interface ApplyPayload {
  droneId: number;
  profileId?: number;
  profileName?: string;
  settings?: ProfileSettings;
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
  start: (payload) => set({ payload, open: true }),
  close: () => set({ payload: null, open: false }),
}));
