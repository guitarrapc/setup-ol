import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import * as cache from '@actions/cache';
import { runSetupOl } from '../lib/setup-ol.js';
import { runCheckOl } from '../lib/check-ol.js';

runCheckOl({ core, cache, installOl: () => runSetupOl({ core, tc }) })
    .catch((error) => {
        core.setFailed(`ol check failed: ${error.message}`);
    })
    // Cache uploads can leave connections open that delay exit; see actions/setup-node#878.
    .finally(() => process.exit());
