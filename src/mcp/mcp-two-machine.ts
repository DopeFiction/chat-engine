import { ChatEngine } from '../core/ChatEngine.js';
import { pluginSearchRagCosineSimilarity } from '../core/plugins/rag.js';
import { serveChatEngineMcpHttp } from './index.js';

// Node.js loads the .env file from the current working directory at startup.
/**
 * Defines chat host.
 * Stores the configured chat host used to connect to the model or service.
 */
const chatHost = process.env['CHAT_BASE_URL'];

/**
 * Defines embeddings host.
 * Stores the configured embeddings host used to connect to the model or service.
 */
const embeddingsHost = process.env['EMBEDDINGS_BASE_URL'];

/**
 * Defines chat model.
 * Identifies the chat model to use for model requests.
 */
const chatModel = process.env['CHAT_MODEL'];

/**
 * Defines embedding model.
 * Identifies the embedding model to use for model requests.
 */
const embeddingModel = process.env['EMBEDDINGS_MODELS'];

/** The chat api key supplied to the API client for authentication. */
const chatApiKey = process.env['CHAT_API_KEY'] ?? 'none';

/** The embeddings api key supplied to the API client for authentication. */
const embeddingsApiKey = process.env['EMBEDDINGS_API_KEY'] ?? 'none';

/** Flag that indicates whether use mcp http is enabled or permitted. */
const useMcpHttp =
    process.argv.includes('--mcp-http');

/** Ensure that an Ollama/OpenAI-compatible host was configured before creating Chat Engine. */
if (!chatHost || !embeddingsHost) { throw new Error('CHAT_BASE_URL and EMBEDDINGS_BASE_URL are required'); }

/** Ensure that a chat model was configured before creating Chat Engine. */
if (!chatModel) { throw new Error('CHAT_MODEL is required'); }

/* Ensure that an embedding model was configured before creating Chat Engine. */
if (!embeddingModel) {
    throw new Error('EMBEDDINGS_MODEL is required');
}

/** Ensure that an API key placeholder was configured for the OpenAI-compatible client. */
if (!chatApiKey || !embeddingsApiKey) { throw new Error('CHAT_API_KEY and EMBEDDINGS_API_KEY are required'); }

/** Instance of the chat engine. */
const chatEngine = new ChatEngine(
    {
        'authentication': chatApiKey,
        'host': chatHost,
        'maxRecursionDepth': 5,
        'model': chatModel
    },
    {
        'authentication': embeddingsApiKey,
        'host': embeddingsHost,
        'model': embeddingModel
    }
);

chatEngine.registerPlugin(pluginSearchRagCosineSimilarity);

/** Documentation to be used in retrieval. */
const docs = ['the cake is a lie'];

/** Vector data used for embedding or similarity-search operations. */
const vectors = [];

/* Iterate over the available items or values and perform the loop body for each iteration. */
for (const doc of docs) {
    vectors.push(await chatEngine.newContentVectorList(doc));
}

// Store the vectors
chatEngine.setVectorDb(vectors);

/** The common mcp config that controls how this component operates. */
const commonMcpConfig = {
    'commonMetadata': {
        'permissionList': [],
        'tenantId': 'none',
        'userId': 'none'
    },
    'serverName': 'chat-engine',
    'serverVersion': '1.0.0'
};

if (useMcpHttp) {
    // Start the network Streamable HTTP MCP transport when the caller selects --mcp-http.
    serveChatEngineMcpHttp(
        chatEngine,
        [pluginSearchRagCosineSimilarity],
        {
            ...commonMcpConfig,
            'allowedHostnames': [
                'localhost',
                '127.0.0.1'
            ],
            'allowedOriginHostnames': [
                'localhost',
                '127.0.0.1'
            ],
            'host': '127.0.0.1',
            'path': '/mcp',
            'port': 3000
        }
    );
} else {
    console.error('MCP is disabled. --mcp-http to enable a transport.');
}
