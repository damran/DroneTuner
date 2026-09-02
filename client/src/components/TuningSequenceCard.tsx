import { AB_PAIR_BY_ID, TUNING_SEQUENCE, type AbPairId, type TuningSequenceStatus, type TuningStepId } from "@dronetuner/shared/tuning";
import { useAdvanced } from "@/lib/ui-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  status: TuningSequenceStatus;
  /** tick / untick a step (stored per drone) */
  onToggle: (step: TuningStepId, done: boolean) => void;
  /** select a pair in the A/B card */
  onPickPair: (id: AbPairId) => void;
  saving?: TuningStepId | null;
}

/**
 * The tuning sequence (Chris Rosser's masterclass order, with Brian White's
 * PIDtoolbox variant noted) with per-drone progress: steps auto-complete from
 * data ("flown": a log analysed, an A/B pair of that step recorded) and the
 * pilot ticks them off. The next open step is expanded.
 */
export default function TuningSequenceCard({ status, onToggle, onPickPair, saving }: Props) {
  const advanced = useAdvanced();
  const stateOf = (id: TuningStepId) => status.steps.find((s) => s.id === id);
  return (
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="text-sm">Tuning sequence</CardTitle>
        <p className="text-xs text-muted-foreground">
          Rosser's order: filters → master → P:D → I → feedforward → dynamic damping → rates (Brian White does the P:D
          ratio before the master). Steps tick themselves when the data shows they were flown; tick them yourself when
          you decided.
        </p>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <ol className="space-y-2">
          {TUNING_SEQUENCE.map((step, i) => {
            const st = stateOf(step.id);
            const state = st?.state ?? "todo";
            const isNext = status.nextId === step.id;
            return (
              <li
                key={step.id}
                className={`rounded-lg border p-3 ${isNext ? "border-primary bg-accent/30" : state === "done" ? "opacity-70" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`${step.title} done`}
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                    checked={state === "done"}
                    disabled={saving === step.id}
                    onChange={(e) => onToggle(step.id, e.target.checked)}
                  />
                  <span className="text-sm font-medium">
                    {i + 1}. {step.title}
                  </span>
                  {state === "done" && <Badge variant="success">done</Badge>}
                  {state === "flown" && (
                    <Badge variant="info" title={st?.evidence ?? undefined}>
                      flown
                    </Badge>
                  )}
                  {isNext && <Badge variant="secondary">next</Badge>}
                </div>
                {(isNext || advanced) && (
                  <details open={isNext} className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground">{step.goal}</summary>
                    <div className="mt-2 space-y-1 text-xs">
                      <p>
                        <span className="font-medium">Fly:</span> {step.fly}
                      </p>
                      <p>
                        <span className="font-medium">Decides:</span> {step.decide}
                      </p>
                      {advanced && (
                        <p className="text-muted-foreground">
                          <span className="font-medium">Source:</span> {step.source}
                        </p>
                      )}
                      {step.pairs.length > 0 && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {step.pairs.map((id) => (
                            <Button key={id} size="sm" variant="outline" onClick={() => onPickPair(id)}>
                              Set up: {AB_PAIR_BY_ID[id].title}
                            </Button>
                          ))}
                        </div>
                      )}
                      {st?.evidence && <p className="text-muted-foreground">Evidence: {st.evidence}.</p>}
                    </div>
                  </details>
                )}
                {!isNext && !advanced && <p className="mt-1 text-xs text-muted-foreground">{step.goal}</p>}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
