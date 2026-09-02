import type { Profile } from "@dronetuner/shared";
import { TUNE_GOAL_LABELS } from "@dronetuner/shared";
import { Copy, Download, Play, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useApplyStore } from "@/lib/apply-store";
import { useAdvanced } from "@/lib/ui-store";
import SimplifiedSliders from "./SimplifiedSliders";

export default function ProfilesList({
  profiles,
  droneId,
  onDelete,
  onDuplicate,
}: {
  profiles: Profile[];
  droneId?: number;
  onDelete?: (id: number) => void;
  onDuplicate?: (id: number) => void;
}) {
  const start = useApplyStore((s) => s.start);
  const advanced = useAdvanced();

  if (profiles.length === 0) {
    return <p className="text-sm text-muted-foreground">No profiles yet.</p>;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {profiles.map((p) => (
        <Card key={p.id}>
          <CardHeader className="p-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">{p.name}</CardTitle>
              <Badge variant="secondary">{TUNE_GOAL_LABELS[p.goal as keyof typeof TUNE_GOAL_LABELS] ?? p.goal}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {p.sizeClass ? `${p.sizeClass} · ` : ""}
              {p.source}
            </p>
          </CardHeader>
          {advanced && (
            <CardContent className="p-4 pt-0">
              <SimplifiedSliders settings={p.settings} compact />
            </CardContent>
          )}
          <CardContent className="flex flex-wrap gap-2 p-4 pt-0">
            {droneId && (
              <Button
                size="sm"
                onClick={() => start({ droneId, profileId: p.id, profileName: p.name })}
              >
                <Play className="h-3.5 w-3.5" /> Apply
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const blob = new Blob([JSON.stringify(p.settings, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${p.name.replace(/\s+/g, "_")}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            {onDuplicate && (
              <Button size="sm" variant="outline" onClick={() => onDuplicate(p.id)}>
                <Copy className="h-3.5 w-3.5" /> Duplicate
              </Button>
            )}
            {onDelete && (
              <Button size="sm" variant="ghost" onClick={() => onDelete(p.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
