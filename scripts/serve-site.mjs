import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const host = process.env.HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '4173', 10);
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.webm', 'video/webm'],
]);

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}

export function createStaticServer({ rootDirectory = root, hostname = host, listenPort = port } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url || '/', `http://${hostname}:${listenPort}`).pathname);
      const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      let filePath = path.resolve(rootDirectory, relativePath);
      if (filePath !== rootDirectory && !filePath.startsWith(`${rootDirectory}${path.sep}`)) {
        send(response, 403, 'Forbidden');
        return;
      }

      let metadata = await stat(filePath);
      if (metadata.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        metadata = await stat(filePath);
      }
      if (!metadata.isFile()) {
        send(response, 404, 'Not found');
        return;
      }

      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Connection': 'close',
        'Content-Length': metadata.size,
        'Content-Type': mimeTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
      });
      createReadStream(filePath).pipe(response);
    } catch (error) {
      send(response, error?.code === 'ENOENT' ? 404 : 500, error?.code === 'ENOENT' ? 'Not found' : 'Server error');
    }
  });
  server.keepAliveTimeout = 1;
  return server;
}

export function startStaticServer(options = {}) {
  const hostname = options.hostname || host;
  const listenPort = options.listenPort || port;
  const server = createStaticServer({ ...options, hostname, listenPort });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, hostname, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  await startStaticServer();
  console.log(`InstaFrame development server: http://${host}:${port}`);
}
