import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Conversation } from "./Conversation.js";

@Entity("tool_executions")
export class ToolExecution {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: "conversation_id", type: "uuid" })
  conversationId!: string;

  @Column({ name: "tool_name", type: "varchar" })
  toolName!: string;

  @Column({ type: "jsonb", nullable: true })
  arguments!: Record<string, unknown> | null;

  @Column({ type: "jsonb", nullable: true })
  result!: unknown | null;

  @Column({ name: "duration_ms", type: "int", nullable: true })
  durationMs!: number | null;

  @Column({ type: "varchar", length: 20 })
  status!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @ManyToOne(() => Conversation, (c) => c.toolExecutions)
  @JoinColumn({ name: "conversation_id" })
  conversation!: Conversation;
}
