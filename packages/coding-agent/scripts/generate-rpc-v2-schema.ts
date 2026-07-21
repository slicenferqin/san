import { RPC_V2_SCHEMA } from "../src/modes/rpc-v2/protocol/schema";

const outputPath = new URL("../src/modes/rpc-v2/rpc-v2.schema.json", import.meta.url);
await Bun.write(outputPath, `${JSON.stringify(RPC_V2_SCHEMA, null, 2)}\n`);
