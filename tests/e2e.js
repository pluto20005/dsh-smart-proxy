'use strict';

/**
 * Self-contained end-to-end test for src/smart-proxy.js.
 *
 * Everything runs on loopback: a TCP echo server, a small HTTP origin, and a
 * mock upstream proxy. No internet access is required.
 *
 * Scenarios:
 *   1. upstream reachable  -> HTTP and CONNECT traffic go through the upstream
 *   2. upstream gone       -> traffic falls back to a direct connection
 *   3. /__smart_proxy/status reflects the upstream state
 *
 * Run with: node tests/e2e.js
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert');

const RELAY = path.join(__dirname, '..', 'src', 'smart-proxy.js');
const LOG = path.join(os.tmpdir(), `smart-proxy-e2e-${process.pid}.log`);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(`${label} timed out: ${lastError ? lastError.message : 'no result'}`);
}

function connectThrough(relayPort, host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: relayPort,
      method: 'CONNECT',
      path: `${host}:${port}`,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT returned ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.once('error', reject);
    req.end();
  });
}

function roundtrip(socket, message) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('echo timed out'));
    }, 4000);
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.destroy();
    }
    function onData(chunk) {
      buffer += chunk.toString('latin1');
      if (buffer.includes(message)) {
        cleanup();
        resolve(buffer);
      }
    }
    socket.on('data', onData);
    socket.once('error', (error) => {
      cleanup();
      reject(error);
    });
    socket.write(message);
  });
}

function getVia(relayPort, absoluteUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(absoluteUrl);
    const req = http.get({
      host: '127.0.0.1',
      port: relayPort,
      path: absoluteUrl,
      headers: { Host: url.host, Connection: 'close' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.once('error', reject);
  });
}

function getStatus(relayPort) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port: relayPort,
      path: '/__smart_proxy/status',
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.once('error', reject);
  });
}

async function main() {
  // ---- fixtures -----------------------------------------------------------
  const echo = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  const echoPort = await listen(echo);

  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('origin-ok');
  });
  const originPort = await listen(origin);

  const mock = http.createServer((req, res) => {
    mock.count += 1;
    let url;
    try { url = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
    const upstream = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: req.method,
      headers: req.headers,
    }, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    upstream.once('error', () => { if (!res.headersSent) { res.writeHead(502); } res.end(); });
    req.pipe(upstream);
  });
  mock.count = 0;
  const mockSockets = new Set();
  mock.on('connection', (socket) => {
    mockSockets.add(socket);
    socket.once('close', () => mockSockets.delete(socket));
  });
  mock.on('connect', (req, socket, head) => {
    mock.count += 1;
    const index = req.url.lastIndexOf(':');
    const host = req.url.slice(0, index);
    const port = Number(req.url.slice(index + 1));
    const upstream = net.connect(port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) socket.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.once('error', () => {
      try { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* closed */ }
    });
  });
  const mockPort = await listen(mock);

  // A free port for the relay (it cannot bind port 0 and report back).
  const probeServer = net.createServer();
  const relayPort = await listen(probeServer);
  await new Promise((resolve) => probeServer.close(resolve));

  // ---- start the relay ----------------------------------------------------
  let relay;
  try {
    relay = spawn(process.execPath, [RELAY], {
      env: {
        ...process.env,
        SMART_PROXY_PORT: String(relayPort),
        SMART_PROXY_UPSTREAM_PORT: String(mockPort),
        SMART_PROXY_PROBE: `127.0.0.1:${echoPort}`,
        SMART_PROXY_TTL: '1200',
        SMART_PROXY_LOG: LOG,
      },
      stdio: 'ignore',
    });

    await waitFor(() => getStatus(relayPort), 10000, 'relay startup');
    console.log('ok 1 - relay started');

    // ---- 1. upstream reachable: traffic is proxied ------------------------
    const socket = await connectThrough(relayPort, '127.0.0.1', echoPort);
    const echoed = await roundtrip(socket, 'tunnel-through-proxy');
    assert.ok(echoed.includes('tunnel-through-proxy'), 'CONNECT tunnel echoed the payload');
    assert.ok(mock.count >= 2, `expected the mock upstream to be used (count=${mock.count})`);
    console.log('ok 2 - CONNECT traffic goes through the upstream');

    const proxied = await getVia(relayPort, `http://127.0.0.1:${originPort}/hello`);
    assert.strictEqual(proxied.status, 200, 'proxied HTTP status');
    assert.strictEqual(proxied.body, 'origin-ok', 'proxied HTTP body');
    console.log('ok 3 - plain HTTP goes through the upstream');

    let status = await getStatus(relayPort);
    assert.strictEqual(status.upstreamAvailable, true, 'status reports the upstream as available');
    assert.ok(status.proxied >= 2, `status counts proxied requests (proxied=${status.proxied})`);
    console.log('ok 4 - status reports upstreamAvailable=true');

    // ---- 2. upstream gone: traffic falls back direct ---------------------
    const before = mock.count;
    await new Promise((resolve) => mock.close(resolve));
    for (const socket of mockSockets) socket.destroy();

    await sleep(1600); // let the probe cache expire

    const directSocket = await connectThrough(relayPort, '127.0.0.1', echoPort);
    const directEcho = await roundtrip(directSocket, 'tunnel-direct');
    assert.ok(directEcho.includes('tunnel-direct'), 'direct CONNECT tunnel echoed the payload');
    console.log('ok 5 - CONNECT falls back to a direct connection');

    const direct = await getVia(relayPort, `http://127.0.0.1:${originPort}/hello`);
    assert.strictEqual(direct.status, 200, 'direct HTTP status');
    assert.strictEqual(direct.body, 'origin-ok', 'direct HTTP body');
    assert.strictEqual(mock.count, before, 'the dead upstream was not used');
    console.log('ok 6 - plain HTTP falls back to a direct connection');

    status = await getStatus(relayPort);
    assert.strictEqual(status.upstreamAvailable, false, 'status reports the upstream as unavailable');
    assert.ok(status.direct >= 2, `status counts direct requests (direct=${status.direct})`);
    console.log('ok 7 - status reports upstreamAvailable=false');

    console.log('\nall tests passed');
  } finally {
    if (relay) relay.kill();
    await new Promise((resolve) => echo.close(resolve));
    await new Promise((resolve) => origin.close(resolve));
    try { fs.unlinkSync(LOG); } catch { /* ignore */ }
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('\nFAILED:', error.message);
  process.exit(1);
});
