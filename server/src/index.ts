import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./db";

const config = loadConfig();
const db = createDb(config);
const app = buildApp({ db, config });

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    app.log.info(`DroneTuner server listening on http://${config.host}:${config.port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
