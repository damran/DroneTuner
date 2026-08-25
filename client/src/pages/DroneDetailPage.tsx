import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Camera, Star, Trash2, Upload } from "lucide-react";
import type { Component, ComponentCategory, DroneDetail, Flight, Profile } from "@dronetuner/shared";
import { COMPONENT_CATEGORIES, COMPONENT_CATEGORY_LABELS, FLIGHT_STYLE_TAGS } from "@dronetuner/shared";
import { apiDelete, apiGet, apiPatch, apiPost, photoUrl } from "@/lib/api";
import { formatDate, formatDuration } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import ConnectPanel from "@/components/ConnectPanel";
import BaselinePanel from "@/components/BaselinePanel";
import ProfilesList from "@/components/ProfilesList";

export default function DroneDetailPage() {
  const { id } = useParams();
  const droneId = Number(id);
  const validId = Number.isInteger(droneId) && droneId > 0;
  const qc = useQueryClient();
  const { data: drone, isLoading } = useQuery({
    queryKey: ["drone", droneId],
    enabled: validId,
    queryFn: () => apiGet<DroneDetail>(`/api/drones/${droneId}`),
  });

  if (!validId) {
    return <p className="text-sm text-muted-foreground">Drone not found.</p>;
  }

  if (isLoading || !drone) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Fleet
        </Link>
        <h1 className="text-2xl font-semibold">{drone.name}</h1>
        <Badge variant="secondary">{drone.sizeClass}</Badge>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="photos">Photos</TabsTrigger>
          <TabsTrigger value="profiles">Profiles</TabsTrigger>
          <TabsTrigger value="flights">Flights &amp; Logs</TabsTrigger>
          <TabsTrigger value="baseline">Baseline</TabsTrigger>
          <TabsTrigger value="connect">Connect</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <BomTable droneId={droneId} components={drone.components} />
          {drone.notes && (
            <Card className="mt-4">
              <CardContent className="p-4 text-sm">{drone.notes}</CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="photos">
          <PhotoGallery droneId={droneId} photos={drone.photos} />
        </TabsContent>

        <TabsContent value="profiles">
          <ProfilesList
            profiles={drone.profiles}
            droneId={droneId}
            onDelete={(pid) => {
              void apiDelete(`/api/profiles/${pid}`).then(() => qc.invalidateQueries({ queryKey: ["drone", droneId] }));
            }}
            onDuplicate={(pid) => {
              void apiPost(`/api/profiles/${pid}/duplicate`).then(() =>
                qc.invalidateQueries({ queryKey: ["drone", droneId] }),
              );
            }}
          />
        </TabsContent>

        <TabsContent value="flights">
          <FlightsAndLogs droneId={droneId} flights={drone.flights} logs={drone.logs} />
        </TabsContent>

        <TabsContent value="baseline">
          <BaselinePanel drone={drone} />
        </TabsContent>

        <TabsContent value="connect">
          <ConnectPanel droneId={droneId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BomTable({ droneId, components }: { droneId: number; components: DroneDetail["components"] }) {
  const qc = useQueryClient();
  const { data: library } = useQuery({
    queryKey: ["components"],
    queryFn: () => apiGet<Component[]>("/api/components"),
  });
  const [category, setCategory] = useState<ComponentCategory>("frame");
  const [componentId, setComponentId] = useState<string>("");
  const [slot, setSlot] = useState("");

  const add = useMutation({
    mutationFn: () => apiPost(`/api/drones/${droneId}/components`, { componentId: Number(componentId), slot }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["drone", droneId] });
      setComponentId("");
      setSlot("");
    },
  });

  const remove = (slot: string) => {
    void apiDelete(`/api/drones/${droneId}/components/${encodeURIComponent(slot)}`).then(() =>
      qc.invalidateQueries({ queryKey: ["drone", droneId] }),
    );
  };

  const categoryItems = (library ?? []).filter((c) => c.category === category);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Build (BOM)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Slot</TableHead>
              <TableHead>Component</TableHead>
              <TableHead>Specs</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {components.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  No components yet — add from the library below.
                </TableCell>
              </TableRow>
            )}
            {components.map((c) => (
              <TableRow key={c.slot}>
                <TableCell className="capitalize">{c.slot}</TableCell>
                <TableCell>{c.component.name}</TableCell>
                <TableCell className="text-muted-foreground">{formatSpecs(c.component)}</TableCell>
                <TableCell>
                  <Button size="sm" variant="ghost" onClick={() => remove(c.slot)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label>Category</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as ComponentCategory)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPONENT_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {COMPONENT_CATEGORY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Component</Label>
            <Select value={componentId} onValueChange={setComponentId}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {categoryItems.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Slot</Label>
            <Select value={slot} onValueChange={setSlot}>
              <SelectTrigger className="w-32">
                <SelectValue placeholder="Slot…" />
              </SelectTrigger>
              <SelectContent>
                {["frame", "motors", "props", "battery", "fc_esc", "rx", "vtx", "camera"].map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" onClick={() => add.mutate()} disabled={!componentId || !slot}>
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function formatSpecs(c: Component): string {
  return Object.entries(c.specs)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}

function PhotoGallery({ droneId, photos }: { droneId: number; photos: DroneDetail["photos"] }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (files: FileList) => {
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("files", f);
      const res = await fetch(`/api/drones/${droneId}/photos`, { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        alert(body?.error ?? `Photo upload failed (${res.status})`);
        return;
      }
      void qc.invalidateQueries({ queryKey: ["drone", droneId] });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Photos</CardTitle>
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && void upload(e.target.files)}
          />
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload className="h-3.5 w-3.5" /> Upload
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {photos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No photos yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {photos.map((p) => (
              <div key={p.id} className="group relative aspect-square overflow-hidden rounded-lg border">
                <img src={photoUrl(p.path)} alt="" className="h-full w-full object-cover" />
                {p.isPrimary && (
                  <Badge variant="success" className="absolute left-1 top-1">
                    <Star className="h-3 w-3" /> Primary
                  </Badge>
                )}
                <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-black/50 p-1 opacity-0 transition-opacity group-hover:opacity-100">
                  {!p.isPrimary && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        void apiPost(`/api/photos/${p.id}/primary`).then(() =>
                          qc.invalidateQueries({ queryKey: ["drone", droneId] }),
                        )
                      }
                    >
                      <Star className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void apiDelete(`/api/photos/${p.id}`).then(() =>
                        qc.invalidateQueries({ queryKey: ["drone", droneId] }),
                      )
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FlightsAndLogs({
  droneId,
  flights,
  logs,
}: {
  droneId: number;
  flights: Flight[];
  logs: DroneDetail["logs"];
}) {
  const qc = useQueryClient();
  const { data: batteries } = useQuery({
    queryKey: ["components", "battery"],
    queryFn: () => apiGet<Component[]>("/api/components?category=battery"),
  });

  const assignBattery = (flightId: number, batteryId: string) => {
    void apiPatch(`/api/flights/${flightId}`, {
      batteryComponentId: batteryId === "none" ? null : Number(batteryId),
    }).then(() => qc.invalidateQueries({ queryKey: ["drone", droneId] }));
  };

  const analyze = (logId: number) => {
    void apiPost(`/api/logs/${logId}/analyze`).then(() =>
      qc.invalidateQueries({ queryKey: ["drone", droneId] }),
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Flights</CardTitle>
        </CardHeader>
        <CardContent>
          {flights.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No flights yet. Upload a blackbox log in the Log Lab and a flight is created automatically.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Style</TableHead>
                  <TableHead>Battery</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flights.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell>{formatDate(f.date)}</TableCell>
                    <TableCell>{formatDuration(f.durationS)}</TableCell>
                    <TableCell>
                      <Select
                        value={f.styleTag ?? "none"}
                        onValueChange={(v) =>
                          void apiPatch(`/api/flights/${f.id}`, { styleTag: v === "none" ? null : v }).then(() =>
                            qc.invalidateQueries({ queryKey: ["drone", droneId] }),
                          )
                        }
                      >
                        <SelectTrigger className="h-7 w-32 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">—</SelectItem>
                          {FLIGHT_STYLE_TAGS.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={f.batteryComponentId ? String(f.batteryComponentId) : "none"}
                        onValueChange={(v) => assignBattery(f.id, v)}
                      >
                        <SelectTrigger className="h-7 w-40 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">—</SelectItem>
                          {(batteries ?? []).map((b) => (
                            <SelectItem key={b.id} value={String(b.id)}>
                              {b.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logs</CardTitle>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No logs uploaded for this drone.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Uploaded</TableHead>
                  <TableHead>Firmware</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>{formatDate(l.uploadedAt)}</TableCell>
                    <TableCell className="text-muted-foreground">{l.headers?.["Firmware revision"] ?? "—"}</TableCell>
                    <TableCell className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => analyze(l.id)}>
                        Analyze
                      </Button>
                      <Link to={`/logs?log=${l.id}`}>
                        <Button size="sm" variant="outline">
                          Open in Log Lab
                        </Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
