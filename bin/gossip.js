#!/usr/bin/env node
'use strict';

// Keep this first check in plain old JavaScript so even an ancient Node can run it.
var major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  console.error('gossip needs Node.js 18 or newer (this is ' + process.versions.node + ').');
  console.error('Re-run the gossip installer, or get Node from https://nodejs.org');
  process.exit(1);
}

// A newer gossip may have been downloaded in the background last time: switch to it
// now, before anything else is loaded. (Never fatal - worst case we run the old one.)
try {
  require('../src/update').applyStaged();
} catch (e) { /* carry on with what's here */ }

require('../src/cli').start(process.argv.slice(2));
