import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * A pipeline session — one Zone-1 retrieval run and everything that hangs off
 * it: the documents it retrieved ({@link SessionDocument}), the ingest jobs
 * those documents produced ({@link Job}, linked by `sessionId`), and a chat
 * scoped to the session.
 *
 * The session `id` is reused as:
 *   - the `conversation_id` of the session's chat (see agent loop / Conversation)
 *   - the `session_id` stamped on ingest jobs (see Job.sessionId)
 * so a single id ties the run, its jobs, and its chat together.
 */
@Entity("sessions")
export class Session {
  /** Session id — also used as chat conversation_id and job session_id. */
  @PrimaryColumn("uuid")
  id!: string;

  /** Human-friendly title (derived from the query + country). */
  @Column({ type: "varchar", length: 255 })
  title!: string;

  /** The raw user query that kicked off the run. */
  @Column({ type: "text" })
  query!: string;

  /** Country the run targeted. */
  @Column({ type: "varchar", length: 100 })
  country!: string;

  /** Lifecycle: `running` while Zone-1 executes, then `completed`/`failed`. */
  @Column({ type: "varchar", length: 20, default: "running" })
  status!: "running" | "completed" | "failed";

  /** Number of search results seen across the run. */
  @Column({ name: "search_count", type: "int", default: 0 })
  searchCount!: number;

  /** Planning/search iterations the run performed. */
  @Column({ type: "int", default: 0 })
  iterations!: number;

  /** Documents the run attempted to download. */
  @Column({ type: "int", default: 0 })
  attempted!: number;

  /** Error message if the run failed. */
  @Column({ type: "text", nullable: true })
  error!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
