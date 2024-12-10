import { Mina, fetchAccount, Cache, AccountUpdate, PublicKey } from "o1js";
import { MyUpgradableContract } from "./contract.js";
import { VerificationKeyUpgradeAuthority } from "@minatokens/upgradable-v1";
import fs from "fs/promises";
import o1jsPackage from "../node_modules/o1js/package.json" with { type: "json" };
const { TestPublicKey } = Mina;
type TestPublicKey = Mina.TestPublicKey;

async function deploy() {
  console.time("deployed MyContract");
  console.log("Deploying MyContract...");
  const sender = TestPublicKey.fromBase58(process.env.PRIVATE_KEY!);
  const contractKey = TestPublicKey.random();
  const MyContract = MyUpgradableContract({
    upgradeContract: VerificationKeyUpgradeAuthority,
  });
  const myContract = new MyContract(contractKey);
  const networkInstance = Mina.Network({
    mina: ["https://api.minascan.io/node/devnet/v1/graphql"],
    archive: ["https://api.minascan.io/archive/devnet/v1/graphql"],
    networkId: "testnet",
  });
  Mina.setActiveInstance(networkInstance);

  await fetchAccount({ publicKey: sender });
  console.log("o1js version", o1jsPackage.version);
  console.log("sender", sender.toBase58());
  console.log(
    "Sender's balance",
    Mina.getBalance(sender).toBigInt() / 1_000_000_000n
  );
  console.log("MyContract", contractKey.toBase58());
  const { upgradeAuthority, nonce: lastNonce } = JSON.parse(
    await fs.readFile("../../data/upgrade-v1.json", "utf-8")
  );
  console.log("UpgradeAuthority", upgradeAuthority.publicKey);

  const cache = Cache.FileSystem("./cache");
  console.log("Compiling contract");
  console.time("Compiled contract");
  const vk = (await MyContract.compile({ cache })).verificationKey;
  console.timeEnd("Compiled contract");

  await fetchAccount({ publicKey: sender });
  let nonce = Number(Mina.getAccount(sender).nonce.toBigint());
  if (nonce === lastNonce) nonce++;

  const tx = await Mina.transaction(
    {
      sender,
      fee: 100_000_000,
      memo: `Deploy MyContract`,
      nonce,
    },
    async () => {
      AccountUpdate.fundNewAccount(sender, 1);
      await myContract.deploy({
        admin: sender,
        upgradeAuthority: PublicKey.fromBase58(upgradeAuthority.publicKey),
        uri: "Upgradeable Contract Example",
      });
    }
  );
  const txSent = await (await tx.prove())
    .sign([sender.key, contractKey.key])
    .send();
  console.log("deploy tx sent", {
    status: txSent.status,
    hash: txSent.hash,
    errors: txSent.errors,
  });
  await fs.writeFile(
    "../../data/contract.json",
    JSON.stringify(
      {
        o1js: o1jsPackage.version,
        contract: {
          publicKey: contractKey.toBase58(),
          privateKey: contractKey.key.toBase58(),
        },
        verificationKey: {
          hash: vk.hash.toJSON(),
          data: vk.data,
        },
        tx: {
          hash: txSent.hash,
          status: txSent.status,
          errors: txSent.errors,
        },
        nonce,
      },
      null,
      2
    )
  );
  console.timeEnd("deployed MyContract");
  console.log("Waiting for tx to be included in a block...");
  const txIncluded = await txSent.safeWait();
  console.log("tx status:", txIncluded.status);
  if (txIncluded.status !== "included") {
    throw new Error("tx not included in a block");
  }
}

deploy().catch((error) => {
  console.error("Deployment failed:", error);
  process.exit(1);
});
