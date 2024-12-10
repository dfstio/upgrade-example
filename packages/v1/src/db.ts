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
  Signature,
  Nullifier,
  verify,
} from "o1js";
import {
  VerificationKeyUpgradeAuthority,
  ValidatorsVoting,
  ValidatorsList,
  ValidatorsState,
  ValidatorsListData,
  ChainId,
  ValidatorsDecision,
  ValidatorsDecisionState,
  ValidatorDecisionType,
  VerificationKeyUpgradeData,
  ValidatorsListEvent,
  UpgradeAuthorityDatabase,
  UpgradeDatabaseState,
  PublicKeyOption,
  ValidatorsVotingProof,
  serializeIndexedMap,
  pinJSON,
  Storage,
} from "@minatokens/upgradable-v1";
import { checkValidatorsList } from "./check.js";
import fs from "fs/promises";
import o1jsPackage from "../node_modules/o1js/package.json" with { type: "json" };
const { TestPublicKey } = Mina;
type TestPublicKey = Mina.TestPublicKey;

async function deploy() {
  console.time("UpgradeAuthority database set");
  console.log("Setting UpgradeAuthority database...");
  const sender = TestPublicKey.fromBase58(process.env.PRIVATE_KEY!);

  const { validators: validatorsV1, upgradeAuthority: upgradeAuthorityV1keys } =
    JSON.parse(await fs.readFile("../../data/upgrade-v1.json", "utf-8"));
  const validators: TestPublicKey[] = validatorsV1.map((v: any) =>
    TestPublicKey.fromBase58(v.privateKey)
  );
  const { upgradeAuthority: upgradeAuthorityV2keys } = JSON.parse(
    await fs.readFile("../../data/upgrade-v2.json", "utf-8")
  );
  const upgradeAuthority = PublicKey.fromBase58(
    upgradeAuthorityV1keys.publicKey
  );
  const upgradeAuthorityV2 = PublicKey.fromBase58(
    upgradeAuthorityV2keys.publicKey
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
  console.log("UpgradeAuthorityV2", upgradeAuthorityV2.toBase58());

  const { verificationKey: verificationKeyV1, contract } = JSON.parse(
    await fs.readFile("../../data/contract.json", "utf-8")
  );
  const { verificationKey: verificationKeyV2 } = JSON.parse(
    await fs.readFile("../../data/vk-v2.json", "utf-8")
  );

  const cache = Cache.FileSystem("./cache");
  console.log("Compiling contracts");
  console.time("Compiled contracts");
  const validatorsVotingVk = (await ValidatorsVoting.compile({ cache }))
    .verificationKey;
  await VerificationKeyUpgradeAuthority.compile({ cache });
  console.timeEnd("Compiled contracts");

  console.time("Set UpgradeAuthority");
  await fetchAccount({ publicKey: sender });
  await fetchAccount({ publicKey: upgradeAuthority });
  const events = await upgradeAuthorityContract.fetchEvents();
  const lastEvent = events
    .filter((e) => e.type === "validatorsList")
    .reverse()[0];
  if (!lastEvent) {
    throw new Error("No validatorsList event found");
  }
  const eventData = lastEvent.event.data as unknown as ValidatorsListEvent;

  const storage = eventData.storage;
  console.log("storage", storage.toString());

  const { map, data } = await checkValidatorsList({
    storage,
  });
  const validatorState = new ValidatorsState({
    chainId: ChainId["mina:devnet"],
    root: map.root,
    count: UInt32.from(data.validatorsCount),
  });

  const contractKey = new VerificationKeyUpgradeData({
    address: PublicKey.fromBase58(contract.publicKey),
    tokenId: Field(1),
    previousVerificationKeyHash: Field.fromJSON(verificationKeyV1.hash),
    newVerificationKeyHash: Field.fromJSON(verificationKeyV2.hash),
  });

  const db = new UpgradeAuthorityDatabase();
  db.set(contractKey.hash(), contractKey.newVerificationKeyHash);
  const ipfs = await pinJSON({
    data: { map: serializeIndexedMap(db) },
    name: "upgrade-authority-database",
  });
  if (!ipfs) {
    throw new Error("UpgradeAuthority database IPFS hash is undefined");
  }

  const decision = new ValidatorsDecision({
    message: Field(6477782648),
    decisionType: ValidatorDecisionType["updateDatabase"],
    contractAddress: upgradeAuthority,
    chainId: ChainId["mina:devnet"],
    validators: validatorState,
    upgradeDatabase: new UpgradeDatabaseState({
      root: db.root,
      storage: Storage.fromString(ipfs),
      nextUpgradeAuthority: PublicKeyOption.from(upgradeAuthorityV2),
      version: UInt32.from(1),
      validFrom: UInt32.zero,
    }),
    updateValidatorsList: ValidatorsState.empty(),
    expiry: UInt32.MAXINT(),
  });
  let state = ValidatorsDecisionState.startVoting(decision);
  const proofs = [];

  console.log("voting...");
  console.time("voted");
  const voted = new ValidatorsList();
  const startProof = await ValidatorsVoting.startVoting(state, decision);
  proofs.push(startProof);
  for (let i = 0; i < validators.length; i++) {
    const signature = Signature.create(
      validators[i].key,
      ValidatorsDecision.toFields(decision)
    );
    const nullifier = Nullifier.fromJSON(
      decision.createJsonNullifier({
        network: "testnet",
        privateKey: validators[i].key,
      })
    );

    const step = await ValidatorsVoting.vote(
      state,
      decision,
      nullifier,
      map.clone(),
      voted.clone(),
      Bool(true),
      Bool(false),
      Bool(false),
      signature
    );
    voted.insert(nullifier.key(), Field(1));
    state = step.publicOutput;
    proofs.push(step);
  }
  let proof = proofs[0];
  console.timeEnd("voted");
  console.log("merging vote proofs...");
  console.time("merged vote proofs");
  for (let i = 1; i < proofs.length; i++) {
    const mergedProof = await ValidatorsVoting.merge(
      proofs[i - 1].publicInput,
      proofs[i - 1],
      proofs[i]
    );
    proof = mergedProof;
    const ok = await verify(mergedProof, validatorsVotingVk);
    if (!ok) {
      throw new Error("calculateValidatorsProof: Proof is not valid");
    }
  }
  const dynamicProof = ValidatorsVotingProof.fromProof(proof);
  console.timeEnd("merged vote proofs");

  await fetchAccount({ publicKey: sender });
  await fetchAccount({ publicKey: upgradeAuthority });

  const tx = await Mina.transaction(
    {
      sender,
      fee: 100_000_000,
      memo: `Set UpgradeAuthority`,
    },
    async () => {
      await upgradeAuthorityContract.updateDatabase(
        dynamicProof,
        validatorsVotingVk,
        validatorState
      );
    }
  );

  const txSent = await (await tx.prove()).sign([sender.key]).send();
  console.log("set upgrade authority db tx sent", {
    status: txSent.status,
    hash: txSent.hash,
    errors: txSent.errors,
  });
  console.timeEnd("UpgradeAuthority database set");
  if (txSent.status !== "pending") {
    console.log("tx status:", txSent.status);
    throw new Error("tx not pending");
  }
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
