import { createClient, createSentinel } from "redis";
import { serverConfig } from "@/server/config";

type RedisClient = ReturnType<typeof createClient> | ReturnType<typeof createSentinel>;

let client: RedisClient | null = null;

/** Parses `redis+sentinel://host1:26379,host2:26379/<master-name>`. */
export function parseSentinelUrl(url: string) {
  const match = /^redis\+sentinel:\/\/([^/]+)\/([^/?]+)/.exec(url);
  if (!match) throw new Error("Invalid REDIS_SENTINEL_URL");
  const sentinelRootNodes = match[1].split(",").map((node) => {
    const [host, port] = node.split(":");
    return { host, port: Number(port) || 26379 };
  });
  return { name: match[2], sentinelRootNodes };
}

export async function getRedis() {
  if (!client) {
    const { url, sentinelUrl } = serverConfig.redis;
    client = sentinelUrl ? createSentinel(parseSentinelUrl(sentinelUrl)) : createClient({ url });
    client.on("error", (err) => console.error("[Redis]", err));
    await client.connect();
  }
  return client;
}
