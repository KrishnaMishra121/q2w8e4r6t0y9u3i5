'use strict';
const { createContext, createApp, startBroadcasting } = require('./src/app');
const { HOST, PORT } = require('./src/config');

(async () => {
  const ctx = await createContext();
  await ctx.engine.cleanupOrphans();
  const app = createApp(ctx);
  const stopBroadcast = startBroadcasting(ctx);
  const server = app.listen(PORT, HOST, () => {
    const lines = [
      '', '  Playout server is running', `  Local URL : http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
      `  Login     : read first-run credentials from ${ctx.credentials.source}`,
      HOST !== '127.0.0.1' && HOST !== 'localhost' ? '  WARNING: listening on a non-loopback address. Keep the port private and protected.' : '',
      !ctx.binaries.ffmpeg.ok ? '  WARNING: FFmpeg was not found. Install it or set FFMPEG_PATH.' : '', '',
    ];
    console.log(lines.join('\n'));
  });

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return; closing = true;
    ctx.log.info('system', `${sig} received, shutting down`);
    stopBroadcast();
    server.close();
    try { await Promise.race([ctx.engine.stop('Server shutting down'), new Promise((r) => setTimeout(r, 12000))]); } catch {}
    ctx.engine.killAllNow();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => ctx.engine.killAllNow());
  process.on('uncaughtException', (e) => { ctx.log.error('system', 'Uncaught exception: ' + (e.stack || e.message)); });
  process.on('unhandledRejection', (e) => { ctx.log.error('system', 'Unhandled rejection: ' + (e && e.stack || e)); });
})().catch((e) => { console.error('Fatal startup error:', e); process.exit(1); });
