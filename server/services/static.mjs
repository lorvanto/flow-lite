import fs from 'node:fs';
import path from 'node:path';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

// Register only files present in the frontend build. Requests never become disk paths.
export function registerFrontend(app, root) {
  function visit(directory, segments = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const parts = [...segments, entry.name];
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filename, parts);
        continue;
      }
      if (!entry.isFile() || parts[0] === 'api') continue;
      const route = '/' + parts.map(encodeURIComponent).join('/');
      const send = (request, reply) =>
        reply
          .type(mime[path.extname(filename)] || 'application/octet-stream')
          .header(
            'Cache-Control',
            path.extname(filename) === '.html' ? 'no-store' : 'public, max-age=3600',
          )
          .send(fs.createReadStream(filename));
      app.get(route, send);
      if (parts.length === 1 && entry.name === 'index.html') app.get('/', send);
    }
  }
  visit(root);
}
