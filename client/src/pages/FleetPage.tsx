import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import type { DroneSummary } from "@dronetuner/shared";
import { SIZE_CLASSES, VIDEO_SYSTEMS, VIDEO_SYSTEM_LABELS } from "@dronetuner/shared";
import { apiGet, apiPost, photoUrl } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export default function FleetPage() {
  const qc = useQueryClient();
  const { data: drones, isLoading } = useQuery({
    queryKey: ["drones"],
    queryFn: () => apiGet<DroneSummary[]>("/api/drones"),
  });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [sizeClass, setSizeClass] = useState("65mm");
  const [videoSystem, setVideoSystem] = useState<string>("analog");
  const [notes, setNotes] = useState("");

  const create = useMutation({
    mutationFn: () => apiPost("/api/drones", { name, sizeClass, videoSystem, notes: notes || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["drones"] });
      setOpen(false);
      setName("");
      setNotes("");
    },
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Fleet</h1>
          <p className="text-sm text-muted-foreground">Your quads, their builds, and their logs.</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> Add drone
        </Button>
      </div>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-52" />
          ))}
        </div>
      )}

      {!isLoading && drones?.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No drones yet. Add your first quad to get started.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {drones?.map((d) => (
          <Link
            key={d.id}
            to={`/drones/${d.id}`}
            className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Card className="h-full overflow-hidden transition-colors hover:border-primary/50">
              <div className="aspect-video bg-muted">
                {d.primaryPhotoPath ? (
                  <img src={photoUrl(d.primaryPhotoPath)} alt={d.name} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    No photo
                  </div>
                )}
              </div>
              <CardContent className="p-4">
                <h3 className="truncate font-medium" title={d.name}>
                  {d.name}
                </h3>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge variant="secondary">{d.sizeClass}</Badge>
                  {d.videoSystem && <Badge variant="outline">{d.videoSystem === "hd" ? "HD" : "Analog"}</Badge>}
                </div>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  <dt className="text-muted-foreground">Last flight</dt>
                  <dd>{d.lastFlightDate ? formatDate(d.lastFlightDate) : "—"}</dd>
                  <dt className="text-muted-foreground">Build</dt>
                  <dd>{d.componentCount === 0 ? "no components yet" : `${d.componentCount} component${d.componentCount === 1 ? "" : "s"}`}</dd>
                  <dt className="text-muted-foreground">Profile</dt>
                  <dd className="truncate" title={d.activeProfileName ?? undefined}>
                    {d.activeProfileName ?? "—"}
                  </dd>
                </dl>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add drone</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 65mm Whoop #1" />
            </div>
            <div className="space-y-1">
              <Label>Size class</Label>
              <Select value={sizeClass} onValueChange={setSizeClass}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIZE_CLASSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Video system</Label>
              <Select value={videoSystem} onValueChange={setVideoSystem}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VIDEO_SYSTEMS.map((v) => (
                    <SelectItem key={v} value={v}>
                      {VIDEO_SYSTEM_LABELS[v]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">HD air units add mass; templates and vendor baselines are matched on this.</p>
            </div>
            <div className="space-y-1">
              <Label>Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          {create.isError && (
            <p className="text-sm text-destructive">{(create.error as Error).message}</p>
          )}
          <DialogFooter>
            <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
