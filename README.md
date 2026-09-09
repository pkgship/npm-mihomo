# npm-mihomo

Automatically publishes the [mihomo](https://github.com/MetaCubeX/mihomo) (Clash Meta)
core binaries to npm, on a daily schedule.

## Published packages

| Package                           | Platform                                                         |
| --------------------------------- | ---------------------------------------------------------------- |
| `@bytemover/mihomo`               | Installer/meta package - auto-selects the right platform package |
| `@bytemover/mihomo-linux-amd64`   | Linux x64                                                        |
| `@bytemover/mihomo-linux-arm64`   | Linux arm64                                                      |
| `@bytemover/mihomo-darwin-amd64`  | macOS x64                                                        |
| `@bytemover/mihomo-darwin-arm64`  | macOS arm64                                                      |
| `@bytemover/mihomo-windows-amd64` | Windows x64                                                      |
| `@bytemover/mihomo-windows-arm64` | Windows arm64                                                    |
| `@bytemover/mihomo-android-arm64` | Android arm64-v8                                                 |

The main package lists every platform package under `optionalDependencies`, so npm
downloads only the binary matching the install environment. The `mihomo` command then
spawns it directly.

## Usage

```bash
npm install -g @bytemover/mihomo
mihomo -v
```

Or run without installing:

```bash
npx @bytemover/mihomo -v
```

## How publishing works

- The GitHub Actions workflow [`.github/workflows/publish.yml`](.github/workflows/publish.yml)
  runs every day at 06:00 UTC (changeable) and on-demand via `workflow_dispatch`.
- It calls [`scripts/sync.mjs`](scripts/sync.mjs), which:
  1. Fetches the latest stable release from `MetaCubeX/mihomo`.
  2. Skips if that version is already published on npm.
  3. Downloads each platform asset, extracts the raw binary (handles `.gz`, `.zip`,
     and tar-in-gz defensively), and verifies it looks like a valid executable.
  4. Writes the binaries into the platform packages and stamps the version into every
     `package.json` (including the main package's `optionalDependencies`).
  5. Publishes the platform packages first, then the main package, with provenance
     attestation (on GitHub Actions) via npm Trusted Publishers.

### One-time setup (Trusted Publishers)

Publishing uses npm **Trusted Publishers** (OIDC), so no npm access token is needed.
First, link this GitHub repository (`line486/npm-mihomo`) to each published package.
On the npm website: open a package's **Settings → Access → "Add trusted publisher"** →
connect GitHub → set Organization to `line486` and Repository to `npm-mihomo` — repeat
for all 8 packages. Or from the CLI (logged into the `@bytemover` scope):

```bash
for pkg in mihomo mihomo-linux-amd64 mihomo-linux-arm64 mihomo-darwin-amd64 \
           mihomo-darwin-arm64 mihomo-windows-amd64 mihomo-windows-arm64 \
           mihomo-android-arm64; do
  npm access set trustedpublisher "@bytemover/$pkg" GitHub line486 npm-mihomo
done
```

The workflow's `id-token: write` permission plus `npm publish --provenance` then
authenticate automatically on every run — no `NPM_TOKEN` secret required.

## Local development

Prepare binaries locally without publishing (fetches the latest release and writes
the binary files + versions):

```bash
node scripts/sync.mjs --no-publish
```

## License

The mihomo binaries are built and distributed by the upstream project
[MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) under the GPL-3.0 license.
