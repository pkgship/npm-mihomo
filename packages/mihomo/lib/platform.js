"use strict";

const path = require("path");

const SUPPORTED_PLATFORMS = {
  "linux-x64": { pkg: "@bytemover/mihomo-linux-amd64", binary: "mihomo" },
  "linux-arm64": { pkg: "@bytemover/mihomo-linux-arm64", binary: "mihomo" },
  "darwin-x64": { pkg: "@bytemover/mihomo-darwin-amd64", binary: "mihomo" },
  "darwin-arm64": { pkg: "@bytemover/mihomo-darwin-arm64", binary: "mihomo" },
  "win32-x64": { pkg: "@bytemover/mihomo-windows-amd64", binary: "mihomo.exe" },
  "win32-arm64": {
    pkg: "@bytemover/mihomo-windows-arm64",
    binary: "mihomo.exe",
  },
  "android-arm64": { pkg: "@bytemover/mihomo-android-arm64", binary: "mihomo" },
};

function resolveBinary() {
  const key = process.platform + "-" + process.arch;
  const entry = SUPPORTED_PLATFORMS[key];
  if (!entry) {
    throw new Error(
      `Unsupported platform "${key}". Supported platforms: ${Object.keys(SUPPORTED_PLATFORMS).join(", ")}`,
    );
  }

  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve(entry.pkg + "/package.json"));
  } catch {
    throw new Error(
      `The platform package "${entry.pkg}" could not be found. ` +
        'Reinstall without "--no-optional" or "--ignore-scripts".',
    );
  }
  return path.join(pkgDir, entry.binary);
}

module.exports = { resolveBinary, SUPPORTED_PLATFORMS };
