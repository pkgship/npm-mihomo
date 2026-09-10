# @pkgship/mihomo

[mihomo](https://github.com/MetaCubeX/mihomo) (Clash Meta) core binary, distributed via npm.

## Install

```bash
npm install -g @pkgship/mihomo
```

npm automatically installs the correct binary package for your platform
(linux / macOS / windows / android, x64 / arm64) through `optionalDependencies`.

## Usage

```bash
mihomo -v
mihomo -d ./config-dir
```

You can also use it without installing:

```bash
npx @pkgship/mihomo -v
```

## How it works

- [@pkgship/mihomo-linux-amd64](...),
  [@pkgship/mihomo-linux-arm64](...),
  [@pkgship/mihomo-darwin-amd64](...),
  [@pkgship/mihomo-darwin-arm64](...),
  [@pkgship/mihomo-windows-amd64](...),
  [@pkgship/mihomo-windows-arm64](...),
  [@pkgship/mihomo-android-arm64](...) each contain the raw mihomo binary.
- This package depends on all of them as **optional** dependencies, so the package
  manager only downloads the one matching the current platform.

## Disclaimer

The binaries are built and released by the upstream project
[MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) under the GPL-3.0 license.
