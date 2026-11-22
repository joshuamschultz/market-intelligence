import { verifyOracleWorkerTask } from './verify-existing-pipeline.mjs';

if (!process.connected || typeof process.send !== 'function') {
  console.error('Boundary oracle worker requires an IPC parent');
  process.exitCode = 1;
} else {
  process.once('message', (task) => {
    let reply;
    try {
      reply = verifyOracleWorkerTask(task);
    } catch (error) {
      const { format, taskId, phase, dates } = task ?? {};
      reply = { format, taskId, phase, dates, error: error.message };
      process.exitCode = 1;
    }
    if (process.connected) process.send(reply, (error) => {
      if (error) process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
  });
}
