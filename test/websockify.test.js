'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
const websockify = require('../websockify.js');

let tmpDir;
let webDir;

async function startTcpServer(t, handler) {
	const sockets = new Set();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		handler(socket);
	});
	t.after(() => {
		for (const socket of sockets) socket.destroy();
		server.close();
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return server.address().port;
}

async function startProxy(t, options, callbacks) {
	const proxy = await websockify({ source: '127.0.0.1:0', log: false, ...options }, callbacks);
	t.after(() => proxy.close());
	return proxy;
}

const echo = (socket) => socket.pipe(socket);
const greeter = (greeting) => (socket) => socket.end(greeting);

function connect(port, urlPath = '/') {
	const client = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`);
	return once(client, 'open').then(() => client);
}

function receiveFirst(port, urlPath = '/') {
	const client = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`);
	return once(client, 'message').then(([data]) => {
		client.close();
		return data.toString();
	});
}

async function roundTrip(client, payload) {
	const reply = once(client, 'message');
	client.send(payload);
	const [data] = await reply;
	return data.toString();
}

function rawGet(port, urlPath) {
	return new Promise((resolve, reject) => {
		http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
			let body = '';
			res.on('data', (chunk) => (body += chunk));
			res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
		}).on('error', reject);
	});
}

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'websockify-'));
	webDir = path.join(tmpDir, 'web');
	fs.mkdirSync(webDir);
	fs.writeFileSync(path.join(webDir, 'index.html'), '<h1>index</h1>');
	fs.writeFileSync(path.join(webDir, 'app.js'), 'console.log(1)');
	fs.writeFileSync(path.join(tmpDir, 'secret.txt'), 'secret');
});

after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('proxies binary data between WebSocket client and TCP target', async (t) => {
	const targetPort = await startTcpServer(t, echo);
	const proxy = await startProxy(t, { target: `127.0.0.1:${targetPort}` });
	const client = await connect(proxy.address().port);

	assert.equal(await roundTrip(client, Buffer.from('hello')), 'hello');
	client.close();
});

test('runs several independent instances with their own targets', async (t) => {
	const portA = await startTcpServer(t, greeter('A'));
	const portB = await startTcpServer(t, greeter('B'));
	const [proxyA, proxyB] = await Promise.all([
		startProxy(t, { target: `127.0.0.1:${portA}` }),
		startProxy(t, { target: `127.0.0.1:${portB}` }),
	]);

	const [dataA, dataB] = await Promise.all([
		receiveFirst(proxyA.address().port),
		receiveFirst(proxyB.address().port),
	]);

	assert.equal(dataA, 'A');
	assert.equal(dataB, 'B');
});

test('rejects when the source port is already in use', async (t) => {
	const targetPort = await startTcpServer(t, echo);
	const proxy = await startProxy(t, { target: `127.0.0.1:${targetPort}` });

	await assert.rejects(
		websockify({ source: `127.0.0.1:${proxy.address().port}`, target: `127.0.0.1:${targetPort}`, log: false }),
		{ code: 'EADDRINUSE' },
	);
});

test('rejects invalid options instead of exiting the process', async () => {
	await assert.rejects(websockify({ source: '8080', target: 'nohost', log: false }), TypeError);
	await assert.rejects(websockify({ source: 'abc', target: '127.0.0.1:5900', log: false }), TypeError);
	await assert.rejects(websockify(), TypeError);
});

test('calls onConnected and onDisconnected callbacks', async (t) => {
	const targetPort = await startTcpServer(t, echo);
	const events = [];
	const { promise: disconnected, resolve } = Promise.withResolvers();
	const proxy = await startProxy(t, {
		target: `127.0.0.1:${targetPort}`,
		onConnected: (client, target) => events.push(['connected', target instanceof net.Socket]),
		onDisconnected: (client, code) => {
			events.push(['disconnected', code]);
			resolve();
		},
	});

	const client = await connect(proxy.address().port);
	await roundTrip(client, 'ping');
	client.close(1000);
	await disconnected;

	assert.deepEqual(events, [['connected', true], ['disconnected', 1000]]);
});

test('supports the legacy callbacks argument', async (t) => {
	const targetPort = await startTcpServer(t, echo);
	const { promise: connected, resolve } = Promise.withResolvers();
	const proxy = await startProxy(t, { target: `127.0.0.1:${targetPort}` }, { onConnected: resolve });

	const client = await connect(proxy.address().port);
	await connected;
	client.close();
});

test('serves static files with their MIME type', async (t) => {
	const targetPort = await startTcpServer(t, echo);
	const proxy = await startProxy(t, { target: `127.0.0.1:${targetPort}`, web: webDir });
	const port = proxy.address().port;

	const index = await rawGet(port, '/');
	assert.equal(index.status, 200);
	assert.match(index.type, /text\/html/);
	assert.equal(index.body, '<h1>index</h1>');

	assert.match((await rawGet(port, '/app.js')).type, /javascript/);
	assert.equal((await rawGet(port, '/missing.txt')).status, 404);
});

test('refuses to serve files outside the web directory', async (t) => {
	const targetPort = await startTcpServer(t, echo);
	const proxy = await startProxy(t, { target: `127.0.0.1:${targetPort}`, web: webDir });
	const port = proxy.address().port;

	for (const attempt of ['/../secret.txt', '/..%2Fsecret.txt', '/%2e%2e%2fsecret.txt']) {
		const res = await rawGet(port, attempt);
		assert.notEqual(res.body, 'secret', attempt);
		assert.notEqual(res.status, 200, attempt);
	}
});

test('returns 403 on HTTP requests when no web directory is set', async (t) => {
	const targetPort = await startTcpServer(t, echo);
	const proxy = await startProxy(t, { target: `127.0.0.1:${targetPort}` });

	assert.equal((await rawGet(proxy.address().port, '/')).status, 403);
});

test('attaches to an existing HTTP server and routes by path', async (t) => {
	const portA = await startTcpServer(t, greeter('A'));
	const portB = await startTcpServer(t, greeter('B'));
	const server = http.createServer((req, res) => res.end('app'));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;

	const proxyA = await websockify({ server, path: '/vnc/a', target: `127.0.0.1:${portA}`, log: false });
	const proxyB = await websockify({ server, path: '/vnc/b', target: `127.0.0.1:${portB}`, log: false });

	assert.equal(await receiveFirst(port, '/vnc/b'), 'B');
	assert.equal(await receiveFirst(port, '/vnc/a'), 'A');
	assert.equal((await rawGet(port, '/')).body, 'app');

	await Promise.all([proxyA.close(), proxyB.close()]);
	assert.ok(server.listening);
});
