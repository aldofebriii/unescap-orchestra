import 'reflect-metadata';
import { config } from 'dotenv';
config();
import { autoExtractProvisions } from './src/pipeline/auto-extract.ts';
import { AppDataSource } from './src/db/data-source.ts';

await AppDataSource.initialize();
const r = await autoExtractProvisions({
  markdownPath: 'C:/Users/aldo/Documents/GitHub/extraction_html_pdf_tool/markdown_exports/https___www_pdp_gov_my_ppdpv1_wp-content_uploads_2024_07_Peraturan-peraturan-Per_doc_9b3c48.md',
  country: 'Malaysia',
  source: 'https://www.pdp.gov.my/ppdpv1/wp-content/uploads/2024/07/Peraturan-peraturan-Perlindungan-Data-Peribadi.pdf',
  url: 'https://www.pdp.gov.my/ppdpv1/wp-content/uploads/2024/07/Peraturan-peraturan-Perlindungan-Data-Peribadi.pdf',
  conversationId: '09af5b23-3d8b-4536-b447-5c4a764c4d6b',
});
console.log('RESULT', JSON.stringify(r));
await AppDataSource.destroy();
