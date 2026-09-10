#!/usr/bin/env node
"use strict";

// Thin wrapper. The real program is a native binary shipped by the
// per-platform optional dependency; this only picks the right one and hands
// over argv, stdio and the exit status.

const { spawn } = require("node:child_process");

const platforms = require("../lib/platforms.js");

const PACKAGES = {};
for (const [id, meta] of Object.entries(platforms)) {
  PACKAGES[`${meta.os}-${meta.cpu}`] = `@pkgship/mihomo-${id}`;
}

const platform = `${process.platform}-${process.arch}`;
const name = PACKAGES[platform];
if (!name) {
  console.error(`mihomo: no prebuilt binary for ${platform}`);
  process.exit(1);
}

// The platform package exports the path of its binary.
let binary;
try {
  binary = require(name);
} catch {
  console.error(
    `mihomo: the optional dependency ${name} is not installed.\n` +
      "Reinstall without --omit=optional or --ignore-scripts, for example `npm install -g @pkgship/mihomo`.",
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

child.on("error", (error) => {
  console.error(`mihomo: cannot run ${binary}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 0 : code);
});
