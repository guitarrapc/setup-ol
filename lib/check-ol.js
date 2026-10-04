import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const CACHE_KEY_PREFIX = 'ol-evidence';

// ol check exit codes: 0 passed, 2 policy violations, 3 inconclusive; anything else is a command failure.
export function describeCheckExitCode(exitCode) {
    switch (exitCode) {
        case 0:
            return 'passed';
        case 2:
            return 'violations';
        case 3:
            return 'inconclusive';
        default:
            return 'failed';
    }
}

export function buildScanArgs({ inputs, excludeInputPaths, cacheDir }) {
    const args = ['scan'];
    for (const input of inputs) {
        args.push('--input', input);
    }
    for (const excluded of excludeInputPaths) {
        args.push('--exclude-input-path', excluded);
    }
    args.push('--cache-dir', cacheDir, '--format', 'json');
    return args;
}

export function buildCheckArgs({ reportPath, allowLicenses, allowDevLicenses, baselines, sarifPath }) {
    const args = ['check', '--report', reportPath, '--allow-licenses', allowLicenses];
    if (allowDevLicenses) {
        args.push('--allow-dev-licenses', allowDevLicenses);
    }
    for (const baseline of baselines) {
        args.push('--baseline', baseline);
    }
    args.push('--sarif', sarifPath, '--format', 'markdown');
    return args;
}

// The key is unique per run so every run saves the evidence it collected; restores take the newest entry by prefix.
export function buildCacheKeys(env, platform) {
    const restorePrefix = `${CACHE_KEY_PREFIX}-${platform}-`;
    const runId = env.GITHUB_RUN_ID || 'local';
    const runAttempt = env.GITHUB_RUN_ATTEMPT || '1';
    const job = env.GITHUB_JOB || 'job';
    return {
        primaryKey: `${restorePrefix}${runId}-${runAttempt}-${job}`,
        restoreKeys: [restorePrefix]
    };
}

// Runs one process. stdout goes to stdoutPath when given, otherwise it is captured; stderr streams to the log.
export function runProcess(file, args, { cwd, env, stdoutPath }) {
    return new Promise((resolve, reject) => {
        let stdoutFd;
        try {
            stdoutFd = stdoutPath ? fs.openSync(stdoutPath, 'w') : undefined;
        } catch (error) {
            reject(error);
            return;
        }

        const child = spawn(file, args, {
            cwd,
            env,
            stdio: ['ignore', stdoutFd ?? 'pipe', 'inherit']
        });

        let stdout = '';
        if (!stdoutPath) {
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
                stdout += chunk;
            });
        }

        const closeFd = () => {
            if (stdoutFd !== undefined) {
                fs.closeSync(stdoutFd);
                stdoutFd = undefined;
            }
        };
        child.on('error', (error) => {
            closeFd();
            reject(error);
        });
        child.on('close', (exitCode) => {
            closeFd();
            resolve({ exitCode: exitCode ?? 1, stdout });
        });
    });
}

async function restoreEvidenceCache(core, cache, cacheDir, keys) {
    try {
        const restoredKey = await cache.restoreCache([cacheDir], keys.primaryKey, keys.restoreKeys);
        core.info(restoredKey ? `Restored ol evidence cache from ${restoredKey}.` : 'No ol evidence cache found.');
    } catch (error) {
        core.warning(`Failed to restore ol evidence cache: ${error.message}`);
    }
}

async function saveEvidenceCache(core, cache, cacheDir, keys) {
    try {
        await cache.saveCache([cacheDir], keys.primaryKey);
        core.info(`Saved ol evidence cache as ${keys.primaryKey}.`);
    } catch (error) {
        core.warning(`Failed to save ol evidence cache: ${error.message}`);
    }
}

async function unpackSeedCache(core, olPath, seedPath, cacheDir, runFn, options) {
    // A seed only warms the cache; without one, scan collects evidence from the sources.
    if (!fs.existsSync(seedPath)) {
        core.info(`Seed cache ${seedPath} not found, skipping unpack.`);
        return;
    }
    core.info(`Unpacking seed cache ${seedPath}`);
    const { exitCode, stdout } = await runFn(olPath, ['cache', 'unpack', seedPath, '--cache-dir', cacheDir], options);
    if (stdout) {
        core.info(stdout.trim());
    }
    if (exitCode !== 0) {
        core.warning(`ol cache unpack exited with code ${exitCode}; scanning without the seed cache.`);
    }
}

export async function runCheckOl(deps) {
    const {
        core,
        cache,
        installOl,
        runFn = runProcess,
        env = process.env,
        platform = process.platform
    } = deps;

    const allowLicenses = core.getInput('allow-licenses', { required: true });
    const allowDevLicenses = core.getInput('allow-dev-licenses');
    const inputs = core.getMultilineInput('input');
    const excludeInputPaths = core.getMultilineInput('exclude-input-paths');
    const baselines = core.getMultilineInput('baselines');
    const seedCache = core.getInput('seed-cache');
    const useCache = core.getBooleanInput('cache');
    const token = core.getInput('github-token') || env.GITHUB_TOKEN || '';
    const workingDirectory = path.resolve(
        env.GITHUB_WORKSPACE || process.cwd(),
        core.getInput('working-directory') || '.'
    );

    const { extractedDir } = await installOl();
    const olPath = path.join(extractedDir, platform === 'win32' ? 'ol.exe' : 'ol');

    const workDir = path.join(env.RUNNER_TEMP || os.tmpdir(), 'ol-check');
    const cacheDir = path.join(workDir, 'cache');
    const reportPath = path.join(workDir, 'ol-report.json');
    const sarifPath = path.join(workDir, 'ol.sarif');
    await fsp.mkdir(cacheDir, { recursive: true });

    const processOptions = { cwd: workingDirectory, env: { ...env, OL_GITHUB_TOKEN: token } };

    if (seedCache) {
        await unpackSeedCache(core, olPath, path.resolve(workingDirectory, seedCache), cacheDir, runFn, processOptions);
    }

    const cacheKeys = buildCacheKeys(env, platform);
    const cacheEnabled = useCache && cache.isFeatureAvailable();
    if (cacheEnabled) {
        await restoreEvidenceCache(core, cache, cacheDir, cacheKeys);
    } else if (useCache) {
        core.info('GitHub Actions cache is not available, skipping the evidence cache.');
    }

    const scanArgs = buildScanArgs({ inputs: inputs.length > 0 ? inputs : ['.'], excludeInputPaths, cacheDir });
    core.info(`ol ${scanArgs.join(' ')}`);
    const scan = await runFn(olPath, scanArgs, { ...processOptions, stdoutPath: reportPath });

    // Evidence collected before a failure is still worth keeping for the next run.
    if (cacheEnabled) {
        await saveEvidenceCache(core, cache, cacheDir, cacheKeys);
    }

    core.setOutput('report-path', reportPath);
    if (scan.exitCode !== 0) {
        core.setOutput('result', 'failed');
        throw new Error(`ol scan exited with code ${scan.exitCode}.`);
    }

    const checkArgs = buildCheckArgs({ reportPath, allowLicenses, allowDevLicenses, baselines, sarifPath });
    core.info(`ol ${checkArgs.join(' ')}`);
    const check = await runFn(olPath, checkArgs, processOptions);
    const result = describeCheckExitCode(check.exitCode);

    core.info(check.stdout);
    if (check.stdout && env.GITHUB_STEP_SUMMARY) {
        await core.summary.addRaw(check.stdout).write();
    }

    core.setOutput('sarif-path', sarifPath);
    core.setOutput('result', result);
    switch (result) {
        case 'passed':
            return { result, reportPath, sarifPath };
        case 'violations':
            throw new Error('ol check found license policy violations.');
        case 'inconclusive':
            throw new Error('ol check was inconclusive: every finding is a collection failure or no dependencies were resolved.');
        default:
            throw new Error(`ol check exited with code ${check.exitCode}.`);
    }
}
