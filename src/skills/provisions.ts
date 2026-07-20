/**
 * Provision emission — the structured output of the extraction workflow.
 *
 * The LLM emits provisions by calling the local `emit_provisions` tool.
 * Unlike MCP tools, this executor runs in-process: it validates the LLM's
 * output against a Zod schema (guaranteeing the shape) and stores the
 * accepted provisions for the downstream classification agent.
 *
 * `pillar` and `indicator` are intentionally left null at this stage — they
 * are filled in later by the classification agent.
 */
import { z } from "zod";
import type { Provision, ToolDefinition } from "../agent/types.js";

export const EMIT_PROVISIONS_TOOL = "emit_provisions";

// ── Zod validation schema (mirrors the Provision type) ──

const coverageSchema = z
  .object({
    type: z.enum(["horizontal", "sectoral"]),
    sector: z.string().nullable().optional(),
  })
  .refine((c) => c.type !== "sectoral" || (c.sector?.trim().length ?? 0) > 0, {
    message: 'coverage.sector is required when coverage.type is "sectoral"',
  });

const provisionSchema = z.object({
  provision_text: z.string().min(1),
  law_number: z.string().min(1),
  // Left null at extraction — populated later by the classification agent.
  pillar: z.string().nullable().default(null),
  indicator: z.string().nullable().default(null),
  rationale: z.string().min(1, "rationale is required — explain why the provision is relevant"),
  coverage: coverageSchema,
  timeframe_last_amendment: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)")
    .nullable(),
  address: z.string().min(1),
  urls: z.array(z.string().url()).min(1),
  confidence: z.number().min(0).max(1),
  flag_for_review: z.boolean(),
  summary: z.string().min(1),
});

const emitProvisionsSchema = z.object({
  country: z.string().min(1),
  regulation_name: z.string().min(1),
  provisions: z.array(provisionSchema).min(1),
});

export interface EmitProvisionsPayload {
  country: string;
  regulation_name: string;
  provisions: Provision[];
}

// ── Per-conversation provision store ──

const store = new Map<string, Provision[]>();

/** Append emitted provisions for a conversation. */
export function saveProvisions(conversationId: string, provisions: Provision[]): void {
  const existing = store.get(conversationId) ?? [];
  store.set(conversationId, [...existing, ...provisions]);
}

/** Get all provisions emitted so far for a conversation. */
export function getProvisions(conversationId: string): Provision[] {
  return store.get(conversationId) ?? [];
}

/** Clear stored provisions for a conversation. */
export function clearProvisions(conversationId: string): void {
  store.delete(conversationId);
}

/**
 * Validate raw tool args against the provision schema.
 * Throws (with a readable message) if validation fails — the agent loop
 * surfaces the error back to the LLM so it can correct and retry.
 */
export function parseEmitProvisions(args: unknown): EmitProvisionsPayload {
  const result = emitProvisionsSchema.safeParse(args);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid provisions: ${issues}`);
  }
  return {
    country: result.data.country,
    regulation_name: result.data.regulation_name,
    provisions: result.data.provisions as Provision[],
  };
}

// ── Tool definition exposed to the LLM ──

export const emitProvisionsTool: ToolDefinition = {
  type: "function",
  function: {
    name: EMIT_PROVISIONS_TOOL,
    description:
      "Emit the structured regulatory provisions you extracted from a document. " +
      "Call this once you have identified the relevant provisions. Leave `pillar` " +
      "and `indicator` as null — they are assigned later by the classification agent.",
    parameters: {
      type: "object",
      properties: {
        country: {
          type: "string",
          description: "Country the regulation belongs to (e.g. \"Indonesia\").",
        },
        regulation_name: {
          type: "string",
          description:
            "Name/title of the regulation or act these provisions come from " +
            "(e.g. \"Personal Data Protection Law\").",
        },
        provisions: {
          type: "array",
          description: "The list of extracted provisions.",
          items: {
            type: "object",
            properties: {
              provision_text: {
                type: "string",
                description:
                  "VERBATIM text of the specific article/clause (quote the actual " +
                  "legal wording — not a paraphrase and not the whole document).",
              },
              law_number: {
                type: "string",
                description:
                  "Act / regulation number exactly as cited, e.g. \"UU No. 27/2022\" " +
                  "or \"PP No. 71/2019\". Required — never leave vague.",
              },
              pillar: {
                type: ["string", "null"],
                description: "Leave null — assigned by the classification agent.",
              },
              indicator: {
                type: ["string", "null"],
                description: "Leave null — assigned by the classification agent.",
              },
              rationale: {
                type: ["string", "null"],
                description:
                  "WHY this provision is relevant: what it regulates and why it " +
                  "matters for the RDTII assessment. A real explanation, not a " +
                  "restatement of the provision text.",
              },
              coverage: {
                type: "object",
                description:
                  "Scope of the provision — decide from its actual reach, not a guess.",
                properties: {
                  type: {
                    type: "string",
                    enum: ["horizontal", "sectoral"],
                    description:
                      "\"horizontal\" (applies across all sectors) or \"sectoral\" " +
                      "(limited to a specific sector).",
                  },
                  sector: {
                    type: "string",
                    description:
                      "Sector name (e.g. \"banking\", \"health\", " +
                      "\"telecommunications\") — required when type is \"sectoral\".",
                  },
                },
                required: ["type"],
              },
              timeframe_last_amendment: {
                type: ["string", "null"],
                description: "Date of last amendment as an ISO date string (YYYY-MM-DD), or null.",
              },
              address: {
                type: "string",
                description: "Location within the document, e.g. \"article 26 (1)\".",
              },
              urls: {
                type: "array",
                description: "One or more source URLs for the provision.",
                items: { type: "string" },
              },
              confidence: {
                type: "number",
                description: "Extraction confidence from 0.0 to 1.0.",
              },
              flag_for_review: {
                type: "boolean",
                description: "True if a human should review this provision.",
              },
              summary: {
                type: "string",
                description: "Short summary of the regulation this provision belongs to.",
              },
            },
            required: [
              "provision_text",
              "law_number",
              "rationale",
              "coverage",
              "timeframe_last_amendment",
              "address",
              "urls",
              "confidence",
              "flag_for_review",
              "summary",
            ],
          },
        },
      },
      required: ["country", "regulation_name", "provisions"],
    },
  },
};
