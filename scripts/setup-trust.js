#!/usr/bin/env node
"use strict";

// One-off setup: point every published package at this repository as its
// trusted publisher, so the release workflow publishes through OIDC instead of
// a long-lived npm token. Needs `npm login` first, against an account that may
// manage the @pkgship scope.
//
//   node scripts/setup-trust.js [--dry-run]

const { execSync } = require("node:child_process");
const path = require("node:path");

const platforms = require("../lib/platforms.js");

const ROOT = path.join(__dirname, "..");
const REPO = "pkgship/npm-mihomo";
const FILE = "publish.yml";

const dryRun = process.argv.includes("--dry-run");

// Platform packages first, then the package that depends on them.
const packages = [
  ...Object.keys(platforms).map((id) => `@pkgship/mihomo-${id}`),
  "@pkgship/mihomo",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Configuring ${packages.length} packages:`);
  packages.forEach((p) => console.log(`  - ${p}`));
  console.log();

  const command = (pkg) =>
    `npm trust github ${pkg} --file ${FILE} --repo ${REPO} --allow-publish --yes`;

  if (dryRun) {
    console.log("[dry-run] would run:");
    for (const pkg of packages) console.log(`  ${command(pkg)}`);
    console.log("\n[dry-run] no changes made");
    return;
  }

  let failed = 0;

  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    console.log(
      `\n[${i + 1}/${packages.length}] Setting up trust for ${pkg}...`,
    );
    try {
      execSync(command(pkg), { cwd: ROOT, stdio: "inherit" });
      console.log(`  ✓ ${pkg} configured`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${pkg} failed: ${err.message}`);
    }
    // rate limit protection
    if (i < packages.length - 1) await sleep(2000);
  }

  console.log(
    `\nDone: ${packages.length - failed} succeeded, ${failed} failed out of ${packages.length}`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`[setup-trust] failed: ${err.message}`);
  process.exit(1);
});
