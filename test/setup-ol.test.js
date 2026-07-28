import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
    mapPlatform,
    mapArch,
    resolveVersionTag,
    parseExpectedSha,
    sha256File,
    runSetupOl
} from '../lib/setup-ol.js';

test('mapPlatform maps supported values', () => {
    assert.equal(mapPlatform('linux'), 'linux');
    assert.equal(mapPlatform('darwin'), 'osx');
    assert.equal(mapPlatform('win32'), 'win');
});

test('mapPlatform rejects unsupported values', () => {
    assert.throws(() => mapPlatform('aix'), /Unsupported platform/);
});

test('mapArch maps supported values', () => {
    assert.equal(mapArch('x64'), 'amd64');
    assert.equal(mapArch('arm64'), 'arm64');
});

test('mapArch rejects unsupported values', () => {
    assert.throws(() => mapArch('x86'), /Unsupported architecture/);
});

test('resolveVersionTag normalizes versions', () => {
    assert.equal(resolveVersionTag('latest'), 'latest');
    assert.equal(resolveVersionTag('0.1.0'), 'v0.1.0');
    assert.equal(resolveVersionTag('v0.1.0'), 'v0.1.0');
});

test('parseExpectedSha parses checksum line with and without asterisk', () => {
    const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const content = [
        `${hash}  ol-linux-amd64.tar.gz`,
        `${hash} *ol-win-amd64.zip`
    ].join('\n');

    assert.equal(parseExpectedSha(content, 'ol-linux-amd64.tar.gz'), hash);
    assert.equal(parseExpectedSha(content, 'ol-win-amd64.zip'), hash);
});

test('parseExpectedSha rejects missing file', () => {
    const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const content = `${hash}  ol-linux-amd64.tar.gz`;
    assert.throws(() => parseExpectedSha(content, 'ol-osx-arm64.tar.gz'), /Checksum for/);
});

test('sha256File returns lower-case hash', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-ol-test-'));
    const filePath = path.join(tempDir, 'data.txt');
    await fs.writeFile(filePath, 'hello');

    const expected = crypto.createHash('sha256').update('hello').digest('hex').toLowerCase();
    const actual = await sha256File(filePath);
    assert.equal(actual, expected);
});

test('runSetupOl installs expected artifact on linux flow', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-ol-run-'));
    const archivePath = path.join(tempDir, 'archive.tar.gz');
    const checksumsPath = path.join(tempDir, 'checksums-sha256.txt');
    const extractedDir = path.join(tempDir, 'extract');

    await fs.writeFile(archivePath, 'fake archive body');
    const archiveHash = crypto.createHash('sha256').update('fake archive body').digest('hex').toLowerCase();
    await fs.writeFile(checksumsPath, `${archiveHash}  ol-linux-amd64.tar.gz\n`);

    const coreCalls = {
        info: [],
        outputs: {},
        paths: []
    };

    const core = {
        getInput(name) {
            if (name === 'ol-version') return '0.1.0';
            if (name === 'github-token') return '';
            return '';
        },
        info(message) {
            coreCalls.info.push(message);
        },
        addPath(p) {
            coreCalls.paths.push(p);
        },
        setOutput(name, value) {
            coreCalls.outputs[name] = value;
        }
    };

    let downloadCount = 0;
    const downloadOptions = [];
    const tc = {
        async downloadTool(_url, _dest, options) {
            downloadCount += 1;
            downloadOptions.push(options);
            return downloadCount === 1 ? archivePath : checksumsPath;
        },
        async extractTar() {
            return extractedDir;
        },
        async extractZip() {
            throw new Error('extractZip should not be called in linux flow');
        }
    };

    const chmodCalls = [];
    let releaseToken = '';
    const previousGithubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'env-token';

    let result;
    try {
        result = await runSetupOl({
            core,
            tc,
            getReleaseFn: async (_versionTag, token) => {
                releaseToken = token;
                return {
                    tag_name: 'v0.1.0',
                    assets: [
                        {
                            name: 'ol-linux-amd64.tar.gz',
                            browser_download_url: 'https://example.invalid/ol-linux-amd64.tar.gz'
                        },
                        {
                            name: 'checksums-sha256.txt',
                            browser_download_url: 'https://example.invalid/checksums-sha256.txt'
                        }
                    ]
                };
            },
            owner: 'fake-owner',
            repo: 'fake-repo',
            platform: 'linux',
            arch: 'x64',
            chmodFn(filePath, mode) {
                chmodCalls.push({ filePath, mode });
                return Promise.resolve();
            },
            fileExists(filePath) {
                return filePath === path.join(extractedDir, 'ol');
            }
        });
    } finally {
        if (previousGithubToken === undefined) {
            delete process.env.GITHUB_TOKEN;
        } else {
            process.env.GITHUB_TOKEN = previousGithubToken;
        }
    }

    assert.equal(result.releaseTag, 'v0.1.0');
    assert.equal(result.version, '0.1.0');
    assert.equal(coreCalls.outputs['ol-version'], '0.1.0');
    assert.equal(coreCalls.outputs['ol-path'], extractedDir);
    assert.deepEqual(coreCalls.paths, [extractedDir]);
    assert.deepEqual(chmodCalls, [{ filePath: path.join(extractedDir, 'ol'), mode: 0o755 }]);
    assert.equal(releaseToken, 'env-token');
    assert.equal(downloadOptions.length, 2);
    assert.ok(downloadOptions.every((options) => options.headers.Authorization.endsWith('env-token')));
    assert.ok(coreCalls.info.includes('Checksum verified'));
    assert.ok(coreCalls.info.includes('Installed ol v0.1.0'));
});

test('runSetupOl fails when checksum mismatches', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-ol-badhash-'));
    const archivePath = path.join(tempDir, 'archive.tar.gz');
    const checksumsPath = path.join(tempDir, 'checksums-sha256.txt');

    await fs.writeFile(archivePath, 'fake archive body');
    const wrongHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    await fs.writeFile(checksumsPath, `${wrongHash}  ol-linux-amd64.tar.gz\n`);

    const core = {
        getInput(name) {
            if (name === 'ol-version') return '0.1.0';
            return '';
        },
        info() { },
        addPath() { },
        setOutput() { }
    };

    let downloadCount = 0;
    const tc = {
        async downloadTool() {
            downloadCount += 1;
            return downloadCount === 1 ? archivePath : checksumsPath;
        },
        async extractTar() {
            throw new Error('extractTar should not be called when checksum mismatches');
        },
        async extractZip() {
            throw new Error('extractZip should not be called');
        }
    };

    await assert.rejects(
        runSetupOl({
            core,
            tc,
            getReleaseFn: async () => ({
                tag_name: 'v0.1.0',
                assets: [
                    {
                        name: 'ol-linux-amd64.tar.gz',
                        browser_download_url: 'https://example.invalid/ol-linux-amd64.tar.gz'
                    },
                    {
                        name: 'checksums-sha256.txt',
                        browser_download_url: 'https://example.invalid/checksums-sha256.txt'
                    }
                ]
            }),
            platform: 'linux',
            arch: 'x64',
            fileExists() {
                return true;
            }
        }),
        /Checksum mismatch/
    );
});
