import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Job } from "./Job.js";

/**
 * Registry of regulations we have successfully processed.
 *
 * De-duplication is scoped by country: a regulation is considered "already
 * known" when its normalized name is similar enough to an existing row for
 * the same country. On a repeat hit we only merge in any new source URLs.
 */
@Entity("regulations")
@Index(["country", "normalizedName"])
export class Regulation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Country the regulation belongs to (used to scope de-dup). */
  @Column({ type: "varchar" })
  country!: string;

  /** Original regulation / act name as reported by the agent. */
  @Column({ name: "regulation_name", type: "varchar" })
  regulationName!: string;

  /** English translation of the name (used for cross-language matching). */
  @Column({ name: "english_name", type: "varchar" })
  englishName!: string;

  /** Normalized English name used for similarity matching. */
  @Column({ name: "normalized_name", type: "varchar" })
  normalizedName!: string;

  /** Act / practice / regulation law number, if known. */
  @Column({ name: "law_number", type: "varchar", nullable: true })
  lawNumber!: string | null;

  /** All known source URLs for this regulation (de-duplicated). */
  @Column({ type: "jsonb", default: () => "'[]'" })
  urls!: string[];

  /** Optional summary text (from agent or auto-generated). */
  @Column({ type: "text", nullable: true })
  summary!: string | null;

  /** How many times we have processed / re-encountered this regulation. */
  @Column({ name: "hit_count", type: "int", default: 1 })
  hitCount!: number;

  /** Path to the full markdown file (if available). */
  @Column({ name: "md_path", type: "varchar", nullable: true })
  mdPath!: string | null;

  /** Link to the originating ingest job. */
  @ManyToOne(() => Job, { nullable: true })
  @JoinColumn({ name: "job_id" })
  job!: Job | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
