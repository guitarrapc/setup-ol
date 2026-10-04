[![build](https://github.com/guitarrapc/setup-ol/actions/workflows/build.yaml/badge.svg)](https://github.com/guitarrapc/setup-ol/actions/workflows/build.yaml) [![setup ol](https://github.com/guitarrapc/setup-ol/actions/workflows/setup-ol.yaml/badge.svg)](https://github.com/guitarrapc/setup-ol/actions/workflows/setup-ol.yaml) [![release](https://github.com/guitarrapc/setup-ol/actions/workflows/release.yaml/badge.svg)](https://github.com/guitarrapc/setup-ol/actions/workflows/release.yaml) [![check](https://github.com/guitarrapc/setup-ol/actions/workflows/check.yaml/badge.svg)](https://github.com/guitarrapc/setup-ol/actions/workflows/check.yaml)

# setup-ol

GitHub Action to install the [ol](https://github.com/guitarrapc/ol) CLI for scanning resolved dependency inputs and SBOMs for license evidence and policy checks.

## Usage

Install the latest ol release.

```yaml
steps:
  - uses: actions/checkout@v7
  - uses: guitarrapc/setup-ol@v1.0.0
  - run: ol --version
  - run: ol scan --input .
```

Install a specific version.

```yaml
steps:
  - uses: actions/checkout@v7
  - uses: guitarrapc/setup-ol@v1.0.0
    with:
      ol-version: 0.1.0
```

## Inputs

| Name | Description | Default |
| --- | --- | --- |
| `ol-version` | Version to install. `latest` by default. You can pass `0.1.0` or `v0.1.0`. | `latest` |
| `github-token` | Token used for GitHub Releases API requests. Falls back to `GITHUB_TOKEN` when omitted. | `${{ github.token }}` |

## Outputs

| Name | Description |
| --- | --- |
| `ol-version` | Installed version string without the `v` prefix. |
| `ol-path` | Directory path added to `PATH` that contains the ol binary. |

## Check licenses

`guitarrapc/setup-ol/check` installs ol, scans resolved dependency inputs, and checks them against an SPDX license allow-list. The `ol check` Markdown result is written to the job summary, and the step fails on policy violations or an inconclusive result.

ol reads resolved inputs such as `package-lock.json`, `obj/project.assets.json`, or an SBOM; it does not resolve manifests. Prepare them before this step, for example with `npm ci` or `dotnet restore`. See [Resolving package dependencies](https://github.com/guitarrapc/ol#resolving-package-dependencies).

```yaml
steps:
  - uses: actions/checkout@v7
  - run: dotnet restore
  - uses: guitarrapc/setup-ol/check@v1.1.0
    with:
      allow-licenses: Apache-2.0,BSD-2-Clause,BSD-3-Clause,ISC,MIT
```

Exclude paths, apply baselines, and warm the evidence cache from a committed seed archive.

```yaml
steps:
  - uses: guitarrapc/setup-ol/check@v1.1.0
    with:
      allow-licenses: Apache-2.0,BSD-2-Clause,BSD-3-Clause,ISC,MIT
      allow-dev-licenses: GPL-3.0-only
      exclude-input-paths: |
        tools/
        docs/
      baselines: ol-baseline.json
      seed-cache: ol-cache.olcache
```

### Evidence cache

ol caches evidence collected from package registries and source repositories. The action keeps that cache in two optional layers:

- `seed-cache`: an `.olcache` archive created by `ol cache pack` and committed to a repository. It is unpacked before scanning. A missing archive is skipped, so a repository can adopt the input before it has a seed.
- `cache`: the GitHub Actions cache. The evidence cache is restored before scanning and saved after scanning, even when the check fails. It is skipped when the cache service is unavailable.

### Check inputs

All paths are relative to `working-directory`.

| Name | Description | Default |
| --- | --- | --- |
| `allow-licenses` | Comma-separated SPDX License Identifiers allowed by the policy. Required. | |
| `allow-dev-licenses` | Comma-separated SPDX License Identifiers additionally allowed for proven development-only dependencies. | `""` |
| `input` | Newline-separated files or directories passed to `ol scan --input`. | `.` |
| `exclude-input-paths` | Newline-separated files or directories excluded from ol input discovery. | `""` |
| `baselines` | Newline-separated ol baseline files. Each file must exist. | `""` |
| `seed-cache` | Optional `.olcache` archive unpacked before scanning. A missing archive is skipped. | `""` |
| `cache` | Persist the ol evidence cache between workflow runs with the GitHub Actions cache. | `true` |
| `working-directory` | Directory ol runs in, relative to the workspace. | `.` |
| `ol-version` | Version to install. | `latest` |
| `github-token` | Token used for GitHub Releases API requests and ol evidence collection (`OL_GITHUB_TOKEN`). | `${{ github.token }}` |

### Check outputs

| Name | Description |
| --- | --- |
| `result` | `passed`, `violations`, `inconclusive`, or `failed`. |
| `report-path` | Path of the canonical JSON scan report. |
| `sarif-path` | Path of the SARIF file written by `ol check`. Upload it with `github/codeql-action/upload-sarif` to show violations in code scanning. |
| `ol-version` | Installed version string without the `v` prefix. |
| `ol-path` | Directory path added to `PATH` that contains the ol binary. |

## Development

```bash
npm ci
npm test
npm run build
```

## License

setup-ol is distributed under the [MIT license](./LICENSE.md).
