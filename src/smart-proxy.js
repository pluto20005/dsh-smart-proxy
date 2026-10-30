#!/usr/bin/env node
'use strict';

/**
 * smart-proxy: 本机智能转发代理
 *
 * 目的：让 DSH 永远指向 http://127.0.0.1:7900，
 * 由本程序在每次连接时判断：
 *   - 上游代理（如 Clash / Bluelayer 的混合端口 7897）能真正连出去 -> 转发给它（走 VPN）
 *   - 上游不可用 -> 自己直连目标（不开 VPN 时照常上网）
 *
 * 只监听 127.0.0.1，不修改系统代理、不装网卡、不写注册表。
 *
 * 可用环境变量覆盖：
 *   SMART_PROXY_PORT            监听端口（默认 7900）
 *   SMART_PROXY_UPSTREAM_PORT   上游 HTTP 代理端口（默认 7897）
 *   SMART_PROXY_UPSTREAM_HOST   上游主机（默认 127.0.0.1）
 *   SMART_PROXY_PROBE           探测目标 host:port（默认 www.google.com:443）
 *   SMART_PROXY_TTL             探测结果缓存毫秒（默认 12000）
 *   SMART_PROXY_LOG             日志文件（默认脚本同目录 smart-proxy.log）
 */

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const LISTEN_HOST = process.env.SMART_PROXY_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.SMART_PROXY_PORT || 7900);
const UPSTREAM_HOST = process.env.SMART_PROXY_UPSTREAM_HOST || '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.SMART_PROXY_UPSTREAM_PORT || 7897);
const PROBE = process.env.SMART_PROXY_PROBE || 'www.google.com:443';
const PROBE_TIMEOUT = Number(process.env.SMART_PROXY_PROBE_TIMEOUT || 3000);
const CACHE_TTL = Number(process.env.SMART_PROXY_TTL || 12000);
const LOG_FILE = process.env.SMART_PROXY_LOG || path.join(__dirname, 'smart-proxy.log');
const PID_FILE = path.join(__dirname, 'smart-proxy.pid');
const VERSION = '1.0.0';

const probeHost = PROBE.slice(0, PROBE.lastIndexOf(':'));
const probePort = Number(PROBE.slice(PROBE.lastIndexOf(':') + 1)) || 443;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) { /* 日志失败不影响转发 */ }
}

// ---------------------------------------------------------------- 上游探测

let upstreamUp = null;      // null=未知 true=可用 false=不可用
let upstreamCheckedAt = 0;  // 毫秒时间戳
let probing = null;         // 去重：同一时刻只探测一次

const stats = { served: 0, proxied: 0, direct: 0, lastRequestAt: null };

function noteServed() {
  stats.served += 1;
  stats.lastRequestAt = new Date().toISOString();
}

function probeUpstream() {
  if (probing) return probing;
  probing = new Promise((resolve) => {
    const sock = net.connect({ host: UPSTREAM_HOST, port: UPSTREAM_PORT });
    let buf = '';
    let done = false;

    const finish = (ok, why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (upstreamUp !== ok) {
        log(`upstream ${ok ? 'available' : 'unavailable'}${why ? ' (' + why + ')' : ''}`);
      }
      upstreamUp = ok;
      upstreamCheckedAt = Date.now();
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false, 'timeout'), PROBE_TIMEOUT);

    sock.once('error', (e) => finish(false, e.code || 'error'));
    sock.once('close', () => finish(false, 'closed'));
    sock.once('connect', () => {
      sock.write(`CONNECT ${probeHost}:${probePort} HTTP/1.1\r\nHost: ${probeHost}:${probePort}\r\n\r\n`);
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.indexOf('\r\n\r\n') === -1) return;
      const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(buf);
      const status = m ? Number(m[1]) : 0;
      finish(status === 200, `status ${status || '?'}`);
    });
  }).finally(() => { probing = null; });
  return probing;
}

async function proxyAvailable() {
  if (upstreamUp === null || Date.now() - upstreamCheckedAt > CACHE_TTL) {
    await probeUpstream();
  }
  return upstreamUp === true;
}

function markUpstreamDown() {
  if (upstreamUp !== false) log('upstream marked down after failure');
  upstreamUp = false;
  upstreamCheckedAt = Date.now();
}

// ---------------------------------------------------------------- 工具函数

function parseAuthority(authority) {
  if (!authority) return null;
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(authority);
  if (m) return { host: m[1], port: Number(m[2]) };
  const i = authority.lastIndexOf(':');
  if (i > 0) return { host: authority.slice(0, i), port: Number(authority.slice(i + 1)) };
  return { host: authority, port: 443 };
}

function statusPage(res) {
  const body = JSON.stringify({
    name: 'smart-proxy',
    version: VERSION,
    listen: `${LISTEN_HOST}:${LISTEN_PORT}`,
    upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
    probe: PROBE,
    upstreamAvailable: upstreamUp,
    checkedAgoMs: upstreamCheckedAt ? Date.now() - upstreamCheckedAt : null,
    uptimeSec: Math.round(process.uptime()),
    served: stats.served,
    proxied: stats.proxied,
    direct: stats.direct,
    lastRequestAt: stats.lastRequestAt,
  }, null, 2);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body + '\n');
}

// ---------------------------------------------------------------- CONNECT（HTTPS / WSS）

function handleConnect(req, clientSocket, head) {
  const target = parseAuthority(req.url);
  if (!target) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  noteServed();
  clientSocket.pause();
  clientSocket.setNoDelay(true);
  clientSocket.on('error', () => { /* 客户端断开，交给 pipe 清理 */ });

  proxyAvailable().then((up) => {
    if (up) {
      proxyConnect(target, clientSocket, head);
    } else {
      directConnect(target, clientSocket, head);
    }
  }).catch(() => directConnect(target, clientSocket, head));
}

function proxyConnect(target, clientSocket, head) {
  const upstream = net.connect({ host: UPSTREAM_HOST, port: UPSTREAM_PORT });
  let settled = false;
  let buf = '';

  const cleanup = () => {
    upstream.removeListener('data', onData);
    upstream.removeListener('close', onClose);
  };

  const fail = (why) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanup();
    upstream.destroy();
    log(`proxy connect failed for ${target.host}:${target.port}: ${why}; falling back to direct`);
    markUpstreamDown();
    directConnect(target, clientSocket, head);
  };

  const onClose = () => { if (!settled) fail('upstream closed'); };

  const timer = setTimeout(() => fail('timeout'), 10000);

  upstream.once('error', (e) => fail(e.code || 'error'));
  upstream.once('close', onClose);
  upstream.once('connect', () => {
    upstream.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n\r\n`);
  });

  const onData = (chunk) => {
    buf += chunk.toString('latin1');
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    settled = true;
    clearTimeout(timer);
    cleanup();

    const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(buf);
    const status = m ? Number(m[1]) : 0;
    if (status !== 200) {
      upstream.destroy();
      log(`upstream refused CONNECT ${target.host}:${target.port} (${status}); falling back to direct`);
      directConnect(target, clientSocket, head);
      return;
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) clientSocket.write(head);
    const rest = Buffer.from(buf.slice(idx + 4), 'latin1');
    if (rest.length) clientSocket.write(rest);
    stats.proxied += 1;

    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    clientSocket.resume();
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
  };

  upstream.on('data', onData);
}

function directConnect(target, clientSocket, head) {
  const upstream = net.connect({ host: target.host, port: target.port });
  let connected = false;

  const timer = setTimeout(() => {
    if (connected) return;
    upstream.destroy();
    if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
  }, 15000);

  upstream.once('connect', () => {
    connected = true;
    clearTimeout(timer);
    upstream.setNoDelay(true);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) clientSocket.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    clientSocket.resume();
    stats.direct += 1;
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
  });

  upstream.once('error', (e) => {
    if (connected) return;
    clearTimeout(timer);
    log(`direct connect failed for ${target.host}:${target.port}: ${e.code || e.message}`);
    if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
}

// ---------------------------------------------------------------- 普通 HTTP

function handleRequest(req, res) {
  // 状态页：客户端直接访问 /__smart_proxy/status（不是绝对 URL）
  if (req.url === '/__smart_proxy/status') {
    statusPage(res);
    return;
  }
  noteServed();

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('smart-proxy: only proxy-style absolute URLs are supported\n');
    return;
  }
  if (url.protocol !== 'http:') {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('smart-proxy: CONNECT is required for https\n');
    return;
  }

  proxyAvailable().then((up) => {
    if (up) {
      forwardToUpstream(req, res);
    } else {
      forwardDirect(req, res, url);
    }
  }).catch(() => forwardDirect(req, res, url));
}

function forwardToUpstream(req, res) {
  const headers = { ...req.headers };
  delete headers['proxy-connection'];

  const upReq = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: req.method,
    path: req.url,
    headers,
  }, (upRes) => {
    stats.proxied += 1;
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
    upRes.on('error', () => res.destroy());
  });

  upReq.on('error', (e) => {
    log(`upstream request failed ${req.method} ${req.url}: ${e.code || e.message}; falling back to direct`);
    markUpstreamDown();
    if (!res.headersSent) {
      let url;
      try { url = new URL(req.url); } catch (_) { res.destroy(); return; }
      forwardDirect(req, res, url);
    } else {
      res.destroy();
    }
  });

  req.pipe(upReq);
  req.on('error', () => upReq.destroy());
  res.on('close', () => { if (!upReq.destroyed) upReq.destroy(); });
}

function forwardDirect(req, res, url) {
  const headers = { ...req.headers };
  delete headers['proxy-connection'];
  headers.host = url.host;

  const upReq = http.request({
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname + url.search,
    method: req.method,
    headers,
  }, (upRes) => {
    stats.direct += 1;
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
    upRes.on('error', () => res.destroy());
  });

  upReq.on('error', (e) => {
    log(`direct request failed ${req.method} ${url.href}: ${e.code || e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('smart-proxy: upstream unreachable\n');
    } else {
      res.destroy();
    }
  });

  req.pipe(upReq);
  req.on('error', () => upReq.destroy());
  res.on('close', () => { if (!upReq.destroyed) upReq.destroy(); });
}

// ---------------------------------------------------------------- 启动

const server = http.createServer(handleRequest);
server.on('connect', handleConnect);
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`listen ${LISTEN_HOST}:${LISTEN_PORT} already in use; another smart-proxy may be running`);
    process.exit(0);
  }
  log(`server error: ${e.stack || e.message}`);
  process.exit(1);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (_) { /* 只读目录也能跑 */ }
  log(`listening on ${LISTEN_HOST}:${LISTEN_PORT}, upstream ${UPSTREAM_HOST}:${UPSTREAM_PORT}, probe ${PROBE}`);
  probeUpstream();
});

process.on('exit', () => {
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch (_) { /* 忽略 */ }
});

process.on('uncaughtException', (e) => {
  log(`uncaught: ${e.stack || e.message}`);
});
