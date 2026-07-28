import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_OWNER = 'guitarrapc';
export const DEFAULT_REPO = 'ol';

export function mapPlatform(platform) {
    switch (platform) {
        case 'linux':
            return 'linux';
        case 'darwin':
            return 'osx';
        case 'win32':
            return 'win';
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }
}

export function mapArch(arch) {
    switch (arch) {
        case 'x64':
            return 'amd64';
        case 'arm64':
            return 'arm64';
        default:
            throw new Error(`Unsupported architecture: ${arch}`);
    }
}

export function resolveVersionTag(inputVersion) {
    if (!inputVersion || inputVersion === 'latest') {
        return 'latest';
    }

    return inputVersion.startsWith('v') ? inputVersion : `v${inputVersion}`;
}

export function requestJson(url, token, owner, repo) {
    return new Promise((resolve, reject) => {
        const req = https.get(
            url,
            {
                headers: {
                    Accept: 'application/vnd.github+json',
                    'User-Agent': `${owner}-${repo}-setup-action`,
                    ...(token ? { Authorization: `Bearer ${token}` } : {})
                }
            },
            (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(data));
                        } catch (error) {
                            reject(new Error(`Failed to parse JSON from ${url}: ${error.message}`));
                        }
                        return;
                    }

                    reject(new Error(`GitHub API request failed (${res.statusCode}): ${data}`));
                });
            }
        );

        req.on('error', (error) => {
            reject(new Error(`GitHub API request failed: ${error.message}`));
        });
    });
}

export async function getRelease(versionTag, token, owner, repo) {
    if (versionTag === 'latest') {
        return requestJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, token, owner, repo);
    }

    return requestJson(
        `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(versionTag)}`,
        token,
        owner,
        repo
    );
}

export function findAsset(release, name) {
    const asset = (release.assets || []).find((x) => x.name === name);
    if (!asset) {
        throw new Error(`Asset ${name} was not found in release ${release.tag_name}.`);
    }
    return asset;
}

export async function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
        stream.on('error', (error) => reject(error));
    });
}

export function parseExpectedSha(checksumContent, fileName) {
    const lines = checksumContent.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;

        const hash = parts[0].toLowerCase();
        const name = parts[parts.length - 1].replace(/^\*+/, '');
        if (name === fileName) {
            if (!/^[a-f0-9]{64}$/.test(hash)) {
                throw new Error(`Invalid checksum format for ${fileName}.`);
            }
            return hash;
        }
    }

    throw new Error(`Checksum for ${fileName} was not found in checksums-sha256.txt.`);
}

export async function downloadAsset(asset, token, tc) {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    return tc.downloadTool(asset.browser_download_url, undefined, { headers });
}

export async function extractArchive(archivePath, archiveName, tc) {
    if (archiveName.endsWith('.zip')) {
        return tc.extractZip(archivePath);
    }
    if (archiveName.endsWith('.tar.gz')) {
        return tc.extractTar(archivePath);
    }
    throw new Error(`Unsupported archive format: ${archiveName}`);
}

export async function runSetupOl(deps) {
    const {
        core,
        tc,
        owner = DEFAULT_OWNER,
        repo = DEFAULT_REPO,
        platform = process.platform,
        arch = process.arch,
        fileExists = fs.existsSync,
        getReleaseFn = getRelease,
        readFileFn = fsp.readFile,
        sha256FileFn = sha256File,
        chmodFn = fsp.chmod
    } = deps;

    const requestedVersion = core.getInput('ol-version') || 'latest';
    const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
    const mappedPlatform = mapPlatform(platform);
    const mappedArch = mapArch(arch);
    const extension = platform === 'win32' ? 'zip' : 'tar.gz';
    const archiveName = `ol-${mappedPlatform}-${mappedArch}.${extension}`;

    core.info(`Resolving release: ${requestedVersion}`);
    const release = await getReleaseFn(resolveVersionTag(requestedVersion), token, owner, repo);

    const archiveAsset = findAsset(release, archiveName);
    const checksumAsset = findAsset(release, 'checksums-sha256.txt');

    core.info(`Downloading ${archiveAsset.name}`);
    const archivePath = await downloadAsset(archiveAsset, token, tc);
    const checksumsPath = await downloadAsset(checksumAsset, token, tc);

    const checksumsText = await readFileFn(checksumsPath, 'utf8');
    const expectedSha = parseExpectedSha(checksumsText, archiveAsset.name);
    const actualSha = await sha256FileFn(archivePath);
    if (expectedSha !== actualSha) {
        throw new Error(
            `Checksum mismatch for ${archiveAsset.name}. expected=${expectedSha} actual=${actualSha}`
        );
    }

    core.info('Checksum verified');
    core.info('Extracting archive');
    const extractedDir = await extractArchive(archivePath, archiveAsset.name, tc);

    const binaryName = platform === 'win32' ? 'ol.exe' : 'ol';
    const binaryPath = path.join(extractedDir, binaryName);
    if (!fileExists(binaryPath)) {
        throw new Error(`Extracted binary ${binaryName} not found at ${binaryPath}.`);
    }

    if (platform !== 'win32') {
        await chmodFn(binaryPath, 0o755);
    }

    const normalizedVersion = release.tag_name.startsWith('v') ? release.tag_name.slice(1) : release.tag_name;

    core.addPath(extractedDir);
    core.setOutput('ol-version', normalizedVersion);
    core.setOutput('ol-path', extractedDir);
    core.info(`Installed ol ${release.tag_name}`);

    return {
        releaseTag: release.tag_name,
        extractedDir,
        version: normalizedVersion
    };
}
