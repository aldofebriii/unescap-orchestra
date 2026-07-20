import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * A document retrieved during a Zone-1 run, persisted so a session can be
 * reloaded later with its full document list and ingest state.
 *
 * Mirrors the in-memory RetrievedDocument shape (see src/pipeline/zone1.ts).
 * When the user ingests a document, `ingestJobId` links it to the {@link Job}
 * row whose status the UI polls — so a reloaded session shows live ingest
 * progress without re-running anything.
 */
@Entity("session_documents")
@Index(["sessionId"])
export class SessionDocument {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Session this document belongs to. */
  @Column({ name: "session_id", type: "uuid" })
  sessionId!: string;

  /** Stable per-run doc id (e.g. "doc-0") — used by the frontend for keys. */
  @Column({ name: "doc_key", type: "varchar", length: 100 })
  docKey!: string;

  @Column({ type: "text" })
  title!: string;

  @Column({ type: "text", default: "" })
  url!: string;

  @Column({ type: "varchar", nullable: true })
  domain!: string | null;

  @Column({ type: "text", nullable: true })
  description!: string | null;

  @Column({ name: "relevance_score", type: "float", nullable: true })
  relevanceScore!: number | null;

  /** "downloaded" — file saved locally; "failed" — could not retrieve. */
  @Column({ type: "varchar", length: 20 })
  status!: "downloaded" | "failed";

  @Column({ name: "file_path", type: "text", nullable: true })
  filePath!: string | null;

  @Column({ name: "mime_type", type: "varchar", nullable: true })
  mimeType!: string | null;

  @Column({ name: "size_bytes", type: "int", nullable: true })
  sizeBytes!: number | null;

  /** Best-guess ingest input_type for server-2 ("pdf_file" | "html_file"). */
  @Column({ name: "input_type", type: "varchar", length: 20, nullable: true })
  inputType!: "pdf_file" | "html_file" | null;

  @Column({ type: "text", nullable: true })
  error!: string | null;

  /** Ingest job id once the user ingests this document (links to Job). */
  @Column({ name: "ingest_job_id", type: "varchar", length: 255, nullable: true })
  ingestJobId!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
