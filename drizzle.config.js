import dotenv from 'dotenv';
import { defineConfig } from 'drizzle-kit';

dotenv.config();

const connectionString =
  (process.env.DIRECT_URL || '').trim() || (process.env.DATABASE_URL || '').trim();

export default defineConfig({
  schema: './src/db/schema.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: connectionString,
  },
});
