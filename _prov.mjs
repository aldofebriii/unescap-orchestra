import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from 'dotenv';
config();
import { Provision } from './dist/db/entities/Provision.js';
import { Regulation } from './dist/db/entities/Regulation.js';

const ds = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [Provision, Regulation],
  synchronize: false,
});
await ds.initialize();
const c = await ds.query('select count(*)::int c from provisions');
console.log('PROVISIONS_COUNT', c[0].c);
const rows = await ds.query('select law_number, left(provision_text,70) txt, coverage_type from provisions order by created_at desc limit 5');
for (const r of rows) console.log('  -', r.law_number, '|', r.coverage_type, '|', r.txt);
await ds.destroy();
