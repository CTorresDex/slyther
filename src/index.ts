import { CLI } from "./src/classes/CLI.class.ts";

CLI.run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
