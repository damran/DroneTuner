import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DroneSummary, Profile } from "@dronetuner/shared";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import ProfilesList from "@/components/ProfilesList";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function ProfilesPage() {
  const qc = useQueryClient();
  const [droneId, setDroneId] = useState<string>("");

  const { data: drones } = useQuery({
    queryKey: ["drones"],
    queryFn: () => apiGet<DroneSummary[]>("/api/drones"),
  });
  const { data: templates } = useQuery({
    queryKey: ["templates"],
    queryFn: () => apiGet<Profile[]>("/api/profiles?templates=1"),
  });
  const { data: droneProfiles } = useQuery({
    queryKey: ["profiles", droneId],
    enabled: !!droneId,
    queryFn: () => apiGet<Profile[]>(`/api/profiles?droneId=${droneId}`),
  });

  const duplicateTemplate = useMutation({
    mutationFn: (templateId: number) => apiPost(`/api/profiles/${templateId}/duplicate`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["templates"] }),
  });

  /** Copy a template into the selected drone's profiles. */
  const attachToDrone = (templateId: number) => {
    const t = templates?.find((x) => x.id === templateId);
    if (!t || !droneId) return;
    void apiPost("/api/profiles", {
      name: t.name,
      goal: t.goal,
      sizeClass: t.sizeClass,
      droneId: Number(droneId),
      settings: t.settings,
      source: "template",
    }).then(() => qc.invalidateQueries({ queryKey: ["profiles", droneId] }));
  };

  const onTemplateDuplicate = (templateId: number) => {
    // With a drone selected, duplicating a template means "use it on this
    // drone"; otherwise it's a plain library copy.
    if (droneId) attachToDrone(templateId);
    else duplicateTemplate.mutate(templateId);
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Profiles</h1>
        <p className="text-sm text-muted-foreground">
          Baseline templates per drone class and goal, plus per-drone profiles.
        </p>
      </div>

      <div className="mb-4 flex items-end gap-3">
        <div className="space-y-1">
          <Label>Drone</Label>
          <Select value={droneId} onValueChange={setDroneId}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Select drone…" />
            </SelectTrigger>
            <SelectContent>
              {(drones ?? []).map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Template library</CardTitle>
          </CardHeader>
          <CardContent>
            <ProfilesList
              profiles={templates ?? []}
              onDuplicate={onTemplateDuplicate}
            />
            {droneId && (
              <p className="mt-3 text-xs text-muted-foreground">
                To use a template on the selected drone, duplicate it — the copy becomes a per-drone profile you can
                apply from the drone&apos;s Profiles tab.
              </p>
            )}
          </CardContent>
        </Card>

        {droneId && (
          <Card>
            <CardHeader>
              <CardTitle>Profiles for this drone</CardTitle>
            </CardHeader>
            <CardContent>
              <ProfilesList
                profiles={droneProfiles ?? []}
                droneId={Number(droneId)}
                onDelete={(id) =>
                  void apiDelete(`/api/profiles/${id}`).then(() =>
                    qc.invalidateQueries({ queryKey: ["profiles", droneId] }),
                  )
                }
                onDuplicate={(id) =>
                  void apiPost(`/api/profiles/${id}/duplicate`).then(() =>
                    qc.invalidateQueries({ queryKey: ["profiles", droneId] }),
                  )
                }
              />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
