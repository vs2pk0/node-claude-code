import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { createApiRouter } from './api.js';
import { createCodexBackendRouter } from './codex.js';
import { createProxyRouter } from './proxy.js';
import { storage } from './storage.js';

const isProduction = process.env.NODE_ENV === 'production';
const projectRoot = process.env.APP_ROOT || process.cwd();
const frontendDist = path.join(projectRoot, 'dist');
const uiBasePath = '/ui';

function shouldServeUi() {
    return storage.getConfig().UI.enableBrowserUiAccess !== false;
}

async function main() {
    const app = express();
    const config = storage.getConfig();
    const host = process.env.HOST || config.HOST || '127.0.0.1';
    const port = Number(process.env.PORT || config.PORT || 4568);

    app.disable('x-powered-by');
    app.use(cors());
    app.use(express.json({ limit: '25mb' }));

    app.use('/api', createApiRouter());
    app.use('/backend-api/codex', createCodexBackendRouter());
    app.use('/v1', createProxyRouter());
    app.get('/', (_req, res) => {
        if (shouldServeUi()) {
            res.redirect(uiBasePath);
            return;
        }

        res.json({
            ok: true,
            ui: null,
        });
    });

    if (isProduction) {
        app.use(uiBasePath, (req, res, next) => {
            if (!shouldServeUi()) {
                res.status(404).send('UI mapping is disabled');
                return;
            }

            express.static(frontendDist)(req, res, next);
        });
        app.get(/^\/ui(?:\/.*)?$/, (_req, res) => {
            if (!shouldServeUi()) {
                res.status(404).send('UI mapping is disabled');
                return;
            }

            res.sendFile(path.join(frontendDist, 'index.html'));
        });
    } else {
        const { createServer: createViteServer } = await import('vite');
        const vite = await createViteServer({
            root: projectRoot,
            server: {
                middlewareMode: true,
                hmr: false
            },
            appType: 'spa'
        });

        app.use(uiBasePath, (req, res, next) => {
            if (!shouldServeUi()) {
                res.status(404).send('UI mapping is disabled');
                return;
            }

            vite.middlewares(req, res, next);
        });
    }

    const server = app.listen(port, host, () => {
        const address = server.address();
        const resolvedPort = typeof address === 'object' && address ? address.port : port;
        const origin = `http://${host}:${resolvedPort}`;
        const uiEnabled = shouldServeUi();
        const state = !uiEnabled ? 'api-only' : fs.existsSync(frontendDist) || !isProduction ? 'ready' : 'frontend-not-built';
        const target = uiEnabled ? `${origin}${uiBasePath}` : origin;

        console.log(`[router] ${state} ${target}`);
        console.log(`[router] settings ${storage.settingsPath}`);
        console.log(`[router] database ${storage.databasePath}`);
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
