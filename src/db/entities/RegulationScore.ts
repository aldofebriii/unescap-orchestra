import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { Regulation } from "./Regulation.js";

/**
 * Result of classifying + scoring a regulation against an RDTII Pillar 6/7
 * indicator.
 *
 * Produced by the `classify_and_score_regulation_tool` MCP tool (unescap
 * scoring server) and persisted here — one row per scored indicator. The tool
 * returns an `indicators[]` array; each entry becomes a row linked back to the
 * {@link Regulation} the auto-extract flow recorded.
 *
 * Every row also captures the rule-based validation the scoring server runs
 * (is_valid / issues / reference match), so a human reviewer can see which
 * scores are trustworthy without re-running the pipeline.
 */
@Entity("regulation_scores")
@Index(["regulationId"])
@Index(["docId"])
export class RegulationScore {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Regulation this score belongs to (registry row from recordRegulation). */
  @Column({ name: "regulation_id", type: "uuid", nullable: true })
  regulationId!: string | null;

  /** ChromaDB doc_id the scoring server used as input. */
  @Column({ name: "doc_id", type: "varchar", nullable: true })
  docId!: string | null;

  /** Conversation / session that produced this score (traceability). */
  @Column({ name: "conversation_id", type: "uuid", nullable: true })
  conversationId!: string | null;

  /** RDTII indicator ID, e.g. "6.1" / "7.4". */
  @Column({ name: "indicator_id", type: "varchar" })
  indicatorId!: string;

  /** Human-readable indicator name. */
  @Column({ name: "indicator_name", type: "varchar", nullable: true })
  indicatorName!: string | null;

  /** RDTII pillar the indicator belongs to (derived from the indicator ID). */
  @Column({ type: "varchar", nullable: true })
  pillar!: string | null;

  /** Assigned score (snapped to the indicator's valid set by the server). */
  @Column({ type: "float", nullable: true })
  score!: number | null;

  /** Model confidence, 0.0–1.0. */
  @Column({ type: "float", nullable: true })
  confidence!: number | null;

  /** Justification for the assigned score. */
  @Column({ type: "text", nullable: true })
  justification!: string | null;

  /** Key evidence excerpts supporting the score. */
  @Column({ name: "key_evidence", type: "jsonb", default: () => "'[]'" })
  keyEvidence!: string[];

  /** Whether the score passed rule-based validation. */
  @Column({ name: "is_valid", type: "boolean", default: true })
  isValid!: boolean;

  /** Validation issues raised (empty when valid). */
  @Column({ name: "validation_issues", type: "jsonb", default: () => "'[]'" })
  validationIssues!: string[];

  /** Reference score for the economy, when a known RDTII economy was passed. */
  @Column({ name: "reference_score", type: "float", nullable: true })
  referenceScore!: number | null;

  /** Whether the score matched the reference (null when no reference). */
  @Column({ name: "reference_match", type: "boolean", nullable: true })
  referenceMatch!: boolean | null;

  /** RDTII-focused summary of the regulation the score was derived from. */
  @Column({ type: "text", nullable: true })
  summary!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @ManyToOne(() => Regulation)
  @JoinColumn({ name: "regulation_id" })
  regulation!: Regulation;
}
