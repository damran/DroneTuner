import { useState } from "react";
import type { ActionCardProposal } from "@dronetuner/shared";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useApplyStore } from "@/lib/apply-store";

export default function ActionCard({ card }: { card: ActionCardProposal }) {
  const navigate = useNavigate();
  const start = useApplyStore((s) => s.start);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const onApply = () => {
    let started = false;
    if (card.kind === "apply_profile" && card.profileId) {
      start({ droneId: card.droneId, profileId: card.profileId, profileName: card.profileName });
      started = true;
    } else if (card.settings && Object.keys(card.settings).length > 0) {
      start({ droneId: card.droneId, settings: card.settings });
      started = true;
    }
    if (started) navigate(`/drones/${card.droneId}`);
  };

  return (
    <Card className="my-2 border-primary/40">
      <CardHeader className="p-3">
        <CardTitle className="text-sm">{card.title}</CardTitle>
        <CardDescription className="text-xs">{card.rationale}</CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2 p-3 pt-0">
        <Button size="sm" onClick={onApply}>
          Review &amp; apply
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDismissed(true)}>
          Dismiss
        </Button>
      </CardContent>
    </Card>
  );
}
