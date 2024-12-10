import {
  Bool,
  DeployArgs,
  method,
  Permissions,
  PublicKey,
  SmartContract,
  State,
  state,
  VerificationKey,
  UInt64,
  Provable,
  Field,
  AccountUpdate,
  Mina,
} from "o1js";
import {
  UpgradeAuthorityBase,
  VerificationKeyUpgradeData,
  UpgradableContract,
  UpgradeAuthorityContractConstructor,
} from "@minatokens/upgradable-v1";
export { MyUpgradableContract, MyUpgradableContractDeployProps };

interface MyUpgradableContractDeployProps
  extends Exclude<DeployArgs, undefined> {
  admin: PublicKey;
  upgradeAuthority: PublicKey;
  uri: string;
}

function MyUpgradableContract(
  params: {
    upgradeContract?: UpgradeAuthorityContractConstructor;
  } = {}
) {
  const { upgradeContract } = params;

  class MyUpgradableSmartContract
    extends SmartContract
    implements UpgradableContract
  {
    @state(Field) value = State<Field>();
    /**
     * The public key of the contract's administrator.
     * This account has the authority to perform administrative actions such as pausing the contract or upgrading the verification key.
     */
    @state(PublicKey) admin = State<PublicKey>();

    /**
     * The public key of the upgrade authority contract.
     * This is the contract responsible for validating and authorizing upgrades to the verification key.
     */
    @state(PublicKey) upgradeAuthority = State<PublicKey>();

    @method async setValue(value: Field) {
      this.value.set(value);
    }

    /**
     * Deploys the contract with initial settings.
     * @param props - Deployment properties including admin, upgradeAuthority, uri
     */
    async deploy(props: MyUpgradableContractDeployProps) {
      await super.deploy(props);
      this.admin.set(props.admin);
      this.upgradeAuthority.set(props.upgradeAuthority);
      this.account.zkappUri.set(props.uri);
      this.account.permissions.set({
        ...Permissions.default(),
        // Allow the upgrade authority to set the verification key even without a protocol upgrade,
        // enabling upgrades in case of o1js breaking changes.
        setVerificationKey:
          Permissions.VerificationKey.proofDuringCurrentVersion(),
        setPermissions: Permissions.impossible(),
      });
    }
    events = {
      /** Emitted when the verification key is upgraded. */
      upgradeVerificationKey: Field,
    };

    /**
     * Retrieves the associated upgrade authority contract.
     * @returns An instance of `UpgradeAuthorityBase`.
     * @throws If the upgrade contract is not provided.
     */
    async getUpgradeContract(): Promise<UpgradeAuthorityBase> {
      if (!upgradeContract) {
        throw Error("Upgrade contract not provided");
      }
      return new upgradeContract(this.upgradeAuthority.getAndRequireEquals());
    }

    /**
     * Ensures that the transaction is authorized by the contract owner.
     * @returns A signed `AccountUpdate` from the admin.
     */
    async ensureOwnerSignature(): Promise<AccountUpdate> {
      const sender = this.sender.getUnconstrained();
      const admin = this.admin.getAndRequireEquals();
      admin.assertEquals(sender);
      const adminUpdate = AccountUpdate.createSigned(admin);
      adminUpdate.body.useFullCommitment = Bool(true); // Prevent memo and fee change
      return adminUpdate;
    }

    /**
     * Upgrades the contract's verification key after validating with the upgrade authority.
     * @param vk - The new verification key to upgrade to.
     */
    @method
    async upgradeVerificationKey(vk: VerificationKey) {
      await this.ensureOwnerSignature();
      const upgradeContract = await this.getUpgradeContract();
      // Fetch the previous verification key hash
      const previousVerificationKeyHash = Provable.witness(Field, () => {
        const account = Mina.getAccount(this.address);
        const vkHash = account.zkapp?.verificationKey?.hash;
        if (!vkHash) {
          throw Error("Verification key hash not found");
        }
        return vkHash;
      });
      // Create the upgrade data
      const data = new VerificationKeyUpgradeData({
        address: this.address,
        tokenId: this.tokenId,
        previousVerificationKeyHash,
        newVerificationKeyHash: vk.hash,
      });
      // Verify the upgrade data with the upgrade authority
      const upgradeAuthorityAnswer = await upgradeContract.verifyUpgradeData(
        data
      );
      upgradeAuthorityAnswer.isVerified.assertTrue(
        "Cannot upgrade verification key"
      );
      // Set the new verification key
      this.account.verificationKey.set(vk);
      // Update the upgrade authority if provided
      this.upgradeAuthority.set(
        upgradeAuthorityAnswer.nextUpgradeAuthority.orElse(
          this.upgradeAuthority.getAndRequireEquals()
        )
      );
      // Emit the upgrade event
      this.emitEvent("upgradeVerificationKey", vk.hash);
    }
  }
  return MyUpgradableSmartContract;
}
