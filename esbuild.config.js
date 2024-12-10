const esbuild = require('esbuild');

const commonConfig = {
    bundle: true,
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    // minify: true, makes messy debug/error output
    treeShaking: true,
    legalComments: 'none',
    mainFields: ['module', 'main'],
    metafile: true,
    format: 'cjs'
};

esbuild.build({
    ...commonConfig,
    entryPoints: ['src/index.ts', 'src/wsConnectionManager.ts'],
    outdir: 'dist',
}).catch(() => process.exit(1));