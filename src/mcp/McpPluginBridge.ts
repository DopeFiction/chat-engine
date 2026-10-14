import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import type { ChatEngine } from '../core/ChatEngine.js';
import type { ChatEnginePlugin } from '../core/Plugin.js';
import type { CommonMetadata } from '../types/ChatEngine.js';

/** Lorem Ipsum. */
export type McpPluginArgs = Record<string, unknown>;

/** Lorem Ipsum. */
export interface McpPluginBridgeConfig {
    /** Lorem Ipsum. */
    'commonMetadata': CommonMetadata;
    /** Lorem Ipsum. */
    'serverName'?: string;
    /** Lorem Ipsum. */
    'serverVersion'?: string;
    /** Lorem Ipsum. */
    'toolNameByPluginId'?: Record<string, string>;
}

/**
 * Determines if the plugin is allowed based on permission lists.
 * @param plugin - Provides the plugin used to register or invoke functionality.
 * @param permissionList - Provides permission list for use in the surrounding operation.
 * @returns The result of the operation, or a promise when the work is asynchronous.
 */
function isAllowed<TPluginArgs>(
    plugin: ChatEnginePlugin<TPluginArgs>,
    permissionList: string[]
): boolean {
    return (
        plugin.requiredPermissionList.length === 0 ||
        plugin.requiredPermissionList.every((permission) => permissionList.includes(permission))
    );
}

/**
 * Creates mpc plugin server.
 * @param chatEngine - Provides the chat engine instance used by this module.
 * @param plugins - Provides the plugins used to register or invoke functionality.
 * @param config - Provides the config that controls how this component operates.
 * @returns The result of the operation, or a promise when the work is asynchronous.
 */
export function createMcpPluginServer<TPluginArgs>(
    chatEngine: ChatEngine,
    plugins: ChatEnginePlugin<TPluginArgs>[],
    config: McpPluginBridgeConfig
): McpServer {
    /** Server instance*/
    const server = new McpServer({
        'name': config.serverName ?? 'chat-engine',
        'version': config.serverVersion ?? '1.0.0'
    });

    /* Iterate over the available items or values and perform the loop body for each iteration. */
    for (const plugin of plugins) {
        // Register only function-type plugins that the caller has permission to use.
        if (
            plugin.configuration.type === 'function' &&
            isAllowed(plugin, config.commonMetadata.permissionList)
        ) {
            /**
             * Defines tool name.
             * Keeps the tool name used to register or invoke functionality.
             */
            const toolName = config.toolNameByPluginId?.[plugin.id] ?? plugin.id;

            /** Stores parameters for use in the surrounding operation. */
            const parameters =
                plugin.configuration.parameters ?? {
                    'additionalProperties': false,
                    'properties': {},
                    'type': 'object'
                };

            /** Input schema for use in the surrounding operation. */
            const inputSchema = fromJsonSchema(parameters as Record<string, unknown>);

            server.registerTool(
                toolName,
                {

                    inputSchema
                },
                async (args) => {
                    /**
                     * Defines plugin args.
                     * Keeps the plugin args used to register or invoke functionality.
                     */
                    const pluginArgs =
                        args as McpPluginArgs;

                    /**
                     * Defines output.
                     * Stores output for use in the surrounding operation.
                     */
                    const output =
                        await chatEngine.invokeRegisteredPlugin(
                            plugin.id,
                            pluginArgs,
                            config.commonMetadata
                        );

                    return {
                        'content': [
                            {
                                'type': 'text' as const,
                                'text': output
                            }
                        ]
                    };
                }
            );
        }
    }

    return server;
}
