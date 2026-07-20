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
 * A single extracted regulatory provision, persisted for the downstream
 * classification agent and for review.
 *
 * Provisions belong to a {@link Regulation} (de-duplicated by name within a
 * country). The rich per-provision fields — verbatim text, law number,
 * rationale, and coverage (horizontal vs. sectoral) — are what make a stored
 * regulation actually useful; previously they lived only in memory and were
 * discarded once the request finished.
 *
 * `pillar` and `indicator` are left null at extraction time and filled in
 * later by the classification agent.
 */
@Entity("provisions")
@Index(["regulationId"])
export class Provision {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Regulation this provision belongs to. */
  @Column({ name: "regulation_id", type: "uuid" })
  regulationId!: string;

  /** Conversation that produced this provision (for traceability). */
  @Column({ name: "conversation_id", type: "uuid", nullable: true })
  conversationId!: string | null;

  /** Verbatim text of the provision. */
  @Column({ name: "provision_text", type: "text" })
  provisionText!: string;

  /** Act / practice / regulation law number, e.g. "UU No. 27/2022". */
  @Column({ name: "law_number", type: "varchar" })
  lawNumber!: string;

  /** Rationale explaining relevance / classification. */
  @Column({ type: "text", nullable: true })
  rationale!: string | null;

  /** Coverage type — "horizontal" (all sectors) or "sectoral". */
  @Column({ name: "coverage_type", type: "varchar", length: 20 })
  coverageType!: string;

  /** Sector name — set when coverage_type is "sectoral". */
  @Column({ name: "coverage_sector", type: "varchar", nullable: true })
  coverageSector!: string | null;

  /** Location within the document, e.g. "article 26 (1)". */
  @Column({ type: "varchar", nullable: true })
  address!: string | null;

  /** Date of last amendment as an ISO date string (YYYY-MM-DD), or null. */
  @Column({ name: "timeframe_last_amendment", type: "varchar", nullable: true })
  timeframeLastAmendment!: string | null;

  /** Source URLs for this provision. */
  @Column({ type: "jsonb", default: () => "'[]'" })
  urls!: string[];

  /** Extraction confidence, 0.0–1.0. */
  @Column({ type: "float", nullable: true })
  confidence!: number | null;

  /** Whether a human should review this provision. */
  @Column({ name: "flag_for_review", type: "boolean", default: false })
  flagForReview!: boolean;

  /** RDTII pillar — null until set by the classification agent. */
  @Column({ type: "varchar", nullable: true })
  pillar!: string | null;

  /** RDTII indicator — null until set by the classification agent. */
  @Column({ type: "varchar", nullable: true })
  indicator!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @ManyToOne(() => Regulation)
  @JoinColumn({ name: "regulation_id" })
  regulation!: Regulation;
}
