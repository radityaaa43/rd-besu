// Bridge to the shared validator: stealth-address/ts/instrument.ts is native-TypeScript ESM
// (import.meta, .ts imports), which the CommonJS ts-node setup here cannot load. Reads a record
// as JSON on stdin and prints {valid, errors, hash, args} from the stealth validateRecord /
// recordHash / registrationArgs, so there is exactly one validator and one hash rule.
import { validateRecord, recordHash, registrationArgs } from "../../stealth-address/ts/instrument.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const record = JSON.parse(input);
const { valid, errors } = validateRecord(record);
console.log(JSON.stringify({ valid, errors, hash: recordHash(record), args: valid ? registrationArgs(record) : undefined }));
