import path from 'path';
import fs from 'fs';
import http from 'http';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { WebSocketServer } from 'ws';
import { config } from './config';
import { registerRoutes } from './routes';
import { setupWebSocketServer, startTickLoop, stopTickLoop } from './roomManager';
import { getDb } from './db';
import { generateHLSAsync, hasHLS } from './ffmpeg';

async function main() {
  // Ensure data directories exist
  fs.mkdirSync(path.join(config.mediaDir, 'rooms'), { recursive: true });
  fs.mkdirSync(path.join(config.mediaDir, 'library'), { recursive: true });
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

  // Initialize DB
  getDb();

  if (config.passwordHash && !config.sessionSecret) {
    console.error('[auth] PASSWORD_HASH is set but SESSION_SECRET is missing. Set SESSION_SECRET in config.json or as an env var, then restart.');
    process.exit(1);
  }

  const app = Fastify({
    logger: config.isDev ? { level: 'info' } : { level: 'warn' },
    trustProxy: true,
  });

  // Rate limiting
  await app.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: '1m',
    keyGenerator: (req) => {
      return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip;
    },
  });

  // Multipart for file uploads
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
    },
  });

  // API routes
  await registerRoutes(app);

  // Serve frontend static files in production
  const clientDistDir = path.resolve(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDistDir)) {
    await app.register(staticFiles, {
      root: clientDistDir,
      prefix: '/',
    });

    // SPA fallback: serve index.html for all non-API routes
    app.setNotFoundHandler(async (req, reply) => {
      if (!req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
        reply.header('Content-Type', 'text/html; charset=utf-8');
        return reply.send(fs.createReadStream(path.join(clientDistDir, 'index.html')));
      }
      return reply.status(404).send({ error: 'Not found' });
    });
  } else if (config.isDev) {
    app.setNotFoundHandler(async (req, reply) => {
      if (!req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
        return reply.status(200).send('Dev mode: run `npm run dev` in the client directory');
      }
      return reply.status(404).send({ error: 'Not found' });
    });
  }

  // Build HTTP server and attach WebSocket server
  const server = app.server as http.Server;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    if (url.pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  setupWebSocketServer(wss);
  startTickLoop();

  // Kick off HLS generation for any existing library files that don't have it yet
  const libraryDir = path.join(config.mediaDir, 'library');
  for (const f of fs.readdirSync(libraryDir)) {
    if (!f.endsWith('.mp4')) continue;
    const fp = path.join(libraryDir, f);
    if (!hasHLS(fp)) generateHLSAsync(fp);
  }

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    stopTickLoop();
    await app.close();
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    stopTickLoop();
    await app.close();
    process.exit(0);
  });

  await app.listen({ port: config.port, host: config.host });
  console.log(`PookieFlix running at http://${config.host}:${config.port}`);
  console.log(`Media directory: ${config.mediaDir}`);
  console.log(`Database: ${config.dbPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
