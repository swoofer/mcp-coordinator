// Stays alive until killed. Writes its PID then waits.
process.stdout.write(String(process.pid) + '\n');
setInterval(() => {}, 1000000);
