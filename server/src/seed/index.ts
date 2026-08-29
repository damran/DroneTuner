import { and, eq, isNull } from "drizzle-orm";
import { loadConfig } from "../config";
import { createDb } from "../db";
import { components, profiles } from "../db/schema";
import componentsData from "./components.json";
import templatesData from "./templates.json";

async function seed(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config);

  const existingComponents = await db.select().from(components).limit(1);
  if (existingComponents.length === 0) {
    for (const c of componentsData) {
      await db
        .insert(components)
        .values({
          category: c.category,
          name: c.name,
          specsJson: c.specs,
          notes: c.notes ?? null,
        });
    }
    console.log(`Seeded ${componentsData.length} components`);
  } else {
    console.log("Components already seeded, skipping");
  }

  // Templates are managed content: refresh them in place (matched by name)
  // so seed updates reach existing installs, without ever touching
  // user-created or drone-assigned profiles.
  let inserted = 0;
  let updated = 0;
  for (const t of templatesData) {
    const existing = await db
      .select()
      .from(profiles)
      .where(and(eq(profiles.name, t.name), eq(profiles.source, "template"), isNull(profiles.droneId)))
      .get();
    if (existing) {
      await db
        .update(profiles)
        .set({ goal: t.goal, sizeClass: t.sizeClass ?? null, settingsJson: t.settings })
        .where(eq(profiles.id, existing.id));
      updated++;
    } else {
      await db.insert(profiles).values({
        name: t.name,
        goal: t.goal,
        sizeClass: t.sizeClass ?? null,
        settingsJson: t.settings,
        source: "template",
        createdAt: Date.now(),
      });
      inserted++;
    }
  }
  console.log(`Profile templates: ${inserted} inserted, ${updated} updated`);

  console.log("Seed complete");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
