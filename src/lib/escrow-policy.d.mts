export interface EscrowDeployment {
  network:
    | "base-sepolia"
    | "base-mainnet"
    | "solana-devnet"
    | "solana-testnet"
    | "solana-mainnet";
  vault: string;
  programId: string | null;
  upgradeAuthority: string | null;
  projectPda: string | null;
  networkDomain: string | null;
  asset: string;
  owner: string;
  identityAuthority: string;
  feeRecipient: string;
  deploymentTransaction: string;
  sourceCommit: string;
  codeSha256: string;
  bindingDelaySeconds: string;
  /** Solana only; null on Base, where the factory fixes 7 days. */
  rotationDelaySeconds: string | null;
  /** Base only; null on Solana. The EscrowFactory that created the vault and rotates its identity authority. */
  factory: string | null;
  /** Base only; null on Solana. sha256 of the factory runtime code. */
  factoryCodeSha256: string | null;
  /** Base only; null on Solana. The factory registrar, which alone proposes an authority rotation. */
  registrar: string | null;
}
export type EscrowChain = "base" | "solana";
export type EscrowFamily = "evm" | "solana";
export interface EscrowPolicy {
  schemaVersion: "1";
  effectiveCycle: string;
  chain: EscrowChain;
  feeBasisPoints: 200;
  withdrawalFeeBasisPoints: 1000;
  feeMode: "deduct-from-gross";
  deployments: EscrowDeployment[];
}
export declare const MIN_PRODUCTION_BINDING_DELAY: number;
export declare const MIN_PRODUCTION_ROTATION_DELAY: number;
export interface EscrowNetwork {
  chain: EscrowChain;
  family: EscrowFamily;
  testnet: boolean;
  chainId?: string;
  asset: string | null;
  assetSymbol: string;
  /** EVM only: executor gas ceiling in gas units, decimal string. */
  gasCeiling?: string;
  /** EVM only: blocks per eth_getLogs page, inclusive, decimal string. */
  scanPageBlocks?: string;
}
export declare const ESCROW_NETWORKS: Readonly<
  Record<EscrowDeployment["network"], EscrowNetwork>
>;
export declare const ESCROW_CHAINS: readonly EscrowChain[];
export declare const EVM_CHAINS: readonly EscrowChain[];
export declare function isEscrowChain(value: unknown): value is EscrowChain;
export declare function chainFamily(chain: string): EscrowFamily;
export declare function assertEscrowPolicy(value: unknown): EscrowPolicy;
export declare function assertEscrowTransition(
  previous: EscrowPolicy | undefined,
  next: EscrowPolicy | undefined,
): void;
