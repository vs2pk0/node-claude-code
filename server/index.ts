import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createApiRouter } from './api.js';
import { createProxyRouter } from './proxy.js';
import { storage } from './storage.js';

const isProduction = process.env.NODE_ENV === 'production';
const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const projectRoot = isProduction ? process.cwd() : path.resolve(currentDir, '..');
const frontendDist = path.join(projectRoot, 'dist');
const uiBasePath = '/ui';

async function main() {
    const app = express();
    const config = storage.getConfig();
    const host = process.env.HOST || config.HOST || '127.0.0.1';
    const port = Number(process.env.PORT || config.PORT || 4568);

    app.disable('x-powered-by');
    app.use(cors());
    app.use(express.json({ limit: '25mb' }));

    app.use('/api', createApiRouter());
    app.use('/v1', createProxyRouter());
    app.get('/', (_req, res) => {
        res.redirect(uiBasePath);
    });

    if (isProduction) {
        app.use(uiBasePath, express.static(frontendDist));
        app.get(/^\/ui(?:\/.*)?$/, (_req, res) => {
            res.sendFile(path.join(frontendDist, 'index.html'));
        });
    } else {
        const vite = await createViteServer({
            root: projectRoot,
            server: {
                middlewareMode: true,
                hmr: false
            },
            appType: 'spa'
        });

        app.use(uiBasePath, vite.middlewares);
    }

    app.listen(port, host, () => {
        const origin = `http://${host}:${port}`;
        const state = fs.existsSync(frontendDist) || !isProduction ? 'ready' : 'frontend-not-built';
        console.log(`[router] ${state} ${origin}${uiBasePath}`);
        console.log(`[router] settings ${storage.settingsPath}`);
        console.log(`[router] database ${storage.databasePath}`);
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
