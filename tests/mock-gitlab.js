// Мок GitLab API v4 для тестов: проект, ветка и хранилище пакетов.
// Поддерживает ровно тот набор запросов, который использует core/gitlab.js.
const http = require('http');
const crypto = require('crypto');

function makeGitLab(project = 'me/server', token = 'gl-token') {
  const state = {
    project,
    token,
    branch: 'main',
    packages: [],          // { id, name, version, created_at, files: Map<name, Buffer> }
    nextFileId: 1000,
    requests: [],
    corrupt: new Map(),    // имя файла → подменить байты при выдаче
    failUpload: new Set(), // имена файлов, которые «не принимаются»
  };

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = decodeURIComponent(url.pathname);
      state.requests.push(`${req.method} ${url.pathname}`);

      const auth = req.headers['private-token'];
      if (!auth || auth !== state.token) {
        return json(res, 401, { message: '401 Unauthorized' });
      }

      /* проект */
      const projMatch = p.match(/^\/api\/v4\/projects\/(.+)$/);
      if (projMatch) {
        const rest = projMatch[1];
        if (rest === 'projects') return json(res, 404, { message: '404' });
        const slash = rest.indexOf('/');
        const path = rest.startsWith(state.project) ? state.project : rest.slice(0, rest.indexOf('/'));
        const tail = rest.slice(path.length);

        if (!tail) {
          return json(res, 200, {
            id: 1,
            path_with_namespace: state.project,
            default_branch: state.branch,
            web_url: 'https://gitlab.example/' + state.project,
            visibility: 'private',
          });
        }

        if (tail.startsWith('/repository/branches/')) {
          const name = tail.slice('/repository/branches/'.length);
          return name === state.branch
            ? json(res, 200, { name, default: true })
            : json(res, 404, { message: '404 Branch Not Found' });
        }

        /* список пакетов */
        if (tail === '/packages') {
          const name = url.searchParams.get('package_name');
          const list = state.packages
            .filter((x) => !name || x.name === name)
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
            .map((x) => ({ id: x.id, name: x.name, version: x.version, created_at: x.created_at, package_type: 'generic' }));
          return json(res, 200, list);
        }

        /* загрузка файла пакета: PUT /packages/generic/<pkg>/<ver>/<file> */
        const up = tail.match(/^\/packages\/generic\/([^/]+)\/([^/]+)\/(.+)$/);
        if (up && req.method === 'PUT') {
          const [, pkgName, version, fileName] = up;
          if (state.failUpload.has(fileName)) {
            return json(res, 413, { message: 'Payload Too Large' });
          }
          let pkg = state.packages.find((x) => x.name === pkgName && x.version === version);
          if (!pkg) {
            pkg = { id: 500 + state.packages.length, name: pkgName, version, created_at: new Date().toISOString(), files: new Map() };
            state.packages.push(pkg);
          }
          const prev = pkg.files.get(fileName);
          pkg.files.set(fileName, { id: prev ? prev.id : state.nextFileId++, buf: body });
          return json(res, 201, { message: '201 Created' });
        }

        /* файлы пакета */
        const filesMatch = tail.match(/^\/packages\/(\d+)\/package_files$/);
        if (filesMatch) {
          const pkg = state.packages.find((x) => x.id === Number(filesMatch[1]));
          if (!pkg) return json(res, 404, { message: '404 Package Not Found' });
          return json(res, 200, [...pkg.files.entries()].map(([file_name, rec]) => ({
            id: rec.id, file_name, size: rec.buf.length,
          })));
        }

        const downMatch = tail.match(/^\/packages\/(\d+)\/package_files\/(\d+)\/download$/);
        if (downMatch) {
          const pkg = state.packages.find((x) => x.id === Number(downMatch[1]));
          if (!pkg) return json(res, 404, { message: '404 Package Not Found' });
          const entry = [...pkg.files.entries()].find(([, rec]) => rec.id === Number(downMatch[2]));
          if (!entry) return json(res, 404, { message: '404 File Not Found' });
          const [name, rec] = entry;
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          if (state.corrupt.has(name)) return res.end(state.corrupt.get(name));
          return res.end(rec.buf);
        }

        const delMatch = tail.match(/^\/packages\/(\d+)$/);
        if (delMatch && req.method === 'DELETE') {
          const idx = state.packages.findIndex((x) => x.id === Number(delMatch[1]));
          if (idx < 0) return json(res, 404, { message: '404 Package Not Found' });
          state.packages.splice(idx, 1);
          res.writeHead(204);
          return res.end();
        }
      }

      return json(res, 404, { message: '404 Not Found (мок)' });
    });
  });

  return { server, state, listen: (port, host, cb) => server.listen(port, host, cb), close: () => server.close() };
}

module.exports = { makeGitLab };
