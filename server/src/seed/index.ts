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

  const existingProfiles = await db.select().from(profiles).limit(1);
  if (existingProfiles.length === 0) {
    for (const t of templatesData) {
      await db
        .insert(profiles)
        .values({
          name: t.name,
          goal: t.goal,
          sizeClass: t.sizeClass ?? null,
          settingsJson: t.settings,
          source: "template",
          createdAt: Date.now(),
        });
    }
    console.log(`Seeded ${templatesData.length} profile templates`);
  } else {
    console.log("Profiles already seeded, skipping");
  }

  console.log("Seed complete");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
