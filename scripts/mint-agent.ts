import { ethers } from "ethers";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.ROUTER_PRIVATE_KEY!, provider);

  const identityRegistryAddr = process.env.IDENTITY_REGISTRY_ADDRESS!;
  
  const abi = [
    "function register() external returns (uint256)",
    "function ownerOf(uint256) external view returns (address)"
  ];
  const registry = new ethers.Contract(identityRegistryAddr, abi, wallet);

  console.log("Checking if we need to mint an agent on:", identityRegistryAddr);

  try {
    await registry.ownerOf(1);
    console.log("Agent 1 already exists!");
  } catch (e) {
    let nonce = await provider.getTransactionCount(wallet.address, "pending");
    
    // Check if Agent 0 exists to avoid double minting if the script was interrupted
    try {
      await registry.ownerOf(0);
      console.log("Agent 0 already exists, skipping...");
    } catch {
      console.log("Minting Agent 0...");
      const tx0 = await registry.register({ nonce: nonce++ });
      await tx0.wait();
    }
    
    console.log("Minting Agent 1...");
    const tx1 = await registry.register({ nonce: nonce++ });
    await tx1.wait();
    console.log("Agents successfully minted!");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
