import { type McpPluginBridgeConfig, createMcpPluginServer } from './McpPluginBridge.js';
import type { ChatEngine } from '../core/ChatEngine.js';
import type { ChatEnginePlugin } from '../core/Plugin.js';
import type { Server } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

/** Lorem Ipsum */
export interface McpHttpConfig extends McpPluginBridgeConfig {
    /** Lorem Ipsum. */
    'host'?: string;
    /** Lorem Ipsum. */
    'port'?: number;
    /** Lorem Ipsum. */
    'path'?: string;
    /** Lorem Ipsum. */
    'allowedHostnames'?: string[];
    /** Lorem Ipsum. */
    'allowedOriginHostnames'?: string[];
    /** Lorem Ipsum. */
    'bearerToken'?: string;
}

/** Lorem Ipsum. */
export function serveChatEngineMcpHttp<TPluginArgs>(
    chatEngine: ChatEngine,
    plugins: ChatEnginePlugin<TPluginArgs>[],
    config: McpHttpConfig
): Server {
    /** Lorem Ipsum. */
    const host = config.host ?? '127.0.0.1';

    /** Lorem Ipsum. */
    const port = config.port ?? 3000;

    /** Lorem Ipsum. */
    const mcpPath = config.path ?? '/mcp';

    /** *Create a fresh MCP server. */
    const handler = createMcpHandler(() => createMcpPluginServer(chatEngine, plugins, config));

    /** Mcp server a[[;ocatopm]]. */
    const app = createMcpExpressApp({
        host,
        ...config.allowedHostnames
            ? { 'allowedHosts': config.allowedHostnames }
            : {},
        ...config.allowedOriginHostnames
            ? { 'allowedOrigins': config.allowedOriginHostnames }
            : {}
    });

    /** The web-standard MCP handler adapted to Node/Express. */
    const nodeHandler = toNodeHandler(handler);

    app.all(mcpPath, (request, response) => {
        // Preserve the previous optional bearer-token protection.
        if (config.bearerToken &&
            request.headers.authorization !== `Bearer ${ config.bearerToken }`) {
            response.setHeader('WWW-Authenticate', 'Bearer');

            response.status(401).send('Unauthorized');

            return;
        }

        /*
         * CreateMcpExpressApp already parsed JSON into request.body.
         * Supplying it prevents the Node adapter from re-reading the stream.
         */
        void nodeHandler(request, response, request.body).catch((error: unknown) => {
            console.error('MCP HTTP request failed:', error);

            if (!response.headersSent) {
                response.status(500).send('Internal Server Error');
            } else if (!response.writableEnded) {
                response.end();
            }
        });
    });

    /** Lorem Ipsum. */
    const server: Server = app.listen(port, host, () => {
        console.error(`Chat Engine MCP HTTP listening on http://${ host }:${ port }${ mcpPath }`);
    });

    server.on('close', () => {
        void handler.close();
    });

    return server;
}
