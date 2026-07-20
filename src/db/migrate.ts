/**
 * Database sync — initializes TypeORM and synchronizes the schema.
 *
 * With synchronize: true in the DataSource, TypeORM will auto-create
 * tables and columns based on the entity definitions.
 *
 * Run: npx tsx src/db/migrate.ts
 */
import "reflect-metadata";
import { AppDataSource } from "./data-source.js";

async function sync() {
  console.log("Initializing TypeORM DataSource...");
  await AppDataSource.initialize();
  console.log("✅ Database schema synchronized.");
  await AppDataSource.destroy();
}

sync().catch((err) => {
  console.error("❌ Sync failed:", err);
  process.exit(1);
});
