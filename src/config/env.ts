import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

/**
 * Schema for a single MCP server entry.
 * Configured in config.json under the "mcpServers" key.
 */
const mcpServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
});

export type McpServerConfig = z.infer<typeof mcpServerSchema>;

/**
 * Schema for config.json
 */
const configJsonSchema = z.object({
  mcpServers: z.array(mcpServerSchema).min(1, "At least one MCP server is required"),
});

const envSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z
    .string()
    .url("OPENAI_BASE_URL must be a valid URL")
    .default("https://api.openai.com/v1"),
  OPENAI_MODEL: z.string().default("gpt-4o"),
  MAX_ITERATIONS: z.coerce.number().int().positive().default(15),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .startsWith("postgresql://"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_USENRAME: z.string().default("postgres"),
  DATABASE_PASSWORD: z.string().default("1235678")
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`\n❌ Environment validation failed:\n${formatted}\n`);
    console.error("Copy .env.example → .env and fill in the values.\n");
    process.exit(1);
  }

  return result.data;
}

/**
 * Load MCP server config from config.json → mcpServers.
 */
function loadMcpServers(): McpServerConfig[] {
  const configPath = path.resolve("config.json");

  if (!fs.existsSync(configPath)) {
    console.error(
      `\n❌ Config file not found: ${configPath}\n` +
      "Create config.json with a \"mcpServers\" array of { name, url } entries.\n"
    );
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const config = configJsonSchema.parse(parsed);
    return config.mcpServers;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Failed to load config.json: ${msg}\n`);
    process.exit(1);
  }
}

export const env = loadEnv();
export const mcpServers = loadMcpServers();
