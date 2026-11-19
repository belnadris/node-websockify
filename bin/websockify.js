#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const websockify = require('../websockify.js');

const usage = 'Usage: websockify [--web web_dir] [--cert cert.pem [--key key.pem]] [source_addr:]source_port target_addr:target_port';

let parsed;
try {
	parsed = parseArgs({
		options: {
			web: { type: 'string' },
			cert: { type: 'string' },
			key: { type: 'string' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	});
} catch (err) {
	console.error(`${err.message}\n${usage}`);
	process.exit(2);
}

const { values, positionals } = parsed;
if (values.help) {
	console.log(usage);
	process.exit(0);
}
if (positionals.length !== 2) {
	console.error(usage);
	process.exit(2);
}

const { help, ...options } = values;
websockify({ ...options, source: positionals[0], target: positionals[1] }).catch((err) => {
	console.error(err.message);
	process.exit(1);
});
