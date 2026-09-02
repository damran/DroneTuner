import type { ProfileSettings } from "@dronetuner/shared";
import { fitFilterSliders, fitSimplifiedSliders } from "@dronetuner/shared/tuning";

/**
 * A tune expressed as Betaflight 4.5 simplified-tuning slider positions
 * (master fixed at 100). Shown in Advanced mode next to templates and vendor
 * presets so a slider-tuned pilot can read a tune in the units they use.
 * Terms no slider set can reproduce are named instead of glossed over.
 */
export default function SimplifiedSliders({ settings, compact = false }: { settings: ProfileSettings; compact?: boolean }) {
  const fit = fitSimplifiedSliders(settings);
  const filters = fitFilterSliders(settings.filters);
  if (!fit) return null;
  const s = fit.sliders;
  const items: [string, string | number][] = [
    ["Master", s.master],
    ["PI", s.piGain],
    ["I", s.iGain],
    ["D", s.dGain],
    ["D max", s.dminRatio],
    ["FF", s.feedforwardGain],
    ["Pitch PI", s.pitchPiGain],
    ["Pitch D", s.rollPitchRatio],
    ["Mode", s.mode],
  ];
  if (filters.dtermMultiplier > 0) items.push(["D-term filter", filters.dtermMultiplier]);
  if (filters.gyroMultiplier > 0) items.push(["Gyro filter", filters.gyroMultiplier]);
  const off = [...fit.offTerms, ...filters.offTerms];
  return (
    <div className={compact ? "text-xs" : "text-sm"}>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">Sliders</span>
        {items.map(([k, v]) => (
          <span key={k} className="text-muted-foreground">
            {k} <span className="font-mono text-foreground">{v}</span>
          </span>
        ))}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {off.length === 0
          ? `Reproduces the tune within ${fit.maxErrorPercent.toFixed(1)} % (master fixed at 100).`
          : `Not a pure slider tune: ${off.join(", ")} would be more than 5 % off (master fixed at 100).`}
      </p>
    </div>
  );
}
