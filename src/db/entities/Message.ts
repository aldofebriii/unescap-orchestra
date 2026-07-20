import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Conversation } from "./Conversation.js";

@Entity("messages")
export class Message {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: "conversation_id", type: "uuid" })
  conversationId!: string;

  @Column({ type: "varchar", length: 20 })
  role!: string;

  @Column({ type: "text", nullable: true })
  content!: string | null;

  @Column({ name: "tool_calls", type: "jsonb", nullable: true })
  toolCalls!: unknown | null;

  @Column({ name: "tool_call_id", type: "varchar", nullable: true })
  toolCallId!: string | null;

  @Column({ type: "varchar", nullable: true })
  name!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @ManyToOne(() => Conversation, (c) => c.messages)
  @JoinColumn({ name: "conversation_id" })
  conversation!: Conversation;
}
