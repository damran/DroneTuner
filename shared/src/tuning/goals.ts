import type { TuneGoal } from "../types/entities";

export interface GoalWeights {
  /** how much the goal values crisp response / authority */
  response: number;
  /** how much it values smoothness / low noise */
  smoothness: number;
  /** how much it values efficiency / battery life */
  efficiency: number;
  /** how much it values low latency / minimal filtering */
  latency: number;
}

export const GOAL_WEIGHTS: Record<TuneGoal, GoalWeights> = {
  racing: { response: 1.0, smoothness: 0.4, efficiency: 0.2, latency: 0.8 },
  freestyle: { response: 0.7, smoothness: 0.8, efficiency: 0.4, latency: 0.5 },
  cinematic: { response: 0.3, smoothness: 1.0, efficiency: 0.6, latency: 0.2 },
  efficiency: { response: 0.4, smoothness: 0.6, efficiency: 1.0, latency: 0.3 },
  low_noise: { response: 0.2, smoothness: 1.0, efficiency: 0.5, latency: 0.1 },
  low_latency: { response: 0.9, smoothness: 0.3, efficiency: 0.2, latency: 1.0 },
};

export function goalWeights(goal: string): GoalWeights {
  return GOAL_WEIGHTS[goal as TuneGoal] ?? GOAL_WEIGHTS.freestyle;
}
