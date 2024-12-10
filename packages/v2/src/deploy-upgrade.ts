import {
  Mina,
  fetchAccount,
  Cache,
  AccountUpdate,
  Field,
  Bool,
  Poseidon,
  PublicKey,
  UInt32,
} from "o1js";
import {
  VerificationKeyUpgradeAuthority,
  ValidatorsVoting,
  ValidatorsList,
  ValidatorsState,
  ValidatorsListData,
  ChainId,

} from "@minatokens/upgradable";
import { serializeIndexedMap,   pinJSON,
  Storage, } from "@minatokens/storage";
import fs from "fs/promises";
import o1jsPackage from "../node_modules/o1js/package.json" with { type: "json" };
const { TestPublicKey } = Mina;
type TestPublicKey = Mina.TestPublicKey;

async function deploy() {
  console.time("deployed UpgradeAuthority");
  console.log("Deploying UpgradeAuthority V2...");
  const sender = TestPublicKey.fromBase58(process.env.PRIVATE_KEY!);
  const upgradeAuthority = TestPublicKey.random();
  const { validators: validatorsV1 } = JSON.parse(
    await fs.readFile("../../data/upgrade-v1.json", "utf-8")
  );
  const validators: TestPublicKey[] = validatorsV1.map((v: any) =>
    TestPublicKey.fromBase58(v.privateKey)
  );
  const upgradeAuthorityContract = new VerificationKeyUpgradeAuthority(
    upgradeAuthority
  );
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
  console.log("UpgradeAuthority", upgradeAuthority.toBase58());

  const cache = Cache.FileSystem("./cache");
  console.log("Compiling contracts");
  console.time("Compiled contracts");
  const validatorsVotingVk = (await ValidatorsVoting.compile({ cache }))
    .verificationKey;
  await VerificationKeyUpgradeAuthority.compile({ cache });
  console.timeEnd("Compiled contracts");

  const validatorsList = new ValidatorsList();
  const validatorsCount = 2; // majority is 2 validators out of 3
  const list: { key: TestPublicKey; authorizedToVote: boolean }[] = [
    { key: validators[0], authorizedToVote: true },
    { key: TestPublicKey.random(), authorizedToVote: false },
    { key: validators[1], authorizedToVote: true },
    { key: validators[2], authorizedToVote: true },
    { key: TestPublicKey.random(), authorizedToVote: false },
  ];

  for (let i = 0; i < list.length; i++) {
    const key = Poseidon.hashPacked(PublicKey, list[i].key);
    validatorsList.set(key, Field(Bool(list[i].authorizedToVote).value));
  }

  const data: ValidatorsListData = {
    validators: list.map((v) => ({
      publicKey: v.key.toBase58(),
      authorizedToVote: v.authorizedToVote,
    })),
    validatorsCount,
    root: validatorsList.root.toJSON(),
    map: serializeIndexedMap(validatorsList),
  };

  const ipfs = await pinJSON({
    data,
    name: "upgrade-example-v2",
  });
  if (!ipfs) {
    throw new Error("ValidatorsList IPFS hash is undefined");
  }

  const validatorState = new ValidatorsState({
    chainId: ChainId["mina:devnet"],
    root: validatorsList.root,
    count: UInt32.from(validatorsCount),
  });

  await fetchAccount({ publicKey: sender });
  const nonce = Number(Mina.getAccount(sender).nonce.toBigint());
  const tx = await Mina.transaction(
    {
      sender,
      fee: 100_000_000,
      memo: `Deploy UpgradeAuthority V2`,
      nonce,
    },
    async () => {
      AccountUpdate.fundNewAccount(sender, 1);
      // deploy() and initialize() create 2 account updates for the same publicKey, it is intended
      await upgradeAuthorityContract.deploy();
      await upgradeAuthorityContract.initialize(
        validatorState,
        Storage.fromString(ipfs),
        validatorsVotingVk.hash
      );
    }
  );
  const txSent = await (await tx.prove())
    .sign([sender.key, upgradeAuthority.key])
    .send();
  console.log("deploy tx sent", {
    status: txSent.status,
    hash: txSent.hash,
    errors: txSent.errors,
  });
  await fs.writeFile(
    "../../data/upgrade-v2.json",
    JSON.stringify(
      {
        o1js: o1jsPackage.version,
        upgradeAuthority: {
          publicKey: upgradeAuthority.toBase58(),
          privateKey: upgradeAuthority.key.toBase58(),
        },
        validators: validators.map((v) => ({
          publicKey: v.toBase58(),
          privateKey: v.key.toBase58(),
        })),
        tx: {
          hash: txSent.hash,
          status: txSent.status,
          errors: txSent.errors,
        },
        ipfs,
        nonce,
      },
      null,
      2
    )
  );
  console.timeEnd("deployed UpgradeAuthority");
  if (txSent.status !== "pending") {
    console.log("tx status:", txSent.status);
    throw new Error("tx not pending");
  }
}

deploy().catch((error) => {
  console.error("Deployment failed:", error);
  process.exit(1);
});
