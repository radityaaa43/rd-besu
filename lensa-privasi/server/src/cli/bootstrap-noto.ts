import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, writeState } from '../state.ts';

const BOND_DIR = fileURLToPath(new URL('../../../../noto+pente/bond/', import.meta.url));

// Fresh deployment by the project's own script: BI identities on node1, investor1..3 on node2..4.
// Cash/supply are raised from the script defaults so a DvP at PRICE_PER_UNIT (1e6 RD per unit) is payable.
export async function bootstrap(): Promise<void> {
  const dataDir = join(STATE_DIR, 'noto');
  execFileSync('npx', ['ts-node', 'src/index.ts', '--cache', dataDir,
    '--cash-per-investor', '10000000000000', '--supply', '1000000', '--units-per-investor', '1000'],
  { cwd: BOND_DIR, stdio: 'inherit' });
  writeState('noto', { dataDir });
  console.log(`state/noto.json ditulis: ${dataDir}`);
}
