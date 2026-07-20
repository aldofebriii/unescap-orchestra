import { DataSource } from "typeorm";
import { env } from "../config/env.js";
import { Conversation } from "./entities/Conversation.js";
import { Message } from "./entities/Message.js";
import { ToolExecution } from "./entities/ToolExecution.js";
import { Regulation } from "./entities/Regulation.js";
import { Provision } from "./entities/Provision.js";
import { RegulationScore } from "./entities/RegulationScore.js";
import { Job } from "./entities/Job.js";
import { Session } from "./entities/Session.js";
import { SessionDocument } from "./entities/SessionDocument.js";

export const AppDataSource = new DataSource({
  type: "postgres",
  url: env.DATABASE_URL,
  entities: [Conversation, Message, ToolExecution, Regulation, Provision, RegulationScore, Job, Session, SessionDocument],
  synchronize: true, // auto-create/update tables in dev
  logging: false,
});
