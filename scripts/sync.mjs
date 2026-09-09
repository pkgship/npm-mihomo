#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, inflateRawSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GITHUB_REPO = 'MetaCubeX/mihomo'
const MAIN = {
  dir: 'packages/mihomo',
  pkg: '@bytemover/mihomo',
}
const PLATFORMS = JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'platforms.json'), 'utf8'))

const noPublish = process.argv.includes('--no-publish')
const versionIndex = process.argv.indexOf('--version')
const versionOverride = versionIndex >= 0 ? process.argv[versionIndex + 1] : undefined

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

function u16(buf, off) {
  return buf.readUInt16LE(off)
}

function u32(buf, off) {
  return buf.readUInt32LE(off)
}

async function fetchLatestVersion() {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers: { 'User-Agent': 'mihomo-npm' },
  })
  if (!res.ok) {
    throw new Error(`Failed to fetch latest release (${res.status})`)
  }
  const data = await res.json()
  return String(data.tag_name).replace(/^v/, '')
}

async function isPublished(pkgName, version) {
  const res = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/${version}`,
    { headers: { Accept: 'application/vnd.npm.install-v1+json' } },
  )
  return res.ok
}

async function fetchAsset(version, assetName) {
  if (process.env.MIHOMO_ASSET_DIR) {
    const localPath = path.join(process.env.MIHOMO_ASSET_DIR, assetName)
    if (existsSync(localPath)) {
      return readFileSync(localPath)
    }
    throw new Error(`Asset not found in MIHOMO_ASSET_DIR: ${localPath}`)
  }
  const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${assetName}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to download ${assetName} (${res.status}): ${url}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

function findEOCD(buf) {
  const from = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= from; i--) {
    if (u32(buf, i) === SIG_EOCD) return i
  }
  throw new Error('zip: end of central directory not found')
}

function listCentralEntries(buf, eocdOff) {
  const total = u16(buf, eocdOff + 10)
  const cdStart = u32(buf, eocdOff + 16)
  const entries = []
  let off = cdStart
  for (let n = 0; n < total; n++) {
    if (u32(buf, off) !== SIG_CENTRAL) {
      throw new Error('zip: invalid central directory entry')
    }
    const method = u16(buf, off + 10)
    const compSize = u32(buf, off + 20)
    const nameLen = u16(buf, off + 28)
    const extraLen = u16(buf, off + 30)
    const commentLen = u16(buf, off + 32)
    const localOffset = u32(buf, off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    entries.push({ name, method, compSize, localOffset })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function readZipEntry(buf, entry) {
  const off = entry.localOffset
  if (u32(buf, off) !== SIG_LOCAL) {
    throw new Error('zip: invalid local file header')
  }
  const nameLen = u16(buf, off + 26)
  const extraLen = u16(buf, off + 28)
  const dataStart = off + 30 + nameLen + extraLen
  const packed = buf.subarray(dataStart, dataStart + entry.compSize)
  if (entry.method === 8) return inflateRawSync(packed)
  if (entry.method === 0) return Buffer.from(packed)
  throw new Error(`zip: unsupported compression method ${entry.method}`)
}

function extractFromZip(buf) {
  const eocd = findEOCD(buf)
  const entries = listCentralEntries(buf, eocd)
  const target =
    entries.find((e) => path.posix.basename(e.name).startsWith('mihomo') && e.name.toLowerCase().endsWith('.exe')) ||
    entries.find((e) => e.name.toLowerCase().endsWith('.exe')) ||
    entries[0]
  if (!target) {
    throw new Error('zip: mihomo binary not found in archive')
  }
  return readZipEntry(buf, target)
}

function extractFromTarIfNeeded(buf) {
  if (buf.length < 512 || buf.toString('ascii', 257, 262) !== 'ustar') return buf
  let off = 0
  while (off + 512 <= buf.length) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '')
    if (!name) break
    const sizeOct = buf.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim() || '0'
    const size = parseInt(sizeOct, 8) || 0
    const type = String.fromCharCode(buf[off + 156])
    const data = buf.subarray(off + 512, off + 512 + size)
    if ((type === '0' || type === '\0') && path.posix.basename(name) === 'mihomo') {
      return Buffer.from(data)
    }
    off += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('tar: mihomo binary not found in archive')
}

function isExecutable(buf) {
  if (buf.length < 4) return false
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true
  if (buf[0] === 0x4d && buf[1] === 0x5a) return true
  const magicLE = buf.readUInt32LE(0)
  const magicBE = buf.readUInt32BE(0)
  if ([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcafebabf].includes(magicLE)) return true
  if ([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcafebabf].includes(magicBE)) return true
  return false
}

function decompress(raw, assetName) {
  let buf = raw
  if (assetName.endsWith('.gz')) {
    buf = gunzipSync(raw)
  } else if (assetName.endsWith('.zip')) {
    buf = extractFromZip(raw)
  }
  return extractFromTarIfNeeded(buf)
}

async function preparePlatform(platform, version) {
  const assetName = platform.asset.replace('{VERSION}', version)
  console.log(`[sync] downloading ${assetName}`)
  const raw = await fetchAsset(version, assetName)
  const binary = decompress(raw, assetName)
  if (!isExecutable(binary)) {
    throw new Error(`Extracted file is not a valid executable: ${assetName}`)
  }
  const binPath = path.join(ROOT, platform.dir, platform.binary)
  writeFileSync(binPath, binary)
  chmodSync(binPath, 0o755)
  console.log(`[sync] wrote ${platform.binary} (${(binary.length / 1024 / 1024).toFixed(1)} MiB)`)
}

function setPackageVersion(pkgPath, version, optionalDeps) {
  const pkgFile = path.join(ROOT, pkgPath, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  pkg.version = version
  if (optionalDeps) {
    pkg.optionalDependencies = { ...pkg.optionalDependencies, ...optionalDeps }
  }
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
}

function publishPackage(dir) {
  console.log(`[sync] publishing ${path.join(ROOT, dir)}`)
  execSync('npm publish --access public', { cwd: path.join(ROOT, dir), stdio: 'inherit' })
}

async function main() {
  const version = versionOverride ?? (await fetchLatestVersion())
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Unexpected version string: ${version}`)
  }
  console.log(`[sync] mihomo version: ${version}`)

  if (await isPublished(MAIN.pkg, version)) {
    console.log(`[sync] ${MAIN.pkg}@${version} is already published - nothing to do`)
    process.exit(0)
  }

  for (const platform of PLATFORMS) {
    await preparePlatform(platform, version)
  }

  const deps = Object.fromEntries(PLATFORMS.map((p) => [p.pkg, version]))
  setPackageVersion(MAIN.dir, version, deps)
  for (const platform of PLATFORMS) {
    setPackageVersion(platform.dir, version)
  }

  if (noPublish) {
    console.log(`[sync] prepared binaries for ${version} (publish skipped due to --no-publish)`)
    return
  }

  for (const platform of PLATFORMS) {
    publishPackage(platform.dir)
  }
  publishPackage(MAIN.dir)
  console.log(`[sync] done: published ${MAIN.pkg}@${version}`)
}

main().catch((err) => {
  console.error(`[sync] failed: ${err.message}`)
  process.exit(1)
})