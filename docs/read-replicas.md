# PostgreSQL Read Replicas

Diaspora users (UK, US) see lower read latency when reads are served from a
replica in their region.

## Provisioning

1. Create a read replica of the primary in `eu-west-1` (and `us-east-1` if needed)
   using your provider's replica feature (RDS / Neon / Supabase read replicas).
2. In each regional deployment set `DATABASE_REPLICA_URL` to the replica nearest
   that region. `DATABASE_URL` always points at the primary.

## Routing

- `readQuery()` in `src/lib/db.ts` serves read-only queries (circle list, open
  circles on the dashboard) from the replica.
- `query()` / `transaction()` always use the primary — use them for all writes.

## Lag monitoring and fallback

Replication lag is checked at most every 10 s via `getReplicaLagSeconds()`. If lag
exceeds `DB_REPLICA_MAX_LAG_S` (default `5`), the check fails, or a replica query
errors, reads fall back to the primary and a warning is logged.
