import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';

const bundle = (input, file) => ({
    input,
    output: {
        file,
        format: 'es',
        sourcemap: false
    },
    plugins: [
        nodeResolve({ preferBuiltins: true }),
        commonjs(),
        json()
    ]
});

export default [
    bundle('index.js', 'dist/index.js'),
    bundle('check/index.js', 'dist/check.js')
];
