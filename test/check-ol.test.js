import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    describeCheckExitCode,
    buildScanArgs,
    buildCheckArgs,
    buildCacheKeys,
    runProcess,
    runCheckOl
} from '../lib/check-ol.js';

function createCore(inputs) {
    const calls = { info: [], warning: [], outputs: {}, summary: [] };
    const core = {
        getInput(name, options) {
            const value = inputs[name] ?? '';
            if (options?.required && !value) {
                throw new Error(`Input required and not supplied: ${name}`);
            }
            return value;
        },
        getMultilineInput(name) {
            return (inputs[name] ?? '').split('\n').map((x) => x.trim()).filter((x) => x !== '');
        },
        getBooleanInput(name) {
            return (inputs[name] ?? 'true') === 'true';
        },
        info(message) {
            calls.info.push(message);
        },
        warning(message) {
            calls.warning.push(message);
        },
        setOutput(name, value) {
            calls.outputs[name] = value;
        },
        summary: {
            addRaw(text) {
                calls.summary.push(text);
                return this;
            },
            async write() { }
        }
    };
    return { core, calls };
}

function createCache({ available = true } = {}) {
    const calls = { order: [], restore: [], save: [] };
    const cache = {
        isFeatureAvailable() {
            return available;
        },
        async restoreCache(paths, primaryKey, restoreKeys) {
            calls.order.push('restore');
            calls.restore.push({ paths, primaryKey, restoreKeys });
            return undefined;
        },
        async saveCache(paths, key) {
            calls.order.push('save');
            calls.save.push({ paths, key });
            return 1;
        }
    };
    return { cache, calls };
}

// Records every ol invocation and answers with the exit code configured for its subcommand.
function createRunFn(exitCodes = {}, cacheCalls) {
    const calls = [];
    const runFn = async (file, args, options) => {
        calls.push({ file, args, options });
        cacheCalls?.order.push(args[0] === 'cache' ? 'unpack' : args[0]);
        const exitCode = exitCodes[args[0]] ?? 0;
        if (options.stdoutPath) {
            await fs.writeFile(options.stdoutPath, '{}');
        }
        return { exitCode, stdout: args[0] === 'check' ? '## ol license check' : '' };
    };
    return { runFn, calls };
}

async function createEnv() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-ol-check-'));
    const workspace = path.join(root, 'workspace');
    const runnerTemp = path.join(root, 'temp');
    await fs.mkdir(path.join(workspace, 'repo'), { recursive: true });
    return {
        root,
        workspace,
        env: {
            GITHUB_WORKSPACE: workspace,
            RUNNER_TEMP: runnerTemp,
            GITHUB_RUN_ID: '42',
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_JOB: 'license-check',
            GITHUB_STEP_SUMMARY: path.join(root, 'summary.md')
        },
        workDir: path.join(runnerTemp, 'ol-check')
    };
}

const installOl = async () => ({ extractedDir: '/opt/ol' });

test('describeCheckExitCode maps ol check exit codes', () => {
    assert.equal(describeCheckExitCode(0), 'passed');
    assert.equal(describeCheckExitCode(2), 'violations');
    assert.equal(describeCheckExitCode(3), 'inconclusive');
    assert.equal(describeCheckExitCode(1), 'failed');
    assert.equal(describeCheckExitCode(137), 'failed');
});

test('buildScanArgs repeats inputs and exclusions', () => {
    assert.deepEqual(
        buildScanArgs({ inputs: ['.', 'bom.cdx.json'], excludeInputPaths: ['tools/', 'docs'], cacheDir: '/c' }),
        ['scan', '--input', '.', '--input', 'bom.cdx.json', '--exclude-input-path', 'tools/', '--exclude-input-path', 'docs', '--cache-dir', '/c', '--format', 'json']
    );
});

test('buildCheckArgs adds optional dev licenses and baselines only when supplied', () => {
    assert.deepEqual(
        buildCheckArgs({ reportPath: 'r.json', allowLicenses: 'MIT', allowDevLicenses: '', baselines: [], sarifPath: 'o.sarif' }),
        ['check', '--report', 'r.json', '--allow-licenses', 'MIT', '--sarif', 'o.sarif', '--format', 'markdown']
    );
    assert.deepEqual(
        buildCheckArgs({ reportPath: 'r.json', allowLicenses: 'MIT', allowDevLicenses: 'GPL-3.0-only', baselines: ['a.json', 'b.json'], sarifPath: 'o.sarif' }),
        ['check', '--report', 'r.json', '--allow-licenses', 'MIT', '--allow-dev-licenses', 'GPL-3.0-only', '--baseline', 'a.json', '--baseline', 'b.json', '--sarif', 'o.sarif', '--format', 'markdown']
    );
});

test('buildCacheKeys makes a per-run key restorable by platform prefix', () => {
    const keys = buildCacheKeys({ GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'license-check' }, 'linux');
    assert.equal(keys.primaryKey, 'ol-evidence-linux-42-2-license-check');
    assert.deepEqual(keys.restoreKeys, ['ol-evidence-linux-']);
    assert.ok(keys.primaryKey.startsWith(keys.restoreKeys[0]));
});

test('runCheckOl scans and checks in the working directory and writes outputs', async () => {
    const { workspace, env, workDir } = await createEnv();
    const { core, calls: coreCalls } = createCore({
        'allow-licenses': 'MIT,Apache-2.0',
        'allow-dev-licenses': 'GPL-3.0-only',
        input: '.',
        'exclude-input-paths': 'tools/\n',
        baselines: 'ol-baseline.json\n\n../shared/ol-baseline.json',
        'working-directory': 'repo',
        'github-token': 'token-value'
    });
    const { cache, calls: cacheCalls } = createCache();
    const { runFn, calls } = createRunFn({}, cacheCalls);

    const result = await runCheckOl({ core, cache, installOl, runFn, env, platform: 'linux' });

    assert.equal(result.result, 'passed');
    assert.deepEqual(calls.map((x) => x.args[0]), ['scan', 'check']);
    assert.ok(calls.every((x) => x.file === path.join('/opt/ol', 'ol')));
    assert.ok(calls.every((x) => x.options.cwd === path.join(workspace, 'repo')));
    assert.ok(calls.every((x) => x.options.env.OL_GITHUB_TOKEN === 'token-value'));
    assert.deepEqual(calls[0].args, buildScanArgs({ inputs: ['.'], excludeInputPaths: ['tools/'], cacheDir: path.join(workDir, 'cache') }));
    assert.equal(calls[0].options.stdoutPath, path.join(workDir, 'ol-report.json'));
    assert.deepEqual(calls[1].args, buildCheckArgs({
        reportPath: path.join(workDir, 'ol-report.json'),
        allowLicenses: 'MIT,Apache-2.0',
        allowDevLicenses: 'GPL-3.0-only',
        baselines: ['ol-baseline.json', '../shared/ol-baseline.json'],
        sarifPath: path.join(workDir, 'ol.sarif')
    }));
    assert.deepEqual(cacheCalls.order, ['restore', 'scan', 'save', 'check']);
    assert.equal(cacheCalls.save[0].key, 'ol-evidence-linux-42-2-license-check');
    assert.deepEqual(coreCalls.summary, ['## ol license check']);
    assert.equal(coreCalls.outputs.result, 'passed');
    assert.equal(coreCalls.outputs['report-path'], path.join(workDir, 'ol-report.json'));
    assert.equal(coreCalls.outputs['sarif-path'], path.join(workDir, 'ol.sarif'));
    await fs.access(path.join(workDir, 'cache'));
});

test('runCheckOl skips a missing seed cache without failing', async () => {
    const { env } = await createEnv();
    const { core, calls: coreCalls } = createCore({ 'allow-licenses': 'MIT', 'seed-cache': 'missing.olcache' });
    const { cache } = createCache();
    const { runFn, calls } = createRunFn();

    await runCheckOl({ core, cache, installOl, runFn, env, platform: 'linux' });

    assert.deepEqual(calls.map((x) => x.args[0]), ['scan', 'check']);
    assert.ok(coreCalls.info.some((x) => x.includes('missing.olcache') && x.includes('skipping')));
    assert.deepEqual(coreCalls.warning, []);
});

test('runCheckOl unpacks an existing seed cache before restoring the Actions cache', async () => {
    const { workspace, env, workDir } = await createEnv();
    const seedPath = path.join(workspace, 'seed.olcache');
    await fs.writeFile(seedPath, 'seed');
    const { core } = createCore({ 'allow-licenses': 'MIT', 'seed-cache': 'seed.olcache' });
    const { cache, calls: cacheCalls } = createCache();
    const { runFn, calls } = createRunFn({}, cacheCalls);

    await runCheckOl({ core, cache, installOl, runFn, env, platform: 'linux' });

    assert.deepEqual(calls[0].args, ['cache', 'unpack', seedPath, '--cache-dir', path.join(workDir, 'cache')]);
    assert.deepEqual(cacheCalls.order, ['unpack', 'restore', 'scan', 'save', 'check']);
});

test('runCheckOl continues with a warning when the seed cache cannot be unpacked', async () => {
    const { workspace, env } = await createEnv();
    await fs.writeFile(path.join(workspace, 'seed.olcache'), 'corrupt');
    const { core, calls: coreCalls } = createCore({ 'allow-licenses': 'MIT', 'seed-cache': 'seed.olcache' });
    const { cache } = createCache();
    const { runFn, calls } = createRunFn({ cache: 1 });

    const result = await runCheckOl({ core, cache, installOl, runFn, env, platform: 'linux' });

    assert.equal(result.result, 'passed');
    assert.deepEqual(calls.map((x) => x.args[0]), ['cache', 'scan', 'check']);
    assert.equal(coreCalls.warning.length, 1);
});

test('runCheckOl leaves the Actions cache alone when disabled or unavailable', async () => {
    for (const { inputs, available, expectedInfo } of [
        { inputs: { 'allow-licenses': 'MIT', cache: 'false' }, available: true, expectedInfo: false },
        { inputs: { 'allow-licenses': 'MIT' }, available: false, expectedInfo: true }
    ]) {
        const { env } = await createEnv();
        const { core, calls: coreCalls } = createCore(inputs);
        const { cache, calls: cacheCalls } = createCache({ available });
        const { runFn } = createRunFn();

        await runCheckOl({ core, cache, installOl, runFn, env, platform: 'linux' });

        assert.deepEqual(cacheCalls.order, []);
        assert.equal(coreCalls.info.some((x) => x.includes('cache is not available')), expectedInfo);
    }
});

test('runCheckOl fails on policy violations after saving the evidence cache', async () => {
    const { env } = await createEnv();
    const { core, calls: coreCalls } = createCore({ 'allow-licenses': 'MIT' });
    const { cache, calls: cacheCalls } = createCache();
    const { runFn } = createRunFn({ check: 2 });

    await assert.rejects(runCheckOl({ core, cache, installOl, runFn, env, platform: 'linux' }), /policy violations/);

    assert.equal(cacheCalls.save.length, 1);
    assert.equal(coreCalls.outputs.result, 'violations');
    assert.deepEqual(coreCalls.summary, ['## ol license check']);
});

test('runCheckOl fails on inconclusive and failed checks', async () => {
    for (const [exitCode, result, message] of [[3, 'inconclusive', /inconclusive/], [1, 'failed', /exited with code 1/]]) {
        const { env } = await createEnv();
        const { core, calls: coreCalls } = createCore({ 'allow-licenses': 'MIT' });
        const { cache } = createCache();
        const { runFn } = createRunFn({ check: exitCode });

        await assert.rejects(runCheckOl({ core, cache, installOl, runFn, env, platform: 'linux' }), message);
        assert.equal(coreCalls.outputs.result, result);
    }
});

test('runCheckOl stops before check when scan fails but still saves the cache', async () => {
    const { env } = await createEnv();
    const { core, calls: coreCalls } = createCore({ 'allow-licenses': 'MIT' });
    const { cache, calls: cacheCalls } = createCache();
    const { runFn, calls } = createRunFn({ scan: 1 });

    await assert.rejects(runCheckOl({ core, cache, installOl, runFn, env, platform: 'linux' }), /ol scan exited with code 1/);

    assert.deepEqual(calls.map((x) => x.args[0]), ['scan']);
    assert.equal(cacheCalls.save.length, 1);
    assert.equal(coreCalls.outputs.result, 'failed');
});

test('runCheckOl requires allow-licenses before installing ol', async () => {
    const { env } = await createEnv();
    const { core } = createCore({});
    const { cache } = createCache();
    let installed = false;

    await assert.rejects(
        runCheckOl({ core, cache, installOl: async () => { installed = true; return { extractedDir: '/opt/ol' }; }, env, platform: 'linux' }),
        /allow-licenses/
    );
    assert.equal(installed, false);
});

test('runCheckOl uses ol.exe on Windows', async () => {
    const { env } = await createEnv();
    const { core } = createCore({ 'allow-licenses': 'MIT' });
    const { cache } = createCache();
    const { runFn, calls } = createRunFn();

    await runCheckOl({ core, cache, installOl, runFn, env, platform: 'win32' });

    assert.ok(calls.every((x) => x.file === path.join('/opt/ol', 'ol.exe')));
});

test('runProcess writes stdout to a file or captures it, and returns the exit code', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-ol-process-'));
    const outPath = path.join(dir, 'out.txt');
    const options = { cwd: dir, env: process.env };

    const toFile = await runProcess(process.execPath, ['-e', 'process.stdout.write("report")'], { ...options, stdoutPath: outPath });
    assert.equal(toFile.exitCode, 0);
    assert.equal(await fs.readFile(outPath, 'utf8'), 'report');

    const captured = await runProcess(process.execPath, ['-e', 'process.stdout.write("markdown"); process.exit(2)'], options);
    assert.equal(captured.exitCode, 2);
    assert.equal(captured.stdout, 'markdown');

    await assert.rejects(runProcess(path.join(dir, 'missing-binary'), [], options));
});
