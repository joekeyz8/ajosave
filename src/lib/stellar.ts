import {
  Horizon,
  Keypair,
  Asset,
  TransactionBuilder,
  Operation,
  BASE_FEE,
  Networks,
} from "@stellar/stellar-sdk";
import { serverConfig } from "@/server/config";
import { stellarBreaker, CircuitOpenError } from "@/lib/circuit-breaker";
import { enqueueEvent } from "@/lib/outbox";

const server = new Horizon.Server(serverConfig.stellar.horizonUrl);
// Child span per Horizon HTTP call (#479)
instrumentHttpClient(Horizon.AxiosClient, "stellar-horizon");
const USDC = new Asset(serverConfig.usdc.assetCode, serverConfig.usdc.issuer);
const networkPassphrase =
  serverConfig.stellar.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

/**
 * Send a USDC payment via Horizon, guarded by the Stellar circuit breaker.
 * When the circuit is OPEN the payment is queued in the outbox
 * (`stellar.payment.deferred`) for replay instead of being dropped, and the
 * CircuitOpenError is re-thrown so callers know it did not settle yet.
 */
export async function sendUsdcPayment(destination: string, amount: string): Promise<string> {
  try {
    return await submitUsdcPayment(destination, amount);
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      await enqueueEvent("stellar", destination, "stellar.payment.deferred", { destination, amount });
    }
    throw err;
  }
}

/** Submit a USDC payment through the breaker without outbox deferral (used for replay). */
export async function submitUsdcPayment(destination: string, amount: string): Promise<string> {
  return stellarBreaker.execute(async () => {
    const keypair = Keypair.fromSecret(serverConfig.stellar.serverSecretKey);
    const account = await server.loadAccount(keypair.publicKey());

    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
      .addOperation(Operation.payment({ destination, asset: USDC, amount }))
      .setTimeout(30)
      .build();

    tx.sign(keypair);
    const result = await server.submitTransaction(tx);
    return result.hash;
  });
}

export async function getUsdcBalance(publicKey: string): Promise<string> {
  try {
    const account = await stellarBreaker.execute(() => server.loadAccount(publicKey));
    const bal = account.balances.find(
      (b) =>
        b.asset_type !== "native" &&
        (b as { asset_code: string }).asset_code === serverConfig.usdc.assetCode
    );
    return bal?.balance ?? "0";
  } catch {
    return "0";
  }
}

export { server as horizonServer, USDC, networkPassphrase };
