import type { CommonMetadata, ConversationConfig, EmbeddingResult, EmbeddingsConfig } from '../types/ChatEngine.js';
import type { ResponseInputItem, ResponseOutputItem, Tool } from 'openai/resources/responses/responses';
import { assertGuardEquals, type tags } from 'typia';
import { ChatEnginePlugin } from './Plugin.js';
import type { CommonCallbackProps } from '../types/Plugin.js';
import type { EmbeddingCreateParams } from 'openai/resources';
import { OpenAI } from 'openai';
import { createHash } from 'node:crypto';
import { getBearerTokenProvider } from '@azure/identity';
import { isTokenCredential } from '@azure/core-auth';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';

/** LLM interaction engine. Supports chat, embeddings, and plugin management. */
export class ChatEngine {
    /** List of plugins that are registered with the chat engine. */
    #plugins: Record<string & tags.Format<'uuid'>, ChatEnginePlugin<unknown>>;
    /** Instance of the configured OpenAI client used for processing chat messages and LLM operations. */
    #conversationClient: OpenAI;
    /** Instance of the configured OpenAI client used for generating embeddings. */
    #embeddingsClient: OpenAI | undefined;
    /** Configuration options for the conversation instance. */
    #conversationConfig: Omit<ConversationConfig, 'authentication'>;
    /** Configuration options for the embeddings instance. */
    #embeddingsConfig: Omit<EmbeddingsConfig, 'authentication'> | undefined;
    /** In-memory vector database for storing embeddings and making them available to all plugins. */
    #vectorDb: EmbeddingResult[];

    // #region Initialization

    /**
     * Initializes a new instance of the ChatEngine class with the provided configuration options for the conversation and embeddings instances.
     * @param chatConfig Configuration options for initializing the conversation instance.
     * @param embeddingConfig Optional configuration options for initializing the embeddings instance. If not provided, the embeddings client will not be initialized.
     */
    constructor(chatConfig: ConversationConfig, embeddingConfig?: EmbeddingsConfig) {
        // Ensure that the provided token is an API key or a TokenCredential instance. If not, throw an error.
        if (typeof chatConfig.authentication !== 'string' && !isTokenCredential(chatConfig.authentication)) { throw new TypeError('The provided authentication is not a valid API key or TokenCredential instance!', { 'cause': 'Input Validation!' }); }

        /** Capture the chat auth reference before it is removed from the config. */
        const chatAuth = typeof chatConfig.authentication === 'string'
            ? chatConfig.authentication
            : getBearerTokenProvider(chatConfig.authentication, chatConfig.authScope ?? 'https://ai.azure.com/.default');

        // Remove the authentication property from the configuration object to prevent it from being stored in the instance and for validation compatibility.
        delete (chatConfig as Partial<ConversationConfig>).authentication;

        // Ensure there isn't anything tricky in the provided config.
        assertGuardEquals<Omit<ConversationConfig, 'authentication'>>(chatConfig);

        // Store the provided configuration options for the conversation and embeddings instances.
        this.#conversationConfig = chatConfig;

        // Create an instance of the OpenAI client to be used for processing chat messages.
        this.#conversationClient = new OpenAI({
            'apiKey': chatAuth,
            'baseURL': this.#conversationConfig.host
        });

        // Initialize the in-memory vector database for storing embeddings. If not provided, initialize as a blank DB.
        this.#vectorDb = [];

        // Only initialize the embeddings client if the configuration options are provided.
        if (embeddingConfig) {
            // Ensure that the provided token is an API key or a TokenCredential instance. If not, throw an error.
            if (typeof embeddingConfig.authentication !== 'string' && !isTokenCredential(embeddingConfig.authentication)) { throw new TypeError('The provided authentication is not a valid API key or TokenCredential instance!', { 'cause': 'Input Validation!' }); }

            /** Capture the embeddings auth reference before it is removed from the config. */
            const embeddingsAuth = typeof embeddingConfig.authentication === 'string'
                ? embeddingConfig.authentication
                : getBearerTokenProvider(embeddingConfig.authentication, embeddingConfig.authScope ?? 'https://ai.azure.com/.default');

            // Remove the authentication property from the configuration object to prevent it from being stored in the instance and for validation compatibility.
            delete (embeddingConfig as Partial<EmbeddingsConfig>).authentication;

            // Ensure there isn't anything tricky in the provided config.
            assertGuardEquals<Omit<EmbeddingsConfig, 'authentication'>>(embeddingConfig);

            // Store the provided configuration options for the embeddings instance.
            this.#embeddingsConfig = embeddingConfig;

            // Create an instance of the OpenAI client to be used for generating embeddings.
            this.#embeddingsClient = new OpenAI({
                'apiKey': embeddingsAuth,
                'baseURL': embeddingConfig.host
            });
        }

        // Initialize the plugins list
        this.#plugins = {};
    }

    // #endregion Initialization

    // #region Business Logic

    public async invokeRegisteredPlugin(
        pluginId: string,
        uniqueProps: Record<string, unknown>,
        commonMetadata: CommonMetadata
    ): Promise<string> {
        assertGuardEquals(commonMetadata);

        /**
         * Defines plugin.
         * Keeps the plugin used to register or invoke functionality.
         */
        const plugin = this.#plugins[pluginId];

        // Check !plugin before choosing which behavior to run.
        if (!plugin) {
            throw new TypeError(
                'The requested plugin is not registered with the chat engine.'
            );
        }

        // Check plugin.requiredPermissionList.length !== 0 && !plugin.requiredPermissionList.every( (permission) =>  before choosing which behavior to run.
        if (
            plugin.requiredPermissionList.length !== 0 &&
            !plugin.requiredPermissionList.every(
                (permission) =>
                    commonMetadata.permissionList.includes(
                        permission
                    )
            )
        ) {
            throw new TypeError(
                'The caller does not have permission to invoke this plugin.'
            );
        }

        /**
         * Defines common props.
         * Stores common props for use in the surrounding operation.
         */
        const commonProps: CommonCallbackProps = {
            ...commonMetadata,
            'chatEngine': this,
            'vectorDb': this.#vectorDb
        };

        return plugin.callback(
            commonProps,
            uniqueProps
        );
    }

    /**
     * Registers the provided plugin within the Chat Engine.
     * @param plugin Plugin that is to be registered with the Chat Engine.
     * @throws {TypeError} If the provided plugin is not an instance of ChatEnginePlugin or if a plugin with the same ID is already registered.
     */
    public registerPlugin<T>(plugin: ChatEnginePlugin<T>): void {
        // #region Input Validation
        if (!(plugin instanceof ChatEnginePlugin)) { throw new TypeError('The provided plugin is not a Chat Engine Plugin!', { 'cause': 'Input Validation!' }); }

        if (plugin.id in this.#plugins) { throw new TypeError('A plugin with the same ID is already registered!', { 'cause': 'Input Validation!' }); }
        // #endregion Input Validation

        // Add the plugin to the list of registered plugins
        this.#plugins[plugin.id] = plugin as ChatEnginePlugin<unknown>;
    }

    /**
     * Processes a chat message by sending it to the conversation client.
     *
     * The `userId` parameter is hashed using SHA256 to create a unique identifier for the user that doesn't include PII directly without hash cracking.
     * This hashed identifier is then sent to the LLM host for safety and moderation purposes, ensuring that the harness provider can attribute any issues to the end user rather than the provider itself.
     * A non-hashed version of this is passed to all tool calls as a standardized parameter.
     * @param userMessage The message from the user to be processed.
     * @param commonMetadata Common metadata that is shared across all plugins, including the user ID, tenant ID, and permission list.
     * @param messageHistory Optional history of previous messages in the conversation. If not provided, only the current user message will be processed.
     * @throws {TypeError} If the user message, permission list, or message history is not valid.
     * @returns A promise that resolves to an array of ResponseInputItem objects representing the conversation history and any output from the model.
     */
    public async invokeLanguageModel(userMessage: string, commonMetadata: CommonMetadata, messageHistory?: ResponseInputItem[]): Promise<ResponseInputItem[]> {
        // #region Input Validation
        assertGuardEquals(userMessage);

        assertGuardEquals(commonMetadata);

        assertGuardEquals(messageHistory);
        // #endregion Input Validation

        /** Conversation history for the current chat message. */
        let conversationHistory: ResponseInputItem[] = [
            {
                'content': userMessage,
                'role': 'user'
            }
        ];

        // If message history is provided and is not empty, prepend it to the conversation history.
        if (messageHistory && messageHistory.length !== 0) { conversationHistory.unshift(...messageHistory); }

        // Check if a system prompt is configured and inject it into the conversation history if so.
        if (this.#conversationConfig.systemPrompt) {
            // Inject the system prompt at the beginning
            conversationHistory.unshift({
                'content': this.#conversationConfig.systemPrompt,
                'role': 'developer'
            });
        }

        /** List of tools that the currently authenticated user is allowed to use. */
        const toolList = this.#selectPlugin(commonMetadata.permissionList);

        /** Hashed User ID to be provided to the LLM host for ensuring that the harness provider doesn't get banned and they can place the blame on their end user instead. */
        const safetyId = createHash('sha256')
            .update(commonMetadata.userId)
            .digest('hex');

        /** Results of processing the chat message. */
        const processingResult = await this.#conversationClient.responses.create({
            'input': conversationHistory,
            'model': this.#conversationConfig.model,
            'safety_identifier': safetyId,
            'tools': toolList
        });

        // Add the output text from the processing result to the conversation history
        conversationHistory.push(...toResponseInputItems(processingResult.output));

        // Check if function calls are requested, if so, run the plugin processor
        if (processingResult.output.some((message) => message.type === 'function_call')) {
            // Run the plugin processor to handle any function calls requested by the model, passing in the conversation history, the output from the model, the user ID, and the safety ID.
            await this.#invokePlugin(conversationHistory, processingResult.output, commonMetadata, safetyId, toolList);
        }

        // Remove any system prompts from the history to ensure that they do not leak to the end user
        conversationHistory = conversationHistory.filter((message) => {
            // Check if the role is present, if so, filter out any messages with the role of 'developer' (system prompt).
            if ('role' in message && message.role === 'developer') { return false; }

            // The message is allowed to remain in the conversation history if it is not a system prompt.
            return true;
        });

        // Return the results of processing the chat message, including the conversation history and any output from the model.
        return conversationHistory;
    }

    /**
     * Generates embeddings for the provided content using the initialized embeddings client.
     *
     * This method will throw an error if the embeddings client is not initialized, which occurs when the embeddings configuration is not provided during ChatEngine initialization.
     * @throws {TypeError} If the embeddings client is not initialized.
     * @param content The content for which embeddings are to be generated.
     * @param dimensionCount Number of dimensions for the embeddings. If not provided, the default dimension count for the model will be used. THIS IS ONLY supported on models that support it. If not supported, this config will be ignored by the model and the model's default will be used.
     * @returns A promise that resolves to an array of embeddings.
     */
    public async newContentVectorList(content: string, dimensionCount?: number): Promise<EmbeddingResult> {
        // #region Input Validation
        assertGuardEquals(content);

        assertGuardEquals(dimensionCount);

        // Ensure that the embeddings client is initialized before attempting to generate embeddings.
        if (!this.#embeddingsClient || !this.#embeddingsConfig) { throw new TypeError('Embeddings client is not initialized. Please provide embeddings configuration during ChatEngine initialization.', { 'cause': 'Embeddings Client Not Initialized!' }); }
        // #endregion Input Validation

        /** Embedding request for the provided content. */
        const embeddingRequest: EmbeddingCreateParams = {
            'encoding_format': 'float',
            'input': content,
            'model': this.#embeddingsConfig.model
        };

        // If a dimension count is provided, add it to the embedding request.
        if (dimensionCount) { embeddingRequest.dimensions = dimensionCount; }

        /** List of vectors for the provided content. */
        const vectorList = await this.#embeddingsClient.embeddings.create(embeddingRequest);

        // Ensure the embeddings were generated successfully. If not, throw an error.
        if (vectorList.data.length === 0) { throw new TypeError('No embeddings were generated for the provided content!', { 'cause': 'Operation Failed!' }); }

        /** Embedding result for the provided content. */
        const embedding: EmbeddingResult = {
            'embedding': vectorList.data[0]!.embedding,
            'input': content
        };

        // Return the embedding generated by the model along with the associated content.
        return embedding;
    }

    /**
     * Overwrites the in-memory vector database with the provided new vector database.
     * Serializes and de-serializes the provided vector database to ensure that it is a deep copy and that no references to the original object are retained.
     * @throws {TypeError} If the provided vector database is not valid.
     * @param vectorDb The new vector database to be set as the in-memory vector database.
     */
    public setVectorDb(vectorDb: EmbeddingResult[] & tags.MinItems<1>): void {
        // #region Input Validation
        assertGuardEquals(vectorDb);

        /**
         * Count of dimension in the Vector DB, used to ensure that all entries have the same count.
         * If the count differs, cosine similarity can't operate.
         */
        const dimensionCount = vectorDb[0]!.embedding.length;

        // Iterate through each vector in the provided vector database and ensure that the dimension count matches the first vector.
        for (const vector of vectorDb) {
            // Iterate through each vector and ensure that the dimension count matches the first vector.
            if (vector.embedding.length !== dimensionCount) { throw new RangeError('Inconsistent embedding dimensions in the provided vector database!', { 'cause': 'Input Validation!' }); }
        }

        // #endregion Input Validation

        // Set the provided vector DB to be the in-memory vector database for storing embeddings and making them available to all plugins.
        this.#vectorDb = JSON.parse(JSON.stringify(vectorDb)) as EmbeddingResult[];
    }

    // #endregion Business Logic

    // #region Helper Functions

    /**
     * Checks the user's current set of permissions (scopes) to see which plugins are allowed to be run for the current user.
     *
     * How the RBAC filter works:
     * - If the plugin has an empty list: that means no permissions are required. It will be included in the list of available tools.
     * - If the plugin has a list of required permissions, and the user has some of those permissions, then the plugin will not be in the list of allowed plugins.
     * - If the plugin has a list of required permissions, and the user has all of the permissions, then the plugin will be in the list of allowed plugins.
     * @param userPermissionList List of permissions that the current user has. This will be used to filter the list of plugins that are allowed to be run for the current user.
     * @returns List of plugins that are allowed to be run for the user's current permission list.
     */
    #selectPlugin(userPermissionList: string[]): Tool[] {
        // #region Input Validation
        assertGuardEquals(userPermissionList);
        // #endregion Input Validation

        /** List of plugins that are allowed for the current permission list. */
        const pluginList: Tool[] = [];

        // Iterate through each plugin and check if the permissions are met for the current user.
        for (const pluginId in this.#plugins) {
            // Skip the current item if it is not a direct property of the plugins object (i.e., if it is inherited from the prototype chain).
            // eslint-disable-next-line no-continue
            if (!Object.hasOwn(this.#plugins, pluginId)) { continue; }

            /** Plugin to evaluate permissions on. */
            const currentPlugin = this.#plugins[pluginId];

            // Ensure that the plugin is actually present before operating on it.
            if (currentPlugin) {
                // If no permissions are defined, add the plugin to the list of allowed plugins.
                if (currentPlugin.requiredPermissionList.length === 0) {
                    // Add the current plugin to the list of allowed plugins since no permissions are required.
                    pluginList.push(currentPlugin.configuration);
                } else if (currentPlugin.requiredPermissionList.every((permission) => userPermissionList.includes(permission))) {
                    // If the user has all of the required permissions for the current plugin, add it to the list of allowed plugins.
                    pluginList.push(currentPlugin.configuration);
                }
            }
        }

        // Return the computed plugin list to the caller
        return pluginList;
    }

    /**
     * Processes the tool calls requested by the model by executing the registered plugins and updating the conversation history accordingly.
     *
     * This method is called recursively to handle any additional tool calls requested by the model after executing the initial set of tool calls.
     * The recursion depth is tracked to ensure that it does not exceed the maximum recursion depth configured for the conversation.
     * @param conversationHistory Reference to the conversation history that is being built up as the model processes the chat message and any tool calls. This will be mutated in place by reference.
     * @param toolRequest Current set of tool calls requested by the model to be processed.
     * @param commonMetadata Common metadata that is shared across all plugins, including the user ID, tenant ID, and permission list.
     * @param safetyId Safety identifier for the current conversation context.
     * @param toolList List of tools that the currently authenticated user is allowed to use.
     * @param recursionCount Current recursion depth for the plugin execution.
     */
    async #invokePlugin(conversationHistory: ResponseInputItem[], toolRequest: ResponseOutputItem[], commonMetadata: CommonMetadata, safetyId: string, toolList: Tool[], recursionCount?: number & tags.Minimum<0>): Promise<void> {
        // #region Input Validation
        assertGuardEquals(conversationHistory);

        assertGuardEquals(toolRequest);

        assertGuardEquals(commonMetadata);

        assertGuardEquals(safetyId);

        assertGuardEquals(toolList);

        assertGuardEquals(recursionCount);
        // #endregion Input Validation

        /** Current iteration depth for the chat message processing. */
        const computedRecursionCount = recursionCount ?? 0;

        /** Set of metadata properties to be passed to all plugin callbacks to ensure they have the full execution context. */
        const computedCallbackCommonProps: CommonCallbackProps = {
            ...commonMetadata,
            'chatEngine': this,
            'vectorDb': this.#vectorDb
        };

        // Iterate over each result and run any tool calls that are requested
        for (const message of toolRequest) {
            // Check if a tool call is requested and if so, run the plugin associated with the tool call
            if (message.type === 'function_call') {
                // Check if the plugin is registered with the chat engine and if so, run the plugin's callback function with the provided arguments.
                if (message.name in this.#plugins) {
                    /** String results of the plugin execution. If rich content is needed, serialized JSON will be returned. */
                    const executionResults = await this.#plugins[message.name]!.callback(computedCallbackCommonProps, JSON.parse(message.arguments));

                    /** Plugin execution results in the conversation history format. */
                    const toolCallResponse: ResponseInputItem.FunctionCallOutput = {
                        'call_id': message.call_id,
                        'output': executionResults,
                        'type': 'function_call_output'
                    };

                    // Add the output from the plugin execution to the conversation history
                    conversationHistory.push(toolCallResponse);
                } else { // If not, return an error message indicating that the plugin is not registered.
                    /** Plugin execution results in the conversation history format. */
                    const toolCallResponse: ResponseInputItem.FunctionCallOutput = {
                        'call_id': message.call_id,
                        'output': 'The requested plugin is not registered with the chat engine. Please ensure that the plugin is registered before attempting to use it.',
                        'type': 'function_call_output'
                    };

                    // Add the output from the plugin execution to the conversation history
                    conversationHistory.push(toolCallResponse);
                }
            }
        }

        /** Results of processing the chat message. */
        const processingResult = await this.#conversationClient.responses.create({
            'input': conversationHistory,
            'instructions': 'Respond only with data generated by a tool call. More tool calls are allowed if further tool calls are requested. If no further tool calls are requested, respond with the final output to the user.',
            'model': this.#conversationConfig.model,
            'safety_identifier': safetyId,
            'tools': toolList
        });

        // Add the output text from the processing result to the conversation history
        conversationHistory.push(...toResponseInputItems(processingResult.output));

        // Check if more tool calls are requested, if so, run the plugin processor again
        if (processingResult.output.some((message) => message.type === 'function_call')) {
            // Check if more tool calls are requested
            if (
                this.#conversationConfig.maxRecursionDepth &&
                computedRecursionCount > this.#conversationConfig.maxRecursionDepth
            ) {
                // Don't recurse any further if the recursion count exceeds the maximum recursion depth configured for the conversation.

                /** Results of processing the chat message. */
                const finalProcessingResult = await this.#conversationClient.responses.create({
                    'input': conversationHistory,
                    'instructions': 'The maximum recursion depth has been reached for tool calling. No further tool calls will be made.',
                    'model': this.#conversationConfig.model,
                    'safety_identifier': safetyId
                });

                // Add the output text from the processing result to the conversation history
                conversationHistory.push(...toResponseInputItems(finalProcessingResult.output));
            } else {
                // Process the next layer of tool calls if more are requested and the maximum recursion depth has not been reached.
                await this.#invokePlugin(conversationHistory, processingResult.output, computedCallbackCommonProps, safetyId, toolList, computedRecursionCount + 1);
            }
        }
    }
    // #endregion Helper Functions
}
