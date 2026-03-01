/**
 * Unified Chat Memory Module
 *
 * Provides shared context between Discord and Dashboard chat:
 * - Stores all chat messages in LanceDB
 * - Enables semantic search across all channels
 * - Maintains conversation continuity
 */

import * as memory from '../memory/memoryCore.js';

/**
 * Chat message source
 */
export type ChatSource = 'discord' | 'dashboard';

/**
 * Chat message role
 */
export type ChatRole = 'user' | 'agent';

/**
 * Chat message metadata
 */
export interface ChatMessageMetadata {
  source: ChatSource;
  channelId: string;
  role: ChatRole;
  username?: string;
  userId?: string;
  timestamp: number;
}

/**
 * Save chat message to memory
 *
 * @param source - Message source (discord or dashboard)
 * @param channelId - Channel/conversation identifier
 * @param role - Message role (user or agent)
 * @param content - Message content
 * @param options - Additional metadata
 * @returns Memory ID if saved, null if rejected by distillation
 */
export async function saveChatMessage(
  source: ChatSource,
  channelId: string,
  role: ChatRole,
  content: string,
  options?: {
    username?: string;
    userId?: string;
  }
): Promise<string | null> {
  const timestamp = Date.now();

  const metadata: ChatMessageMetadata = {
    source,
    channelId,
    role,
    username: options?.username,
    userId: options?.userId,
    timestamp,
  };

  // Format content with context
  const formattedContent = `[${source}/${channelId}] ${role === 'user' ? (options?.username || 'User') : 'OpenSwarm'}: ${content}`;

  try {
    const id = await memory.logWork(
      'chat',
      `${source} chat message`,
      formattedContent,
      undefined,
      channelId  // Use channelId as derivedFrom for filtering
    );

    console.log(`[ChatMemory] Saved ${source}/${channelId} ${role} message (${content.length} chars)`);
    return id;
  } catch (error) {
    console.error('[ChatMemory] Failed to save chat message:', error);
    return null;
  }
}

/**
 * Search chat history semantically
 *
 * @param query - Search query
 * @param options - Search options
 * @returns Relevant chat messages
 */
export async function searchChatHistory(
  query: string,
  options?: {
    channelId?: string;     // Filter by channel
    source?: ChatSource;    // Filter by source
    limit?: number;
    minSimilarity?: number;
  }
): Promise<memory.MemorySearchResult[]> {
  const searchOptions: memory.SearchOptions = {
    types: ['journal'],  // Chat messages are stored as journal type
    limit: options?.limit ?? 10,
    minSimilarity: options?.minSimilarity ?? 0.4,
    minTrust: 0.3,
  };

  const result = await memory.searchMemorySafe(query, searchOptions);

  if (!result.success) {
    console.error('[ChatMemory] Search failed:', result.error);
    return [];
  }

  let memories = result.memories;

  // Filter by channelId (stored in derivedFrom)
  if (options?.channelId) {
    memories = memories.filter(m => m.metadata.derivedFrom === options.channelId);
  }

  // Filter by source (extract from content)
  if (options?.source) {
    memories = memories.filter(m =>
      m.content.startsWith(`[${options.source}/`)
    );
  }

  console.log(`[ChatMemory] Found ${memories.length} relevant messages for query: "${query.slice(0, 30)}..."`);
  return memories;
}

/**
 * Get recent chat history for a channel
 *
 * @param channelId - Channel identifier
 * @param limit - Maximum number of messages
 * @returns Recent messages
 */
export async function getRecentChatHistory(
  channelId: string,
  limit: number = 20
): Promise<memory.MemorySearchResult[]> {
  // Use a broad query to get all messages for this channel
  const query = `chat conversation history ${channelId}`;

  const memories = await searchChatHistory(query, {
    channelId,
    limit: limit * 2,  // Fetch more to account for filtering
    minSimilarity: 0.1,  // Low similarity threshold
  });

  // Sort by timestamp (most recent first)
  return memories
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/**
 * Format memory context for prompts
 *
 * @param memories - Search results
 * @returns Formatted context string
 */
export function formatChatMemoryContext(memories: memory.MemorySearchResult[]): string {
  if (memories.length === 0) return '';

  const formatted = memories
    .map(m => {
      const date = new Date(m.createdAt).toLocaleString('ko-KR', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      // Extract the actual chat message (after the [source/channel] prefix)
      const match = m.content.match(/\[.*?\]\s*(.+)/);
      const message = match ? match[1] : m.content;
      return `[${date}] ${message}`;
    })
    .join('\n');

  return `## Relevant Chat History\n${formatted}`;
}
