import { createClient } from "redis";

let client: ReturnType<typeof createClient> | null = null;
let isConnected = false;

/**
 * Get or create the Redis client.
 * Connects lazily on first call.
 */
export async function getRedisClient() {
  if (!client) {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    client = createClient({ url: redisUrl });

    client.on("error", (err) => {
      console.error("[redis] Client error:", err);
    });

    try {
      await client.connect();
      isConnected = true;
      console.info("[redis] Connected to Redis");
    } catch (err) {
      console.error("[redis] Failed to connect:", err);
      isConnected = false;
      throw err;
    }
  }

  return client;
}

/**
 * Check if Redis is currently connected and healthy.
 */
export function isRedisConnected(): boolean {
  return isConnected;
}

/**
 * Disconnect the Redis client (useful for cleanup).
 */
export async function disconnectRedis() {
  if (client) {
    await client.quit();
    client = null;
    isConnected = false;
    console.info("[redis] Disconnected");
  }
}
