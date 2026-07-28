import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import * as io from '@actions/io';
import { runSetupOl } from './lib/setup-ol.js';

runSetupOl({ core, tc, io }).catch((error) => {
    core.setFailed(`Setup ol failed: ${error.message}`);
});
