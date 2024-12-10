import { Mina, Cache } from "o1js";
import { MyUpgradableContract } from "./contract.js";
import { VerificationKeyUpgradeAuthority } from "@minatokens/upgradable";
import fs from "fs/promises";

async function main() {
  console.log("Compiling contract V2");
  const MyContract = MyUpgradableContract({
    upgradeContract: VerificationKeyUpgradeAuthority,
  });
  const networkInstance = Mina.Network({
    mina: ["https://api.minascan.io/node/devnet/v1/graphql"],
    archive: ["https://api.minascan.io/archive/devnet/v1/graphql"],
    networkId: "testnet",
  });
  Mina.setActiveInstance(networkInstance);
  const cache = Cache.FileSystem("./cache");
  console.time("Compiled contract");
  const vk = (await MyContract.compile({ cache })).verificationKey;
  console.timeEnd("Compiled contract");
  await fs.writeFile(
    "../../data/vk-v2.json",
    JSON.stringify(
      {
        verificationKey: {
          hash: vk.hash.toJSON(),
          data: vk.data,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("Sending tx failed:", error);
  process.exit(1);
});
