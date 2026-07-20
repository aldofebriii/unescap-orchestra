import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("jobs")
export class Job {
  @PrimaryColumn({ type: "varchar", length: 255 })
  jobId!: string;

  @Column({ name: "session_id", type: "varchar", length: 255, nullable: true })
  sessionId!: string | null;

  @Column({ type: "varchar", length: 50 })
  status!: "pending" | "processing" | "done" | "partial" | "failed";

  @Column({ type: "varchar", length: 255 })
  source!: string;

  @Column({ type: "int", default: 1 })
  version!: number;

  @Column({ name: "doc_id", type: "varchar", length: 255, nullable: true })
  docId!: string | null;

  @Column({ type: "varchar", length: 100, nullable: true })
  collection!: string | null;

  @Column({ name: "pages_total", type: "int", nullable: true })
  pagesTotal!: number | null;

  @Column({ name: "pages_done", type: "int", default: 0 })
  pagesDone!: number;

  @Column({ name: "pages_via_vlm", type: "int", default: 0 })
  pagesViaVlm!: number;

  @Column({ name: "pages_via_pdfplumber", type: "int", default: 0 })
  pagesViaPdfplumber!: number;

  @Column({ name: "pages_failed", type: "int", default: 0 })
  pagesFailed!: number;

  @Column({ name: "duration_sec", type: "float", nullable: true })
  durationSec!: number | null;

  @Column({ name: "markdown_path", type: "text", nullable: true })
  markdownPath!: string | null;

  @Column({ type: "text", nullable: true })
  error!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
