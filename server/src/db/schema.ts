import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const components = sqliteTable("components", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category").notNull(),
  name: text("name").notNull(),
  specsJson: text("specs_json", { mode: "json" }).notNull().default("{}"),
  notes: text("notes"),
});

export const drones = sqliteTable("drones", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  sizeClass: text("size_class").notNull().default(""),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  // FC identity learned on connect, used for auto-detect.
  fcTarget: text("fc_target"),
  fcBoard: text("fc_board"),
  fcCraftName: text("fc_craft_name"),
  fcUid: text("fc_uid"),
});

export const droneComponents = sqliteTable(
  "drone_components",
  {
    droneId: integer("drone_id")
      .notNull()
      .references(() => drones.id, { onDelete: "cascade" }),
    componentId: integer("component_id")
      .notNull()
      .references(() => components.id, { onDelete: "cascade" }),
    slot: text("slot").notNull(),
  },
  (t) => [primaryKey({ columns: [t.droneId, t.slot] })],
);

export const dronePhotos = sqliteTable("drone_photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  droneId: integer("drone_id")
    .notNull()
    .references(() => drones.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
});

export const logs = sqliteTable("logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  droneId: integer("drone_id")
    .notNull()
    .references(() => drones.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  headersJson: text("headers_json", { mode: "json" }),
  uploadedAt: integer("uploaded_at").notNull(),
});

export const flights = sqliteTable("flights", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  droneId: integer("drone_id")
    .notNull()
    .references(() => drones.id, { onDelete: "cascade" }),
  batteryComponentId: integer("battery_component_id").references(() => components.id, {
    onDelete: "set null",
  }),
  logId: integer("log_id").references(() => logs.id, { onDelete: "set null" }),
  date: integer("date").notNull(),
  durationS: integer("duration_s"),
  styleTag: text("style_tag"),
});

export const analyses = sqliteTable("analyses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  logId: integer("log_id")
    .notNull()
    .references(() => logs.id, { onDelete: "cascade" }),
  metricsJson: text("metrics_json", { mode: "json" }).notNull(),
  findingsJson: text("findings_json", { mode: "json" }).notNull(),
  createdAt: integer("created_at").notNull(),
});

export const profiles = sqliteTable("profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  droneId: integer("drone_id").references(() => drones.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  goal: text("goal").notNull(),
  sizeClass: text("size_class"),
  settingsJson: text("settings_json", { mode: "json" }).notNull().default("{}"),
  source: text("source").notNull().default("template"),
  createdAt: integer("created_at").notNull(),
});

export const fcSnapshots = sqliteTable("fc_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  droneId: integer("drone_id")
    .notNull()
    .references(() => drones.id, { onDelete: "cascade" }),
  dumpJson: text("dump_json", { mode: "json" }).notNull(),
  takenAt: integer("taken_at").notNull(),
  reason: text("reason"),
});

export const vendorPresets = sqliteTable("vendor_presets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  source: text("source").notNull().default("manual"),
  boardTarget: text("board_target"),
  componentId: integer("component_id").references(() => components.id, { onDelete: "set null" }),
  droneModel: text("drone_model"),
  settingsJson: text("settings_json", { mode: "json" }).notNull().default("{}"),
  cliDump: text("cli_dump"),
  sourceUrl: text("source_url"),
  createdAt: integer("created_at").notNull(),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  droneId: integer("drone_id").references(() => drones.id, { onDelete: "set null" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  toolCallsJson: text("tool_calls_json", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
});
