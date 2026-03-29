import hre from "hardhat";
import { ethers } from "ethers";

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const deployer = new ethers.Wallet(process.env.BASE_SEPOLIA_PRIVATE_KEY!, provider);

  console.log("Deploying contracts with the account:", deployer.address);
  
  // Track nonce manually to completely bypass RPC node sync lag!
  let nonce = await provider.getTransactionCount(deployer.address, "pending");

  async function deployContract(name: string, args: any[] = []) {
    const artifact = await hre.artifacts.readArtifact(name);
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
    // Use explicit nonce
    const contract = await factory.deploy(...args, { nonce: nonce++ });
    await contract.waitForDeployment();
    console.log(`Waiting 5 seconds for ${name} bytecode to propagate...`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    return { contract, address: await contract.getAddress(), interface: new ethers.Interface(artifact.abi) };
  }

  // Deploy HardhatMinimalUUPS implementation to initialize ownership
  const minImpl = await deployContract("HardhatMinimalUUPS");
  console.log("HardhatMinimalUUPS Implementation:", minImpl.address);

  async function deployAndUpgrade(name: string, initArg: string, initUpgradeArgs: any[]) {
    // 1. Deploy Proxy pointing to HardhatMinimalUUPS
    const proxyInitData = minImpl.interface.encodeFunctionData("initialize", [initArg]);
    const proxy = await deployContract("ERC1967Proxy", [minImpl.address, proxyInitData]);
    
    // 2. Wrap proxy with MinimalUUPS interface to call upgradeToAndCall
    const proxyAsMinimal = new ethers.Contract(proxy.address, minImpl.interface, deployer);

    // 3. Deploy actual implementation
    const finalImpl = await deployContract(name);
    
    // 4. Upgrade Proxy to actual implementation
    const upgradeInitData = finalImpl.interface.encodeFunctionData("initialize", initUpgradeArgs);
    const tx = await proxyAsMinimal.upgradeToAndCall(finalImpl.address, upgradeInitData, { nonce: nonce++ });
    await tx.wait();
    console.log(`Upgraded Proxy ${proxy.address} to ${name}`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    return proxy.address;
  }

  const idProxyAddr = await deployAndUpgrade("IdentityRegistryUpgradeable", ethers.ZeroAddress, []);
  const repProxyAddr = await deployAndUpgrade("ReputationRegistryUpgradeable", idProxyAddr, [idProxyAddr]);
  const valProxyAddr = await deployAndUpgrade("ValidationRegistryUpgradeable", idProxyAddr, [idProxyAddr]);

  console.log("");
  console.log("==========================================");
  console.log("ValidationRegistry Address to put in .env:");
  console.log(valProxyAddr);
  console.log("==========================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
