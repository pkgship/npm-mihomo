#!/usr/bin/env node
"use strict";

// Sync the npm packages for one mihomo release: bring the upstream release and
// the registry together into a tree that is ready to publish.
//
//   @pkgship/mihomo-<platform>   the raw binary for one platform
//   @pkgship/mihomo              the shim plus one optionalDependency per platform
//
// A version that is already on the registry is left alone and its binary is
// never downloaded again, so a partially published release can be resumed by
// re-running this. The binaries come from the upstream GitHub release, so no
// per-platform package is committed to the repository; the tree is written to
// <out> and listed in <out>/.packages as tab separated "<directory>\t<name>\t
// <version>" lines, in publish order (platform packages first, so the root
// package never briefly points at packages that do not exist yet). Publishing
// is the workflow's job.
//
//   node scripts/sync.js [--version <version>] [--out publish]

const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { execFileSync } = require("node:child_process");
const { connect: netConnect } = require("node:net");
const path = require("node:path");
const { connect: tlsConnect } = require("node:tls");
const { gunzipSync, inflateRawSync } = require("node:zlib");

const platforms = require("../lib/platforms.js");

const ROOT = path.join(__dirname, "..");
const SCOPE = "@pkgship";
const GITHUB_REPO = "MetaCubeX/mihomo";
const LICENSE = "GPL-3.0-or-later";
const HOMEPAGE = "https://github.com/MetaCubeX/mihomo#readme";
const REPOSITORY = {
  type: "git",
  url: "git+https://github.com/pkgship/npm-mihomo.git",
};
// Copied from the repository into the root package as-is.
const SHIPPED = ["bin/mihomo.js", "lib/platforms.js"];

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const options = { version: null, out: "publish" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i].replace(/^--/, "");
  if (!(key in options)) {
    console.error(`error: unknown option ${argv[i]}`);
    process.exit(1);
  }
  if (i + 1 >= argv.length) {
    console.error(`error: ${argv[i]} needs a value`);
    process.exit(1);
  }
  options[key] = argv[i + 1];
}

function u16(buf, off) {
  return buf.readUInt16LE(off);
}

function u32(buf, off) {
  return buf.readUInt32LE(off);
}

function isProxiedHost(hostname) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
  const entries = noProxy
    .split(",")
    .map((s) => s.trim().replace(/^\./, ""))
    .filter(Boolean);
  if (entries.includes("*")) return false;
  if (entries.some((h) => hostname === h || hostname.endsWith("." + h)))
    return false;
  return Boolean(
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy,
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(err) {
  const msg = String(err?.message || err?.code || "");
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|disconnect|reset by peer|timeout|closed|TLS|tunnel|zip:|executable|central directory|local file header|compression method|incomplete response|HTTP 5\d\d/i.test(
    msg,
  );
}

function connectThroughProxy(proxy, hostname, port) {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy);
    const proxyPort =
      Number(proxyUrl.port) || (proxyUrl.protocol === "https:" ? 443 : 80);
    const auth = proxyUrl.username
      ? "Basic " +
        Buffer.from(
          decodeURIComponent(proxyUrl.username) +
            ":" +
            decodeURIComponent(proxyUrl.password),
        ).toString("base64")
      : null;

    let rawSocket;
    let onReady;
    let ready = () => {};
    const pending = new Promise((res) => {
      ready = res;
    });

    if (proxyUrl.protocol === "https:") {
      rawSocket = tlsConnect({
        host: proxyUrl.hostname,
        port: proxyPort,
        servername: proxyUrl.hostname,
      });
      rawSocket.once("secureConnect", ready);
    } else {
      rawSocket = netConnect({ host: proxyUrl.hostname, port: proxyPort });
      rawSocket.once("connect", ready);
    }
    rawSocket.once("error", reject);

    const connectTimer = setTimeout(() => {
      rawSocket.destroy(
        new Error(`proxy ${proxyUrl.hostname}:${proxyPort} connect timeout`),
      );
    }, 30000);

    pending.then(() => {
      const lines = [
        `CONNECT ${hostname}:${port} HTTP/1.1`,
        `Host: ${hostname}:${port}`,
      ];
      if (auth) lines.push(`Proxy-Authorization: ${auth}`);
      rawSocket.write(lines.join("\r\n") + "\r\n\r\n");

      let buffer = "";
      const onData = (chunk) => {
        buffer += chunk.toString("latin1");
        const sep = buffer.indexOf("\r\n\r\n");
        if (sep === -1) return;
        clearTimeout(connectTimer);
        rawSocket.off("data", onData);
        const status = parseInt(
          /^HTTP\/\d\.\d\s+(\d{3})/.exec(buffer.slice(0, sep))[1],
          10,
        );
        if (status === 200) {
          resolve(rawSocket);
        } else {
          reject(new Error(`Proxy CONNECT failed: ${buffer.slice(0, sep)}`));
          rawSocket.destroy();
        }
      };
      rawSocket.on("data", onData);
    });
  });
}

async function openSocket(hostname, port, useTls) {
  let socket;
  if (isProxiedHost(hostname)) {
    const proxy =
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy;
    socket = await connectThroughProxy(proxy, hostname, port);
  } else {
    socket = netConnect({ host: hostname, port });
    const connected = new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const connectTimer = setTimeout(() => {
      socket.destroy(new Error(`connect timeout to ${hostname}:${port}`));
    }, 30000);
    await connected;
    clearTimeout(connectTimer);
  }
  if (!useTls) return socket;

  const tlsSocket = tlsConnect({ socket, servername: hostname });
  const secured = new Promise((resolve, reject) => {
    tlsSocket.once("secureConnect", resolve);
    tlsSocket.once("error", reject);
  });
  const handshakeTimer = setTimeout(() => {
    tlsSocket.destroy(
      new Error(`TLS handshake timeout to ${hostname}:${port}`),
    );
  }, 30000);
  await secured;
  clearTimeout(handshakeTimer);
  return tlsSocket;
}

function dechunk(buf) {
  const parts = [];
  let off = 0;
  while (off < buf.length) {
    const lineEnd = buf.indexOf("\r\n", off);
    if (lineEnd === -1) break;
    const size = parseInt(
      buf.subarray(off, lineEnd).toString("utf8").trim().split(";")[0],
      16,
    );
    if (!size) break;
    parts.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
    off = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

function parseRawResponse(buf) {
  const headEnd = buf.indexOf("\r\n\r\n");
  const head = buf.subarray(0, headEnd).toString("latin1");
  const lines = head.split("\r\n");
  const status = parseInt(/^HTTP\/\d\.\d\s+(\d{3})/.exec(lines[0])[1], 10);
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(":");
    if (idx > 0)
      headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i]
        .slice(idx + 1)
        .trim();
  }
  let body = buf.subarray(headEnd + 4);
  if ((headers["transfer-encoding"] || "").toLowerCase().includes("chunked")) {
    body = dechunk(body);
  }
  return { status, headers, body };
}

async function requestRaw(
  targetUrl,
  method,
  requestHeaders,
  { maxRedirects = 5, retries = 3 } = {},
) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await requestOnce(targetUrl, method, requestHeaders, maxRedirects);
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const msg = String(err?.message || err?.code || "");
      console.log(
        `[sync] retrying request (${attempt + 1}/${retries}) after error: ${msg}`,
      );
      await sleep(attempt * 1000);
    }
  }
}

async function requestOnce(targetUrl, method, requestHeaders, maxRedirects) {
  let url = targetUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    const u = new URL(url);
    const useTls = u.protocol === "https:";
    const port = Number(u.port) || (useTls ? 443 : 80);
    const socket = await openSocket(u.hostname, port, useTls);

    const lines = [
      `${method} ${u.pathname + u.search} HTTP/1.1`,
      `Host: ${u.host}`,
      "Connection: close",
      ...Object.entries(requestHeaders).map(([k, v]) => `${k}: ${v}`),
    ];
    socket.write(lines.join("\r\n") + "\r\n\r\n");

    let buf = Buffer.alloc(0);
    await new Promise((resolve, reject) => {
      let ended = false;
      const readTimer = setTimeout(() => {
        socket.destroy(new Error("socket read timeout"));
      }, 180000);
      const cleanup = () => clearTimeout(readTimer);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
      });
      socket.once("end", () => {
        ended = true;
        cleanup();
        resolve();
      });
      socket.once("close", () => {
        cleanup();
        if (ended) return;
        reject(new Error("socket closed before the response completed"));
      });
      socket.once("error", (err) => {
        cleanup();
        reject(err);
      });
    });

    const response = parseRawResponse(buf);
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.location
    ) {
      url = new URL(response.headers.location, url).toString();
      continue;
    }
    const expected = Number(response.headers["content-length"]);
    if (expected && response.body.length < expected) {
      throw new Error(
        `incomplete response from ${url} (got ${response.body.length} of ${expected} bytes)`,
      );
    }
    return response;
  }
  throw new Error(`Too many redirects for ${targetUrl}`);
}

// The GitHub release API is rate-limited to 60 requests/hour per IP when
// unauthenticated; a token raises that to 5000. The token is taken from
// GITHUB_TOKEN / GH_TOKEN, else discovered from the local `gh` CLI.
let tokenCache;
function githubToken() {
  if (tokenCache !== undefined) return tokenCache;
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) {
    tokenCache = fromEnv;
    return tokenCache;
  }
  try {
    const out = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    tokenCache = out || null;
  } catch {
    tokenCache = null;
  }
  return tokenCache;
}

function githubAuthHeaders() {
  const token = githubToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchLatestVersion() {
  const { status, body } = await requestRaw(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    "GET",
    {
      "User-Agent": "mihomo-npm",
      Accept: "application/vnd.github+json",
      ...githubAuthHeaders(),
    },
  );
  if (status >= 400) {
    const reason =
      status === 403 || status === 429
        ? `${status} (GitHub API rate limit; set GITHUB_TOKEN/GH_TOKEN or run \`gh auth login\`)`
        : String(status);
    throw new Error(`HTTP ${reason} while fetching latest release`);
  }
  return String(JSON.parse(body.toString("utf8")).tag_name).replace(/^v/, "");
}

async function isPublished(pkgName, version) {
  const { status } = await requestRaw(
    `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/${version}`,
    "GET",
    { "User-Agent": "mihomo-npm" },
  );
  return status >= 200 && status < 300;
}

async function fetchAsset(version, assetName) {
  if (process.env.MIHOMO_ASSET_DIR) {
    const localPath = path.join(process.env.MIHOMO_ASSET_DIR, assetName);
    if (existsSync(localPath)) {
      return readFileSync(localPath);
    }
    throw new Error(`Asset not found in MIHOMO_ASSET_DIR: ${localPath}`);
  }
  const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${assetName}`;
  const { status, body } = await requestRaw(url, "GET", {
    "User-Agent": "mihomo-npm",
  });
  if (status >= 400) {
    throw new Error(`HTTP ${status} while downloading ${assetName}`);
  }
  return body;
}

function findEOCD(buf) {
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (u32(buf, i) === SIG_EOCD) return i;
  }
  throw new Error("zip: end of central directory not found");
}

function listCentralEntries(buf, eocdOff) {
  const total = u16(buf, eocdOff + 10);
  const cdStart = u32(buf, eocdOff + 16);
  const entries = [];
  let off = cdStart;
  for (let n = 0; n < total; n++) {
    if (u32(buf, off) !== SIG_CENTRAL) {
      throw new Error("zip: invalid central directory entry");
    }
    const method = u16(buf, off + 10);
    const compSize = u32(buf, off + 20);
    const nameLen = u16(buf, off + 28);
    const extraLen = u16(buf, off + 30);
    const commentLen = u16(buf, off + 32);
    const localOffset = u32(buf, off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entry) {
  const off = entry.localOffset;
  if (u32(buf, off) !== SIG_LOCAL) {
    throw new Error("zip: invalid local file header");
  }
  const nameLen = u16(buf, off + 26);
  const extraLen = u16(buf, off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const packed = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 8) return inflateRawSync(packed);
  if (entry.method === 0) return Buffer.from(packed);
  throw new Error(`zip: unsupported compression method ${entry.method}`);
}

function extractFromZip(buf) {
  const eocd = findEOCD(buf);
  const entries = listCentralEntries(buf, eocd);
  const target =
    entries.find(
      (e) =>
        path.posix.basename(e.name).startsWith("mihomo") &&
        e.name.toLowerCase().endsWith(".exe"),
    ) ||
    entries.find((e) => e.name.toLowerCase().endsWith(".exe")) ||
    entries[0];
  if (!target) {
    throw new Error("zip: mihomo binary not found in archive");
  }
  return readZipEntry(buf, target);
}

function isExecutable(buf) {
  if (buf.length < 4) return false;
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46)
    return true;
  if (buf[0] === 0x4d && buf[1] === 0x5a) return true;
  const magicLE = buf.readUInt32LE(0);
  const magicBE = buf.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcafebabf].includes(magicLE))
    return true;
  if ([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcafebabf].includes(magicBE))
    return true;
  return false;
}

function decompress(raw, assetName) {
  if (assetName.endsWith(".zip")) return extractFromZip(raw);
  return gunzipSync(raw);
}

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function copy(from, to, mode) {
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
  if (mode !== undefined) chmodSync(to, mode);
}

// One platform package: the raw binary, an index.js that exports its path, and
// the manifest npm matches against the install environment.
async function buildPlatform(id, meta, version, out) {
  const asset = meta.asset.replace("{VERSION}", version);
  const binary = meta.os === "win32" ? "mihomo.exe" : "mihomo";
  const dir = path.join(out, SCOPE, `mihomo-${id}`);

  console.log(`[sync] downloading ${asset}`);
  const payload = decompress(await fetchAsset(version, asset), asset);
  if (!isExecutable(payload)) {
    throw new Error(`extracted file is not a valid executable: ${asset}`);
  }

  writeJson(path.join(dir, "package.json"), {
    name: `${SCOPE}/mihomo-${id}`,
    version,
    description: `mihomo (Clash Meta) core binary for ${id}`,
    license: LICENSE,
    homepage: HOMEPAGE,
    repository: REPOSITORY,
    os: [meta.os],
    cpu: [meta.cpu],
    main: "index.js",
    files: ["bin", "index.js"],
  });

  writeFileSync(
    path.join(dir, "index.js"),
    "'use strict';\n\n// The path of this platform's mihomo binary.\n" +
      `module.exports = require('node:path').join(__dirname, 'bin', '${binary}');\n`,
  );

  writeFileSync(
    path.join(dir, "README.md"),
    `# ${SCOPE}/mihomo-${id}\n\n` +
      `Contains the [mihomo](https://github.com/MetaCubeX/mihomo) core binary for \`${id}\`.\n\n` +
      "Installed automatically as an optional dependency of `@pkgship/mihomo`. Do not install directly.\n",
  );

  // Downloaded assets do not carry the executable bit, and npm publishes
  // exactly the modes it finds on disk.
  const file = path.join(dir, "bin", binary);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, payload);
  chmodSync(file, 0o755);

  console.log(
    `[sync] wrote ${SCOPE}/mihomo-${id} (${(payload.length / 1024 / 1024).toFixed(1)} MiB)`,
  );
  return dir;
}

async function buildPlatformWithRetry(id, meta, version, out) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await buildPlatform(id, meta, version, out);
    } catch (err) {
      if (attempt >= 3 || !isRetryable(err)) throw err;
      const msg = String(err?.message || err?.code || "");
      console.log(
        `[sync] retrying ${id} (${attempt + 1}/3) after error: ${msg}`,
      );
      await sleep(attempt * 1000);
    }
  }
}

async function main() {
  const version = options.version ?? (await fetchLatestVersion());
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`unexpected version string: ${version}`);
  }

  const out = path.resolve(options.out);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  console.log(`[sync] mihomo version: ${version}`);

  const entries = [];
  for (const [id, meta] of Object.entries(platforms)) {
    const name = `${SCOPE}/mihomo-${id}`;
    if (await isPublished(name, version)) {
      console.log(`[sync] ${name}@${version} already published - skipping`);
      continue;
    }
    entries.push([name, await buildPlatformWithRetry(id, meta, version, out)]);
  }

  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  const expected = Object.keys(platforms)
    .map((id) => `${SCOPE}/mihomo-${id}`)
    .sort();
  const declared = Object.keys(manifest.optionalDependencies || {}).sort();
  if (expected.join() !== declared.join()) {
    throw new Error(
      "package.json optionalDependencies no longer match lib/platforms.js",
    );
  }

  if (await isPublished(manifest.name, version)) {
    console.log(
      `[sync] ${manifest.name}@${version} already published - skipping`,
    );
  } else {
    manifest.version = version;
    for (const name of Object.keys(manifest.optionalDependencies)) {
      manifest.optionalDependencies[name] = version;
    }

    const root = path.join(out, SCOPE, "mihomo");
    for (const file of SHIPPED) {
      copy(path.join(ROOT, file), path.join(root, file));
    }
    copy(path.join(ROOT, "README.md"), path.join(root, "README.md"));
    writeJson(path.join(root, "package.json"), manifest);
    entries.push([manifest.name, root]);
  }

  // Written even when there is nothing to publish, so the workflow can read it
  // unconditionally.
  writeFileSync(
    path.join(out, ".packages"),
    entries.length
      ? `${entries
          .map(([name, dir]) =>
            [
              path.relative(out, dir).split(path.sep).join("/"),
              name,
              version,
            ].join("\t"),
          )
          .join("\n")}\n`
      : "",
  );

  console.log(
    entries.length
      ? `[sync] mihomo ${version}: prepared ${entries.length} packages in ${path.relative(process.cwd(), out)}`
      : `[sync] mihomo ${version} is already on the registry - nothing to do`,
  );
}

main().catch((err) => {
  console.error(`[sync] failed: ${err.message}`);
  process.exit(1);
});
