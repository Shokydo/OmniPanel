// Мок GitHub API (Git Data + аккаунт) для тестов OmniPanel без интернета.
const http = require('http');
const crypto = require('crypto');
const store = { blobs: new Map(), trees: new Map(), commits: new Map(), refs: new Map(), repos: [] };
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

function makeServer(repoFull = 'o/r') {
  store.repos = [{ full_name: repoFull, name: repoFull.split('/')[1], owner: { login: repoFull.split('/')[0] }, private: true, permissions: { push: true }, updated_at: new Date().toISOString(), size: 0 }];
  return http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    const p = new URL(req.url, 'http://x').pathname;
    const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (!String(req.headers.authorization || '').includes('test-token')) return send(401, { message: 'Bad credentials' });

    let m;
    if (p === '/user' && req.method === 'GET') return send(200, { login: 'tester', name: 'Тестер', avatar_url: 'https://x/a.png', html_url: 'https://github.com/tester' });
    if (p === '/user/repos' && req.method === 'GET') return send(200, store.repos);
    if (p === '/user/repos' && req.method === 'POST') {
      const full = `tester/${json.name}`;
      store.repos.unshift({ full_name: full, name: json.name, owner: { login: 'tester' }, private: !!json.private, permissions: { push: true }, updated_at: new Date().toISOString(), size: 0 });
      return send(201, { full_name: full, private: !!json.private, html_url: 'https://github.com/' + full });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(p)) && req.method === 'GET') {
      const r = store.repos.find((x) => x.full_name === m[1]);
      return r ? send(200, r) : send(404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/(.+)$/.exec(p)) && req.method === 'GET') {
      const s = store.refs.get(decodeURIComponent(m[2]));
      return s ? send(200, { object: { sha: s } }) : send(404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/commits\/(.+)$/.exec(p)) && req.method === 'GET') {
      const c = store.commits.get(m[2]);
      return c ? send(200, c) : send(404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/trees\/([^?]+)/.exec(p)) && req.method === 'GET') {
      const t = store.trees.get(m[2]);
      return t ? send(200, { sha: m[2], tree: t, truncated: false }) : send(404, { message: 'Not Found' });
    }
    if (/^\/repos\/[^/]+\/[^/]+\/git\/blobs$/.test(p) && req.method === 'POST') {
      const buf = Buffer.from(json.content, json.encoding === 'base64' ? 'base64' : 'utf8');
      const s = blobSha(buf);
      store.blobs.set(s, buf);
      return send(201, { sha: s, size: buf.length });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/blobs\/(.+)$/.exec(p)) && req.method === 'GET') {
      const b = store.blobs.get(m[2]);
      return b ? send(200, { content: b.toString('base64'), encoding: 'base64', sha: m[2], size: b.length }) : send(404, { message: 'Not Found' });
    }
    if (/^\/repos\/[^/]+\/[^/]+\/git\/trees$/.test(p) && req.method === 'POST') {
      const base = json.base_tree ? store.trees.get(json.base_tree) || [] : [];
      const map = new Map(base.map((e) => [e.path, e]));
      for (const e of json.tree) {
        if (e.sha === null) map.delete(e.path);
        else map.set(e.path, { path: e.path, mode: e.mode, type: 'blob', sha: e.sha, size: (store.blobs.get(e.sha) || Buffer.alloc(0)).length });
      }
      const entries = [...map.values()];
      const s = sha(JSON.stringify(entries));
      store.trees.set(s, entries);
      return send(201, { sha: s, tree: entries });
    }
    if (/^\/repos\/[^/]+\/[^/]+\/git\/commits$/.test(p) && req.method === 'POST') {
      const s = sha(JSON.stringify(json) + Date.now() + Math.random());
      store.commits.set(s, { sha: s, tree: { sha: json.tree }, parents: (json.parents || []).map((x) => ({ sha: x })), message: json.message });
      return send(201, store.commits.get(s));
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/refs\/heads\/(.+)$/.exec(p)) && req.method === 'PATCH') {
      store.refs.set(decodeURIComponent(m[2]), json.sha);
      return send(200, { object: { sha: json.sha } });
    }
    if (/^\/repos\/[^/]+\/[^/]+\/git\/refs$/.test(p) && req.method === 'POST') {
      store.refs.set(json.ref.replace('refs/heads/', ''), json.sha);
      return send(201, { ref: json.ref, object: { sha: json.sha } });
    }
    send(404, { message: 'no route ' + req.method + ' ' + p });
  });
}

module.exports = { makeServer, store };
