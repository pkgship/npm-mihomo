"use strict";

// The platforms mihomo binaries are published for.
//
// The key is used as the npm package suffix (`@pkgship/mihomo-<key>`) and as
// the release asset suffix. `os` and `cpu` are Node's process.platform/
// process.arch values, which is what npm matches against when it decides
// whether to install an optional dependency. `asset` is the upstream release
// asset name, with `{VERSION}` standing in for the release version.
module.exports = {
  "linux-amd64": {
    os: "linux",
    cpu: "x64",
    asset: "mihomo-linux-amd64-v{VERSION}.gz",
  },
  "linux-arm64": {
    os: "linux",
    cpu: "arm64",
    asset: "mihomo-linux-arm64-v{VERSION}.gz",
  },
  "darwin-amd64": {
    os: "darwin",
    cpu: "x64",
    asset: "mihomo-darwin-amd64-v{VERSION}.gz",
  },
  "darwin-arm64": {
    os: "darwin",
    cpu: "arm64",
    asset: "mihomo-darwin-arm64-v{VERSION}.gz",
  },
  "windows-amd64": {
    os: "win32",
    cpu: "x64",
    asset: "mihomo-windows-amd64-v{VERSION}.zip",
  },
  "windows-arm64": {
    os: "win32",
    cpu: "arm64",
    asset: "mihomo-windows-arm64-v{VERSION}.zip",
  },
  "android-arm64": {
    os: "android",
    cpu: "arm64",
    asset: "mihomo-android-arm64-v8-v{VERSION}.gz",
  },
};
