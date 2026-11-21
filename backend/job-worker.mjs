import { workerData } from 'node:worker_threads';
import { openDatabase, updateJob } from './database.mjs';
import { performJob } from './service.mjs';

const db = openDatabase(workerData.filename);
const { job } = workerData;
try {
  updateJob(db, job.id, 'running', 1);
  const progress = (step) => updateJob(db, job.id, 'running', Math.max(1, Math.min(99, Math.round(step * 99))));
  const result = await performJob(db, job.type, job.payload, { progress });
  updateJob(db, job.id, 'complete', 100, result);
} catch (error) {
  updateJob(db, job.id, 'failed', 0, null, error.message);
} finally {
  db.close();
}
