import {
  Mina,
  fetchAccount,
  PublicKey,
  Field,
  Cache,
  VerificationKey,
} from "o1js";
import { MyUpgradableContract } from "./contract.js";
import {
  VerificationKeyUpgradeAuthority,
  ValidatorsVoting,
} from "@minatokens/upgradable-v1";
import fs from "fs/promises";
const { TestPublicKey } = Mina;
type TestPublicKey = Mina.TestPublicKey;

async function main() {
  console.log("Upgrading MyContract to V2");
  console.time("Upgraded MyContract");
  const json = JSON.parse(
    await fs.readFile("../../data/contract.json", "utf-8")
  );
  const contractKey = PublicKey.fromBase58(json?.contract?.publicKey);
  const sender = TestPublicKey.fromBase58(process.env.PRIVATE_KEY!);
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
  console.log("sender", sender.toBase58());
  await fetchAccount({ publicKey: sender });
  console.log(
    "Sender's balance",
    Mina.getBalance(sender).toBigInt() / 1_000_000_000n
  );
  console.log("MyContract", contractKey.toBase58());
  const { verificationKey: verificationKeyV2 } = JSON.parse(
    await fs.readFile("../../data/vk-v2.json", "utf-8")
  );
  const vk: VerificationKey = {
    hash: Field.fromJSON(verificationKeyV2.hash),
    data: verificationKeyV2.data,
  };
  const cache = Cache.FileSystem("./cache");
  console.log("Compiling contracts");
  console.time("Compiled contracts");
  await ValidatorsVoting.compile({ cache });
  await VerificationKeyUpgradeAuthority.compile({ cache });
  await MyContract.compile({ cache });
  console.timeEnd("Compiled contracts");

  await fetchAccount({ publicKey: sender });
  await fetchAccount({ publicKey: contractKey });
  const upgradeAuthority = myContract.upgradeAuthority.get();
  console.log("UpgradeAuthority", upgradeAuthority.toBase58());
  await fetchAccount({ publicKey: upgradeAuthority });
  console.log("Creating and proving transaction...");
  const tx = await Mina.transaction(
    {
      sender,
      fee: 100_000_000,
      memo: `Upgrade MyContract to V2`,
    },
    async () => {
      await myContract.upgradeVerificationKey(vk);
    }
  );
  const txSent = await (await tx.prove()).sign([sender.key]).send();
  console.log("tx sent", {
    status: txSent.status,
    hash: txSent.hash,
    errors: txSent.errors,
  });
  console.timeEnd("Upgraded MyContract");
  console.log("Waiting for tx to be included in a block...");
  const txIncluded = await txSent.safeWait();
  console.log("tx status:", txIncluded.status);
  if (txIncluded.status !== "included") {
    throw new Error("tx not included in a block");
  }
}

main().catch((error) => {
  console.error("Sending tx failed:", error);
  process.exit(1);
});
