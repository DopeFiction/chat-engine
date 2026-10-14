// #region Core Business Logic

// Export the ChatEngine class, which is the core of the project's logic.
export { ChatEngine } from './core/ChatEngine.js';

// Export the ChatEnginePlugin class to allow authors to write their own plugins.
export { ChatEnginePlugin } from './core/Plugin.js';

// #endregion Core Business Logic

// #region Plugins

// Export the Microsoft plugins that allow the LLM to find a tenant ID.
export { pluginFindTenantId } from './core/plugins/microsoftCloud.js';

// Export a plugin that can perform RAG searches using the cosine similarity algorithm.
export { pluginSearchRagCosineSimilarity } from './core/plugins/rag.js';

// Export a plugin that can retrieve the current date and time to provide up-to-date context to the LLM.
export { pluginGetDateTime } from './core/plugins/utility.js';

// #endregion Plugins

// #region Types
export type { CommonMetadata, ConversationConfig, EmbeddingResult, EmbeddingsConfig } from './types/ChatEngine.js';

export type { ChatEnginePluginConfig, CommonCallbackProps, PluginGroup } from './types/Plugin.js';

// #endregion Types
export { serveChatEngineMcpHttp, createMcpPluginServer } from './mcp/index.js';

export type { McpHttpConfig, McpPluginArgs, McpPluginBridgeConfig } from './mcp/index.js';
