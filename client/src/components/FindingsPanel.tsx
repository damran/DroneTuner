import type { Finding } from "@dronetuner/shared";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

const severityVariant = {
  info: "info",
  warning: "warning",
  critical: "destructive",
} as const;

export default function FindingsPanel({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return <p className="text-sm text-muted-foreground">No notable findings.</p>;
  }
  return (
    <div className="space-y-2">
      {findings.map((f) => (
        <Card key={f.id} className="p-3">
          <div className="flex items-center gap-2">
            <Badge variant={severityVariant[f.severity]}>{f.severity}</Badge>
            <span className="text-sm font-medium">{f.title}</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{f.detail}</p>
        </Card>
      ))}
    </div>
  );
}
