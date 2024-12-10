import { Mina, fetchAccount, PublicKey, Field, Cache } from "o1js";
import { MyUpgradableContract } from "./contract.js";
import { VerificationKeyUpgradeAuthority } from "@minatokens/upgradable-v1";
import fs from "fs/promises";
const { TestPublicKey } = Mina;
type TestPublicKey = Mina.TestPublicKey;

async function main() {
  console.log("Sending tx with contract V1");
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
  const cache = Cache.FileSystem("./cache");
  console.log("Compiling contract");
  console.time("Compiled contract");
  const vk = (await MyContract.compile({ cache })).verificationKey;
  console.timeEnd("Compiled contract");
  const value = Math.floor(Math.random() * 10000);
  console.log("Setting value", value);

  await fetchAccount({ publicKey: sender });
  await fetchAccount({ publicKey: contractKey });
  const tx = await Mina.transaction(
    {
      sender,
      fee: 100_000_000,
      memo: `Set value ${value} (v1)`,
    },
    async () => {
      await myContract.setValue(Field(value));
    }
  );
  const txSent = await (await tx.prove()).sign([sender.key]).send();
  console.log("tx sent", {
    status: txSent.status,
    hash: txSent.hash,
    errors: txSent.errors,
  });
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
