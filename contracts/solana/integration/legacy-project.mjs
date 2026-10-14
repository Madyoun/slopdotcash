// Writes a 265-byte Project account in the layout that existed before the
// identity authority rotation fields, for the validator to preload with
// `--account`. The migration test then grows it with `migrate_project`.
// Fixture keys only; nothing here has value outside the local validator.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey(
  JSON.parse(readFileSync("idl/slop_escrow.json")).address,
);
const LEGACY_PROJECT_SIZE = 265;
const digest = (value) => createHash("sha256").update(value).digest();
const owner = Keypair.generate(),
  identity = Keypair.generate(),
  fees = Keypair.generate(),
  mint = Keypair.generate().publicKey;
const projectDigest = digest("legacy-project"),
  networkDomain = digest("legacy-domain");
const [project, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from("project"), owner.publicKey.toBuffer(), projectDigest],
  PROGRAM_ID,
);
const data = Buffer.alloc(LEGACY_PROJECT_SIZE);
let offset = 0;
const put = (bytes) => {
  Buffer.from(bytes).copy(data, offset);
  offset += bytes.length;
};
put(Buffer.from("cda8bdcab5f78e13", "hex"));
put(owner.publicKey.toBuffer());
put(projectDigest);
put(networkDomain);
put(identity.publicKey.toBuffer());
put(fees.publicKey.toBuffer());
put(mint.toBuffer());
// reserved, deposited, paid, payout_fees, withdrawn_gross, withdrawal_fees
offset += 6 * 8;
put(Buffer.of(bump));
data.writeBigInt64LE(3600n, offset);
offset += 8;
// service_fees
offset += 8;
if (offset !== LEGACY_PROJECT_SIZE) throw new Error("Legacy layout size");
// Rent exemption for exactly the legacy size: (128 + size) * 3480 * 2.
const lamports = (128 + LEGACY_PROJECT_SIZE) * 3480 * 2;
writeFileSync(
  ".local/legacy-project-account.json",
  JSON.stringify({
    pubkey: project.toBase58(),
    account: {
      lamports,
      data: [data.toString("base64"), "base64"],
      owner: PROGRAM_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: LEGACY_PROJECT_SIZE,
    },
  }),
);
writeFileSync(
  ".local/legacy-project.json",
  JSON.stringify({
    owner: [...owner.secretKey],
    identityAuthority: identity.publicKey.toBase58(),
    feeRecipient: fees.publicKey.toBase58(),
    mint: mint.toBase58(),
    projectDigest: projectDigest.toString("hex"),
    networkDomain: networkDomain.toString("hex"),
    project: project.toBase58(),
  }),
);
process.stdout.write(`${project.toBase58()}\n`);
