import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
const config = loadConfig();
const { app } = await createApp(config);
await app.listen({ port: config.PORT, host: "0.0.0.0" });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
