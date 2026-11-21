import { workerData } from 'node:worker_threads';
import { openDatabase } from './database.mjs';
import { runQueuedJob } from './service.mjs';

const db = openDatabase(workerData.filename);
try {
  await runQueuedJob(db, workerData.job);
} finally {
  db.close();
}
