export async function register() {
  // OpenTelemetry: exports to OTEL_EXPORTER_OTLP_ENDPOINT when configured (#479)
  const { registerOTel } = await import("@vercel/otel");
  registerOTel({ serviceName: process.env.OTEL_SERVICE_NAME ?? "ajosave" });

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");

    if (process.env.NODE_ENV === "production") {
      const runner: any = await import("node-pg-migrate");
      const path = await import("path");
      await (runner.default || runner)({
        databaseUrl: process.env.DATABASE_URL!,
        dir: path.join(process.cwd(), "migrations"),
        direction: "up",
        migrationsTable: "pgmigrations",
        log: (msg: any) => console.log("[migrate]", msg),
      });
    }

    // Skip background services during build
    if (process.env.NEXT_PHASE === "phase-production-build") {
      return;
    }

    // Initialize background services (Horizon stream, etc.)
    const { initializeServices } = await import("./src/server/startup");
    await initializeServices();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
