import { createApp } from './app.js';
import { getEnvConfig } from './config/env.js';
import { recoverInterruptedJobs } from './services/aiJobRepository.js';

const config = getEnvConfig();
const app = createApp();

async function startServer() {
  if (config.databaseUrlConfigured) {
    try {
      const recovered = await recoverInterruptedJobs();
      if (recovered > 0) {
        console.log(`[ut-learning] Marked ${recovered} unfinished AI job(s) as interrupted.`);
      }
    } catch (err) {
      console.warn('[ut-learning] Could not run startup job recovery:', err.message);
    }
  }

  app.listen(config.port, config.host, () => {
    console.log(
      `[ut-learning] Server running on http://${config.host}:${config.port} (Milestone 1 & 1A)`
    );
  });
}

startServer();
