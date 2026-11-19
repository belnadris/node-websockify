'use strict';

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const mime = require('mime-types');
const { WebSocketServer, WebSocket } = require('ws');

function parseAddress(value, name, requireHost) {
	const str = String(value ?? '');
	const idx = str.lastIndexOf(':');
	if (requireHost && idx < 0) {
		throw new TypeError(`${name} must be host:port`);
	}
	const host = idx >= 0 ? str.slice(0, idx).replace(/^\[(.*)\]$/, '$1') : '';
	const portStr = idx >= 0 ? str.slice(idx + 1) : str;
	const port = Number(portStr);
	if (portStr === '' || !Number.isInteger(port) || port < 0 || port > 65535) {
		throw new TypeError(`${name} has an illegal port: ${value}`);
	}
	return { host, port };
}

function sendError(res, code, message) {
	res.writeHead(code, { 'Content-Type': 'text/plain' });
	res.end(message + '\n');
}

async function serveStatic(root, req, res) {
	let pathname;
	try {
		pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
	} catch {
		return sendError(res, 400, '400 Bad Request');
	}

	let filename = path.join(root, pathname);
	if (filename !== root && !filename.startsWith(root + path.sep)) {
		return sendError(res, 403, '403 Permission Denied');
	}

	try {
		if ((await fs.promises.stat(filename)).isDirectory()) {
			filename = path.join(filename, 'index.html');
		}
		if (!(await fs.promises.stat(filename)).isFile()) {
			return sendError(res, 404, '404 Not Found');
		}
	} catch {
		return sendError(res, 404, '404 Not Found');
	}

	res.writeHead(200, { 'Content-Type': mime.lookup(filename) || 'application/octet-stream' });
	fs.createReadStream(filename)
		.on('error', () => res.destroy())
		.pipe(res);
}

function bridge(client, req, target, options) {
	const { log, onConnected, onDisconnected } = options;
	const clientAddr = req.socket.remoteAddress;
	const clientLog = (msg) => log(` ${clientAddr}: ${msg}`);

	clientLog(`WebSocket connection from ${clientAddr}, path: ${req.url}, subprotocol: ${client.protocol}`);

	const socket = net.createConnection(target.port, target.host, () => {
		clientLog('connected to target');
		if (!onConnected) return;
		try {
			onConnected(client, socket);
		} catch {
			clientLog('onConnected callback failed, cleaning up target');
			socket.end();
		}
	});

	socket.on('data', (data) => {
		if (client.readyState === WebSocket.OPEN) {
			client.send(data);
		}
	});
	socket.on('error', (err) => clientLog(`target connection error: ${err.message}`));
	socket.on('close', () => {
		clientLog('target disconnected');
		client.close();
	});

	client.on('message', (data) => socket.write(data));
	client.on('error', (err) => clientLog(`WebSocket client error: ${err.message}`));
	client.on('close', (code, reason) => {
		clientLog(`WebSocket client disconnected: ${code} [${reason}]`);
		socket.end();
		if (!onDisconnected) return;
		try {
			onDisconnected(client, code, reason.toString());
		} catch {
			clientLog('onDisconnected callback failed');
		}
	});
}

function listen(server, port, host) {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host || undefined, () => {
			server.off('error', reject);
			resolve();
		});
	});
}

async function websockify(options, callbacks) {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object');
	}

	const target = parseAddress(options.target, 'target', true);
	const attached = Boolean(options.server);
	const source = attached ? null : parseAddress(options.source, 'source', false);
	const log = options.log === false ? () => {} : options.log || console.log;
	const bridgeOptions = {
		log,
		onConnected: options.onConnected || callbacks?.onConnected,
		onDisconnected: options.onDisconnected || callbacks?.onDisconnected,
	};

	let server = options.server;
	if (!attached) {
		const root = options.web ? path.resolve(options.web) : null;
		const handler = (req, res) => {
			if (!root) return sendError(res, 403, '403 Permission Denied');
			serveStatic(root, req, res).catch(() => res.destroy());
		};
		if (options.cert) {
			const cert = fs.readFileSync(options.cert);
			const key = fs.readFileSync(options.key || options.cert);
			server = https.createServer({ cert, key }, handler);
		} else {
			server = http.createServer(handler);
		}
	}

	const wss = new WebSocketServer({ noServer: true });
	wss.on('connection', (client, req) => bridge(client, req, target, bridgeOptions));

	const onUpgrade = (req, socket, head) => {
		if (options.path && new URL(req.url, 'http://localhost').pathname !== options.path) {
			if (!attached) socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req));
	};
	server.on('upgrade', onUpgrade);

	if (!attached) {
		try {
			await listen(server, source.port, source.host);
		} catch (err) {
			server.off('upgrade', onUpgrade);
			wss.close();
			throw err;
		}
	}

	log('WebSocket settings:');
	log(`    - proxying from ${attached ? 'attached server' : `${source.host}:${server.address().port}`}${options.path ? ` (path ${options.path})` : ''} to ${target.host}:${target.port}`);
	if (options.web && !attached) log(`    - Web server active. Serving: ${options.web}`);
	if (!attached) log(`    - Running in ${options.cert ? 'encrypted HTTPS (wss://)' : 'unencrypted HTTP (ws://)'} mode`);

	return {
		server,
		wss,
		address: () => server.address(),
		close: () => new Promise((resolve) => {
			server.off('upgrade', onUpgrade);
			for (const client of wss.clients) client.terminate();
			wss.close(() => {
				if (attached) return resolve();
				server.close(() => resolve());
				server.closeAllConnections?.();
			});
		}),
	};
}

module.exports = websockify;
