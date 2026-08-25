import type { DiffEntry } from "@dronetuner/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function DiffView({ diff }: { diff: DiffEntry[] }) {
  if (diff.length === 0) {
    return <p className="text-sm text-muted-foreground">No changes — the FC is already up to date.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Setting</TableHead>
          <TableHead>Current</TableHead>
          <TableHead>New</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {diff.map((d) => (
          <TableRow key={d.path}>
            <TableCell>{d.label}</TableCell>
            <TableCell className="text-muted-foreground">{d.fromDisplay}</TableCell>
            <TableCell className="font-medium text-primary">{d.toDisplay}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
