[![build](https://github.com/guitarrapc/setup-ol/actions/workflows/build.yaml/badge.svg)](https://github.com/guitarrapc/setup-ol/actions/workflows/build.yaml) [![setup ol](https://github.com/guitarrapc/setup-ol/actions/workflows/setup-ol.yaml/badge.svg)](https://github.com/guitarrapc/setup-ol/actions/workflows/setup-ol.yaml) [![release](https://github.com/guitarrapc/setup-ol/actions/workflows/release.yaml/badge.svg)](https://github.com/guitarrapc/setup-ol/actions/workflows/release.yaml)

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

## Development

```bash
npm ci
npm test
npm run build
```

## License

setup-ol is distributed under the [MIT license](./LICENSE.md).
