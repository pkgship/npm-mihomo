# npm-mihomo

Automatically publishes the [mihomo](https://github.com/MetaCubeX/mihomo) (Clash Meta)
core binaries to npm, on a daily schedule.

## Published packages

| Package                         | Platform                                                         |
| ------------------------------- | ---------------------------------------------------------------- |
| `@pkgship/mihomo`               | Installer/meta package - auto-selects the right platform package |
| `@pkgship/mihomo-linux-amd64`   | Linux x64                                                        |
| `@pkgship/mihomo-linux-arm64`   | Linux arm64                                                      |
| `@pkgship/mihomo-darwin-amd64`  | macOS x64                                                        |
| `@pkgship/mihomo-darwin-arm64`  | macOS arm64                                                      |
| `@pkgship/mihomo-windows-amd64` | Windows x64                                                      |
| `@pkgship/mihomo-windows-arm64` | Windows arm64                                                    |
| `@pkgship/mihomo-android-arm64` | Android arm64-v8                                                 |

The main package lists every platform package under `optionalDependencies`, so npm
downloads only the binary matching the install environment. The `mihomo` command then
spawns it directly.

## Usage

```bash
npm install -g @pkgship/mihomo
mihomo -v
```

Or run without installing:

```bash
npx @pkgship/mihomo -v
```

## Repository layout

Only the root package is hand-written. The seven platform packages are generated into
`publish/` at build time, so no per-platform manifest is committed and no version is
written back to the repository:

- `package.json` — the root package manifest, kept at `0.0.0`; the generated copy in
  `publish/` is stamped with the release version.
- `lib/platforms.js` — the one list of published platforms: package suffix,
  `os`/`cpu`, and the upstream release asset.
- `bin/mihomo.js` — the shim that runs the binary from the matching platform package.
- `scripts/sync.js` — syncs one upstream release into the tree under `publish/`.
- `scripts/setup-trust.js` — one-off npm Trusted Publishers setup.

## How publishing works

- The GitHub Actions workflow [`.github/workflows/publish.yml`](.github/workflows/publish.yml)
  runs every day at 06:00 UTC (changeable) and on-demand via `workflow_dispatch`.
- [`scripts/sync.js`](scripts/sync.js) then:
  1. Fetches the latest stable release from `MetaCubeX/mihomo`, or uses `--version`.
  2. Asks the registry which packages already have that version, and skips those —
     an already published binary is never downloaded again, so a partially published
     release only resumes the missing parts.
  3. Downloads the remaining platform assets, extracts the raw binary (`.gz` or
     `.zip`), and verifies it looks like a valid executable.
  4. Writes one package per platform plus the root package into `publish/`, and lists
     them in `publish/.packages` in publish order.
- The workflow walks `publish/.packages` and runs `npm publish` for each entry that is
  not on the registry yet — platform packages first, then the root package — with
  provenance attestation via npm Trusted Publishers.

### One-time setup (Trusted Publishers)

Publishing uses npm **Trusted Publishers** (OIDC), so no npm access token is needed.
First, link this GitHub repository (`pkgship/npm-mihomo`) to each published package.
After `npm login` (the account needs 2FA and rights on the `@pkgship` scope):

```bash
node scripts/setup-trust.js --dry-run   # show the commands
node scripts/setup-trust.js             # npm trust github ... for all 8 packages
```

That runs `npm trust github <package> --file publish.yml --repo pkgship/npm-mihomo
--allow-publish --yes` for every package. It can also be done on the npm website:
open a package's **Settings → Access → "Add trusted publisher"** → connect GitHub →
Organization `pkgship`, Repository `npm-mihomo`.

The workflow's `id-token: write` permission plus `npm publish --provenance` then
authenticate automatically on every run — no `NPM_TOKEN` secret required.

## Local development

Build the packages locally without publishing anything:

```bash
node scripts/sync.js                  # latest upstream release
node scripts/sync.js --version 1.19.30
```

The result lands in `publish/`; nothing outside it is touched. Set
`MIHOMO_ASSET_DIR=<dir>` to read the release assets from a local directory instead of
downloading them.

The release lookup uses the GitHub API. Unauthenticated it is capped at
60 requests/hour per IP (returns HTTP 403 once exhausted); a token raises this to
5000. The token is read from `GITHUB_TOKEN`/`GH_TOKEN`, else discovered from the
local `gh` CLI (`gh auth login`), so CI and local runs both authenticate.

## License

The mihomo binaries are built and distributed by the upstream project
[MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) under the GPL-3.0 license.
