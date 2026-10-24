import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  preloadArgs,
  programId,
  projectData,
  sha256Seed,
} from "./legacy-project.mjs";

/**
 * A current-layout Project with an admitted month that is already 30 days past its window,
 * which no live validator can reach. test-e2e.sh preloads both so expire_month runs against
 * real bytes. The month owes 3 USDC of its 5 USDC total; the project owes 1 USDC more for
 * other months. Public seeds: test use only.
 */
export const expiredProject = Keypair.fromSeed(
  sha256Seed("slop-e2e-expired-project"),
).publicKey;
export const EXPIRED_PERIOD = 202001;
const month = PublicKey.findProgramAddressSync(
  [
    Buffer.from("month"),
    expiredProject.toBuffer(),
    Buffer.from(new Uint32Array([EXPIRED_PERIOD]).buffer),
  ],
  programId,
)[0];

function project() {
  const data = Buffer.concat([projectData(), Buffer.alloc(16)]);
  // Its own owner, so no owner listing of the legacy project includes it.
  Keypair.fromSeed(sha256Seed("slop-e2e-expired-owner"))
    .publicKey.toBuffer()
    .copy(data, 8);
  data.writeBigUInt64LE(4_000_000n, 200); // reserved
  data.writeBigUInt64LE(4_000_000n, 324); // monthly_outstanding
  return data;
}
function monthData() {
  const data = Buffer.alloc(109);
  Buffer.from("1170c1902bd6fc6b", "hex").copy(data, 0);
  expiredProject.toBuffer().copy(data, 8);
  data.writeUInt32LE(EXPIRED_PERIOD, 40);
  data.writeBigUInt64LE(2_000_000n, 76); // committed
  data.writeBigUInt64LE(5_000_000n, 84); // total
  data.writeBigInt64LE(1_580_774_400n, 100); // frozen_at, 4 February 2020
  return data;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(
    preloadArgs([
      ["expired-project", expiredProject, programId, project()],
      ["expired-month", month, programId, monthData()],
    ]).join(" "),
  );
}
