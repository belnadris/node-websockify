# WebSocket-to-TCP proxy/bridge in NodeJS (forked & inspired by https://github.com/novnc/websockify)
[![CI](https://github.com/maximegris/node-websockify/actions/workflows/ci.yml/badge.svg)](https://github.com/maximegris/node-websockify/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat)](https://github.com/maximegris/node-websockify/blob/master/LICENSE.md)

Node-websockify is a WebSocket-to-TCP proxy/bridge you can use in a NodeJS program.

As said it is inspired by the javascript library of https://github.com/novnc/websockify (now https://github.com/novnc/websockify-js, unmaintained). Unfortunately this library can't be used directly in a NodeJS program. That's the reason why I created this project.

Requires Node.js 22 or later.

## Usage ##

Import this module in your project

```bash
npm install --save @maximegris/node-websockify
```

Require the module and call it in your program code. It returns a promise that resolves once the server is listening, and rejects on invalid options or if the port is already in use.

```javascript
const websockify = require('@maximegris/node-websockify');

const proxy = await websockify({ source: '127.0.0.1:8080', target: '192.168.0.100:5900' });

// later
await proxy.close();
```

### Handling errors ###

```javascript
websockify({ source: '127.0.0.1:8080', target: '192.168.0.100:5900' })
  .catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('Port 8080 is already in use');
    }
  });
```

### Several targets ###

Each call creates an independent proxy:

```javascript
const proxies = await Promise.all([
  websockify({ source: '127.0.0.1:8081', target: '10.0.0.1:5900' }),
  websockify({ source: '127.0.0.1:8082', target: '10.0.0.2:5900' }),
]);
```

### Attaching to an existing HTTP server (Express, ...) ###

Pass your own `http`/`https` server and an optional `path`. Several proxies can share the same server with different paths, other upgrade requests (socket.io, ...) are left untouched.

```javascript
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);

await websockify({ server, path: '/vnc/1', target: '10.0.0.1:5900' });
await websockify({ server, path: '/vnc/2', target: '10.0.0.2:5900' });

server.listen(80);
```

### Callbacks ###

```javascript
await websockify({
  source: '127.0.0.1:8080',
  target: '192.168.0.100:5900',
  onConnected: (client, target) => console.log('connected'),
  onDisconnected: (client, code, reason) => console.log('disconnected', code, reason),
});
```

## Options ##

| Option | Description | Default |
|---|---|---|
| source | `host:port` (or `port`) the WebSocket server listens on. Ignored when `server` is set. Use port `0` for a random free port | required |
| target | `host:port` of the TCP server (VNC, ...) | required |
| server | Existing `http`/`https` server to attach to instead of creating one | null |
| path | Only accept WebSocket connections on this URL path | null (all paths) |
| web | Directory of static files served over HTTP. Ignored when `server` is set | null |
| cert | Path of the SSL certificate (enables `wss://`) | null |
| key | Path of the SSL certificate key | `cert` |
| onConnected | `(client, targetSocket) => void`, called once the target is connected | null |
| onDisconnected | `(client, code, reason) => void`, called when the WebSocket client disconnects | null |
| log | Logging function, or `false` to disable logs | `console.log` |

## Returned object ##

| Property | Description |
|---|---|
| server | The underlying `http`/`https` server |
| wss | The `ws` `WebSocketServer` |
| address() | `server.address()`, useful with port `0` |
| close() | Closes all connections and the server (the server is left open when it was passed with `server`). Returns a promise |

## Command line ##

```bash
npx @maximegris/node-websockify [--web web_dir] [--cert cert.pem [--key key.pem]] [source_addr:]source_port target_addr:target_port
```

## Migrating from 1.x ##

- Node.js 22 or later is required.
- `websockify()` now returns a promise. Invalid options and listen errors reject it instead of calling `process.exit()` or throwing an uncatchable error.
- Callbacks can be passed in the options. The second `callbacks` argument is still supported.
- Static file requests can no longer escape the `web` directory.
